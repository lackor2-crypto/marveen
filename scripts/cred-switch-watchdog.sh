#!/bin/bash
# Credential-switch limit-recovery watchdog (token-free, LOCAL / update-safe).
#
# Boss scenario: Claude usage-limit runs out -> Marvin wedges "pending".
# Boss logs into ANOTHER Claude account (fresh quota). That rewrites the
# credentials file with a BRAND-NEW OAuth grant. THIS watchdog notices the
# grant change and restarts the channels service so Marvin picks up the fresh
# account. Reboot never needed.
#
# 2026-08-04 FIX (A+B), after a real incident: the old version only restarted
# if it ALSO grep-matched a "limit reached" string in the logs/channels pane.
# That gate was the single point of failure -- Boss re-logged twice (00:47,
# 00:57), the watchdog saw both grant changes, but the limit text was worded
# differently / lived in another pane, so it logged "NO limit signal -> no
# restart" both times and Boss had to reboot the whole machine. Two changes:
#
#   A) Detection is broadened AND is no longer a veto: it captures ALL fleet
#      panes (channels + worker + worker-fast) with a wider phrase list, but
#      only to ENRICH the log line ("why"). It can no longer block a restart.
#   B) The trigger is now a genuine GRANT change, keyed on the OAuth
#      refreshToken (not the whole file). A routine accessToken auto-refresh
#      keeps the same refreshToken -> hash unchanged -> quiet, no restart. A
#      real re-login (Boss switching accounts) issues a NEW refreshToken ->
#      hash changes -> restart. A COOLDOWN bounds restarts so an occasional
#      refresh-token rotation can never cause a restart storm, and Boss's two
#      rapid re-logins collapse into a single restart.
#
# Trade-off accepted on purpose: if Anthropic ever rotates the refreshToken on
# an ordinary refresh, we restart once per cooldown window with no limit block.
# That is a cheap, bounded cost; SILENTLY missing a real limit block (the bug
# we are fixing) is the expensive one.
#
# 2026-08-07 ADDITION: the grant-change trigger above only fires if Boss
# actually re-logs in. Real incident: limit hit at 08:35, channels.sh's own
# crash-restart came back up still inside the blocked window, and THAT
# process never noticed the window pass at 09:00 -- it just sat there
# "wedged", because Claude Code does not silently retry a blocked turn on its
# own once the clock passes; only a fresh process re-checks. Boss had to
# re-login at 09:08 just to force a restart, and only the restart (not the
# login itself) fixed it. Section (C) below closes that gap: it parses the
# "resets HH:MMam/pm" clock out of the pane text and restarts on its own once
# that time passes, so a fresh process is waiting the moment the window
# clears -- no relogin required.
#
# Lives in store/ (gitignored) so a followed-code update never overwrites it.
# Zero Claude tokens (plain bash + python3 stdlib, no network).
#
# DRY_RUN=1 -> log the decision but do NOT restart (for safe testing).
set -u
INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STORE="$INSTALL_DIR/store"
STATE="$STORE/.cred-switch-refresh-hash"   # last-acted OAuth-grant fingerprint
LAST_RESTART="$STORE/.cred-switch-last-restart"  # epoch of last issued restart
LOG="$STORE/cred-switch-watchdog.log"
CRED="$HOME/.claude/.credentials.json"
COOLDOWN="${CRED_SWITCH_COOLDOWN:-600}"     # min seconds between restarts

log(){ echo "$(date '+%F %T') $*" >> "$LOG"; }

# --- Ha EMBER kell hozza, azt EMBERNEK kell megmondani.
#
# Boss, 2026-08-20: 10:54:06-kor kiurult a bejelentkezes, 10:55:20-tol ez a
# watchdog MAR TUDTA, hogy csak egy kezi /login segit -- es beleirta a sajat
# naplojaba. Boss 11:01-kor maga vette eszre, hogy a Marvin nem valaszol. Egy
# naplobejegyzes nem ertesites: pont az az agens nem tudja felolvasni, amelyik
# kiesett. Ezert megy kozvetlenul a Bot API-n (scripts/notify.sh), Claude
# nelkul -- ez az egyetlen ut, ami akkor is el, amikor a flotta halott.
#
# Csendhatar: fajl-alapu, hogy percenkent futva se legyen belole aradat.
NOTIFY_STATE="$STORE/.cred-switch-notified"
NOTIFY_MIN_INTERVAL="${CRED_SWITCH_NOTIFY_INTERVAL:-21600}"   # 6 ora
notify_owner(){
  # $1 = kulcs (mirol szol), $2 = uzenet
  local key="$1" msg="$2" line prev_key=0 prev_at=0 now
  now="$(date +%s)"
  if [ -f "$NOTIFY_STATE" ]; then
    line="$(cat "$NOTIFY_STATE" 2>/dev/null)"
    prev_key="${line%%:*}"; prev_at="${line##*:}"
    prev_at="$(printf '%s' "$prev_at" | tr -dc '0-9')"; prev_at="${prev_at:-0}"
  fi
  if [ "$prev_key" = "$key" ] && [ $(( now - prev_at )) -lt "$NOTIFY_MIN_INTERVAL" ]; then
    return 0
  fi
  if [ "${DRY_RUN:-0}" = "1" ]; then
    log "DRY_RUN: would notify owner ($key): ${msg:0:80}"
    return 0
  fi
  if bash "$INSTALL_DIR/scripts/notify.sh" "$msg" >/dev/null 2>&1; then
    echo "$key:$now" > "$NOTIFY_STATE"
    log "OWNER NOTIFIED ($key)"
  else
    # Nem nemitjuk el: ha a kuldes nem sikerult, a kovetkezo korben ujra
    # probaljuk -- ez a mentoov, nem szabad egy sikertelen curl-lel elveszni.
    log "OWNER NOTIFY FAILED ($key) -- will retry next run"
  fi
}
# --- Ebreszto inditasa egy sikeres ujraindulas utan.
# Kulon, FUGGETLEN tranziens unitban fut (systemd-run), mert ez a service
# Type=oneshot + KillMode=control-group: barmi, amit itt hatterbe tennenk,
# meghalna abban a pillanatban, ahogy a szkript kilep.
nudge(){
  systemd-run --user --collect --quiet \
    --unit="${MAIN_AGENT_ID}-nudge-$(date +%s)" \
    /bin/bash "$INSTALL_DIR/scripts/marveen-nudge.sh" "$1" 2>>"$LOG" \
    && log "ebreszto utemezve ($1)" || log "az ebresztot nem sikerult elinditani ($1)"
}

env_val(){ grep -E "^$1=" "$INSTALL_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d "\"' "; }

MAIN_AGENT_ID="$(env_val MAIN_AGENT_ID)"; MAIN_AGENT_ID="${MAIN_AGENT_ID:-marveen}"
MAIN_AGENT_ID="${MAIN_AGENT_ID//[^a-zA-Z0-9_-]/}"
SERVICE_ID="$(env_val SERVICE_ID)"; SERVICE_ID="${SERVICE_ID//[^a-zA-Z0-9_-]/}"; SERVICE_ID="${SERVICE_ID:-$MAIN_AGENT_ID}"
SERVICE="${SERVICE_ID}-channels.service"
# Every fleet pane the limit text might land in (channels answers Telegram,
# workers run the sub-agents). Missing panes are ignored silently.
PANES=("${MAIN_AGENT_ID}-channels" "${MAIN_AGENT_ID}-worker" "${MAIN_AGENT_ID}-worker-fast")

[ -f "$CRED" ] || exit 0

# --- (C) Autonomous limit-reset recovery -- runs every tick regardless of
# whether the OAuth grant changed, so it works even if Boss never re-logs in.
# Dedupe key is the parsed reset EPOCH, not a text hash: the same "resets
# 9:20am" line lingers in the log tail / stale pane scrollback long after we
# act on it, and re-parsing it must not restart a second time. A genuinely
# new limit event carries a different clock time -> different epoch -> acts
# once more.
LIMIT_STATE="$STORE/.cred-switch-limit-reset-handled"
LIMIT_TEXT="$(
  { tail -n 200 "$STORE/channels.log" "$STORE/channels.error.log" "$STORE/dashboard.log" 2>/dev/null
    for p in "${PANES[@]}"; do tmux capture-pane -t "$p" -p 2>/dev/null; done
  } | grep -aiE "resets? (at |in )?[0-9]{1,2}(:[0-9]{2})? ?[ap]m" \
    | grep -aviE "cred-switch|limit-monitor" | tail -1
)"
if [ -n "$LIMIT_TEXT" ]; then
  RESET_EPOCH="$(python3 - "$LIMIT_TEXT" <<'PY' 2>/dev/null
import re, sys, datetime
m = re.search(r'resets?\s*(?:at\s*|in\s*)?(\d{1,2})(?::(\d{2}))?\s*([ap]m)', sys.argv[1], re.I)
if not m:
    sys.exit(0)
h = int(m.group(1)) % 12
if m.group(3).lower() == "pm":
    h += 12
mi = int(m.group(2) or 0)
now = datetime.datetime.now()
reset = now.replace(hour=h, minute=mi, second=0, microsecond=0)
# The message always names the NEXT occurrence of that clock time. If the
# naive same-day reading is already more than 12h in the past, it must mean
# tomorrow (message seen late at night for an early-morning reset).
if (now - reset).total_seconds() > 12 * 3600:
    reset += datetime.timedelta(days=1)
print(int(reset.timestamp()))
PY
)"
  if [ -n "$RESET_EPOCH" ]; then
    now_epoch="$(date +%s)"
    HANDLED="$(cat "$LIMIT_STATE" 2>/dev/null | tr -dc '0-9')"; HANDLED="${HANDLED:-0}"
    if [ "$now_epoch" -ge "$RESET_EPOCH" ] && [ "$RESET_EPOCH" != "$HANDLED" ]; then
      last="$(cat "$LAST_RESTART" 2>/dev/null | tr -dc '0-9')"; last="${last:-0}"
      if [ $(( now_epoch - last )) -ge "$COOLDOWN" ]; then
        echo "$RESET_EPOCH" > "$LIMIT_STATE"
        log "limit window passed (reset was $(date -d "@$RESET_EPOCH" '+%H:%M'), signal: ${LIMIT_TEXT:0:100}) -> restarting $SERVICE, no relogin needed"
        if [ "${DRY_RUN:-0}" = "1" ]; then
          log "DRY_RUN: would restart $SERVICE for limit-reset recovery"
        elif systemctl --user restart "$SERVICE" 2>>"$LOG"; then
          echo "$now_epoch" > "$LAST_RESTART"
          log "restart issued OK (limit-reset recovery)"
          nudge "lejart a korlat"
        else
          log "restart FAILED (limit-reset recovery)"
        fi
      else
        log "limit window passed (reset was $(date -d "@$RESET_EPOCH" '+%H:%M')) but within ${COOLDOWN}s cooldown of last restart -> skip"
      fi
    fi
  fi
fi

# --- (D) AUTH-WEDGE recovery. Added 2026-08-08 after a real incident.
#
# Incident: .env carried a CLAUDE_CODE_OAUTH_TOKEN that was not a Claude token
# at all (92 chars, no sk-ant-oat01- prefix). Claude Code gives that env var
# ABSOLUTE priority over ~/.claude/.credentials.json, so every login Boss
# performed landed correctly in the credentials file and was then ignored;
# every API call 401'd. Marvin sat at
#     "Please run /login - API Error: 401 Invalid bearer token"
# for hours and NOTHING noticed:
#   (B) only fires on a grant CHANGE -- and re-logins did change the grant, so
#       it restarted happily, but every restarted process re-read the same dead
#       env token. Restart != recovery when the auth source never moves.
#   (C) only fires on a limit-reset clock, which was not the state.
#   the dashboard reauth-healer scans only the LIVE STATUS REGION around the
#       input box; this error renders in the TRANSCRIPT, tens of blank lines
#       above the box, so detectReauthNeeded() returns false. Verified
#       empirically against the captured pane, 2026-08-08.
#
# This section scans the WHOLE pane for Claude Code's own auth-error rendering
# and heals -- but only when a restart can actually help. A genuinely
# logged-out account must NOT be restart-looped; it needs a human /login.
AUTH_STATE="$STORE/.cred-switch-auth-wedge"        # last acted-on marker fingerprint
AUTH_BUDGET="$STORE/.cred-switch-auth-budget"      # window_start:count -- anti-loop cap
AUTH_MAX_PER_HOUR="${CRED_SWITCH_AUTH_MAX_PER_HOUR:-3}"

# Claude Code's own auth-failure rendering. Anchored on the error bullet or on
# phrases the CLI alone emits, so Marvin merely *discussing* a 401 in chat (or
# an alert forwarded back into the pane) does not trip a restart.
AUTH_PANE="$(tmux capture-pane -t "${MAIN_AGENT_ID}-channels" -p 2>/dev/null | tail -n 60)"
AUTH_HIT="$(printf '%s\n' "$AUTH_PANE" \
  | grep -aE '^[[:space:]]*([●⎿✗][[:space:]]*)?((Please run[[:space:]]+/login)|(API Error:[[:space:]]*401)|(Invalid bearer token)|(Invalid authentication credentials)|(OAuth token( has)? expired)|(Not logged in))' \
  | grep -aviE 'cred-switch|reauth-healer|jelez \(|watchdog' | tail -1)"

if [ -n "$AUTH_HIT" ]; then
  AUTH_FP="$(printf '%s' "$AUTH_HIT" | md5sum | awk '{print $1}')"
  AUTH_PREV="$(cat "$AUTH_STATE" 2>/dev/null)"
  now_a="$(date +%s)"

  # Decide whether a restart can plausibly fix this, BEFORE spending one.
  #   env-bad   : .env pins a malformed token -> a restart re-reads it. Useless.
  #   pin-stale : no configured token anywhere, yet the SHARED tmux server still
  #               carries one from an older config. KillMode=process keeps that
  #               server alive across restarts, so only an explicit -u clears it.
  #   creds-ok  : the on-disk grant is valid -> a fresh process will pick it up.
  #   creds-dead: nothing usable -> a human must /login. Never loop on this.
  ENV_TOKEN="$(grep -E '^CLAUDE_CODE_OAUTH_TOKEN=.+' "$INSTALL_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d "\"' ")"
  FLEET_TOKEN=""; [ -s "$INSTALL_DIR/store/.claude-oauth-token" ] && FLEET_TOKEN="$(cat "$INSTALL_DIR/store/.claude-oauth-token")"
  TMUX_PIN="$(tmux show-environment -g CLAUDE_CODE_OAUTH_TOKEN 2>/dev/null | grep -c '^CLAUDE_CODE_OAUTH_TOKEN=' || true)"
  CREDS_OK="$(python3 - "$CRED" <<'PY' 2>/dev/null
import json, sys, time
try:
    o = json.load(open(sys.argv[1]))["claudeAiOauth"]
    ok = isinstance(o.get("refreshToken"), str) and o["refreshToken"].startswith("sk-ant-ort01-")
    print("yes" if ok else "no")
except Exception:
    print("no")
PY
)"

  VERDICT="creds-dead"
  if [ -n "$ENV_TOKEN" ] && [ "${ENV_TOKEN#sk-ant-oat01-}" = "$ENV_TOKEN" ]; then
    VERDICT="env-bad"
  elif [ -z "$ENV_TOKEN" ] && [ -z "$FLEET_TOKEN" ] && [ "$TMUX_PIN" != "0" ]; then
    VERDICT="pin-stale"
  elif [ "$CREDS_OK" = "yes" ]; then
    VERDICT="creds-ok"
  fi

  if [ "$VERDICT" = "env-bad" ]; then
    # Restarting cannot help and .env is Boss's config -- never edit it from a
    # watchdog. Say it once per distinct marker, loudly, and stop.
    if [ "$AUTH_FP" != "$AUTH_PREV" ]; then
      echo "$AUTH_FP" > "$AUTH_STATE"
      log "AUTH WEDGE + BAD .env TOKEN: CLAUDE_CODE_OAUTH_TOKEN is set but is not an sk-ant-oat01- token, so Claude Code 401s and IGNORES ~/.claude/.credentials.json. No restart can fix this -- remove/comment that line in .env. Pane: ${AUTH_HIT:0:110}"
    fi
    # SZANDEKOSAN a fingerprint-kapun KIVUL: a naplo "mar leirtam egyszer"
    # allapota nem dontheti el, hogy Boss ertesult-e. A notify_owner sajat
    # 6 oras csendhatara adja a ritmust.
    notify_owner "env-bad" "🔴 A fo agens nem tud dolgozni.

A .env fajlban a CLAUDE_CODE_OAUTH_TOKEN sor rossz erteket tartalmaz, ezert a Claude Code minden kerest visszautasit, es a rendes bejelentkezest is figyelmen kivul hagyja.

Ujrainditas ezen nem segit. Szolj, es kiveszem azt a sort."
  elif [ "$VERDICT" = "creds-dead" ]; then
    if [ "$AUTH_FP" != "$AUTH_PREV" ]; then
      echo "$AUTH_FP" > "$AUTH_STATE"
      log "AUTH WEDGE, but no usable credential on disk -> a restart would not help; human /login required. Pane: ${AUTH_HIT:0:110}"
    fi
    # Ugyanaz: a kimaradas amig tart, 6 oranket emlekeztet. 2026-08-20-an
    # ez a branch tudta 10:55:20 ota, hogy ember kell hozza, es csak a
    # naplojaba irta -- Boss 11:01-kor maga vette eszre.
    notify_owner "creds-dead" "🔴 Kijelentkezett a Claude -- a FO agens megallt.

(A sajat fiokos es a nem-Claude agensek ettol fuggetlenul dolgoznak tovabb. Ami all: a fo agens, vagyis a Telegram-valasz es az utemezett feladatok.)

Ujrainditas nem segit. Ket ut van:

A) A felulten, terminal nelkul: Beallitasok -> Varazslo -> Claude bejelentkezes -> \"Bejelentkeztetes inditasa\". Vegigvezet, es a vegen magatol ujraindit.

B) Vagy kezzel: Ubuntu ablak -> claude -> /login"
  elif [ "$AUTH_FP" != "$AUTH_PREV" ]; then
    # Anti-loop budget: a wedge that survives repeated restarts must go quiet
    # and wait for a human rather than restart Marvin forever.
    bstart=0; bcount=0
    if [ -f "$AUTH_BUDGET" ]; then
      bstart="$(cut -d: -f1 "$AUTH_BUDGET" 2>/dev/null | tr -dc '0-9')"; bstart="${bstart:-0}"
      bcount="$(cut -d: -f2 "$AUTH_BUDGET" 2>/dev/null | tr -dc '0-9')"; bcount="${bcount:-0}"
    fi
    [ $(( now_a - bstart )) -ge 3600 ] && { bstart="$now_a"; bcount=0; }

    lastr="$(cat "$LAST_RESTART" 2>/dev/null | tr -dc '0-9')"; lastr="${lastr:-0}"
    if [ "$bcount" -ge "$AUTH_MAX_PER_HOUR" ]; then
      log "AUTH WEDGE ($VERDICT) but ${AUTH_MAX_PER_HOUR} auth-restarts already spent this hour -> standing down, human needed. Pane: ${AUTH_HIT:0:100}"
      notify_owner "budget-spent" "🟠 A fo agens Claude-bejelentkezesevel valami nem stimmel.

${AUTH_MAX_PER_HOUR} ujrainditassal probaltam ebben az oraban, es egyik sem oldotta meg, ezert leallok -- kulonben a vegtelensegig ujraindulna.

Ha nem valaszolok, ezt erdemes megprobalni: Beallitasok -> Varazslo -> Claude bejelentkezes, vagy Ubuntu ablak -> claude -> /login."
      echo "$AUTH_FP" > "$AUTH_STATE"
    elif [ $(( now_a - lastr )) -lt "$COOLDOWN" ]; then
      log "AUTH WEDGE ($VERDICT) but within ${COOLDOWN}s cooldown of last restart -> waiting"
    else
      echo "$AUTH_FP" > "$AUTH_STATE"
      echo "$bstart:$(( bcount + 1 ))" > "$AUTH_BUDGET"
      if [ "$VERDICT" = "pin-stale" ]; then
        tmux set-environment -g -u CLAUDE_CODE_OAUTH_TOKEN 2>/dev/null || true
        log "AUTH WEDGE: stale CLAUDE_CODE_OAUTH_TOKEN found on the shared tmux server with none configured -> cleared it (the tmux server survives service restarts, so nothing else would)"
      fi
      log "AUTH WEDGE ($VERDICT) -> restarting $SERVICE. Pane: ${AUTH_HIT:0:110}"
      if [ "${DRY_RUN:-0}" = "1" ]; then
        log "DRY_RUN: would restart $SERVICE for auth-wedge recovery"
      elif systemctl --user restart "$SERVICE" 2>>"$LOG"; then
        echo "$now_a" > "$LAST_RESTART"
        log "restart issued OK (auth-wedge recovery)"
        nudge "helyreallt a hitelesites"
      else
        log "restart FAILED (auth-wedge recovery)"
      fi
    fi
  fi
fi

# --- (B) genuine-grant fingerprint: hash the refreshToken, not the whole file.
# A pure accessToken refresh leaves refreshToken untouched -> same fingerprint
# -> the common quiet path. Falls back to whole-file md5 if extraction fails,
# so a schema change degrades to the old behaviour instead of crashing.
CUR_HASH="$(python3 - "$CRED" <<'PY' 2>/dev/null
import json, sys, hashlib
def find(o):
    if isinstance(o, dict):
        for k, v in o.items():
            if k == "refreshToken" and isinstance(v, str) and v:
                return v
            r = find(v)
            if r:
                return r
    elif isinstance(o, list):
        for v in o:
            r = find(v)
            if r:
                return r
    return None
try:
    t = find(json.load(open(sys.argv[1])))
except Exception:
    t = None
print(hashlib.md5(t.encode()).hexdigest() if t else "")
PY
)"
if [ -z "$CUR_HASH" ]; then
  CUR_HASH="ff-$(md5sum "$CRED" 2>/dev/null | awk '{print $1}')"   # fallback marker
  log "WARN: could not read refreshToken -> falling back to whole-file hash"
fi

PREV_HASH="$(cat "$STATE" 2>/dev/null)"

# First run (or first run after this rewrite): record the baseline, never restart.
if [ -z "$PREV_HASH" ]; then echo "$CUR_HASH" > "$STATE"; log "init: baseline grant hash $CUR_HASH"; exit 0; fi

# Same OAuth grant -> nothing to do (common, quiet path: covers idle AND routine
# accessToken auto-refresh).
[ "$CUR_HASH" = "$PREV_HASH" ] && exit 0

# --- Grant changed: this is a real re-login / account switch. Record the new
# fingerprint up front so we act at most once per change no matter what follows.
echo "$CUR_HASH" > "$STATE"

# Cooldown guard: collapse rapid re-logins and cap any rotation-driven restarts.
now="$(date +%s)"; last="$(cat "$LAST_RESTART" 2>/dev/null | tr -dc '0-9')"; last="${last:-0}"
if [ $(( now - last )) -lt "$COOLDOWN" ]; then
  log "grant change ($PREV_HASH -> $CUR_HASH) but within ${COOLDOWN}s cooldown of last restart -> skip"
  exit 0
fi

# --- (A) Enrich the log with WHY (limit text), but this NEVER gates the restart.
SIGNAL="$(
  { tail -n 200 "$STORE/channels.log" "$STORE/channels.error.log" "$STORE/dashboard.log" 2>/dev/null
    for p in "${PANES[@]}"; do tmux capture-pane -t "$p" -p 2>/dev/null; done
  } | grep -aiE "usage limit|limit reached|reached your (usage|plan|weekly|opus) limit|limit will reset|resets (at|in)|[0-9]+-hour limit|weekly limit|approaching .*limit|rate.?limit|429|too many requests|quota exceeded|out of (usage|credits)|upgrade to increase|/upgrade" \
    | grep -aviE "cred-switch|limit-monitor|within limit|no rate" | tail -1 )"
[ -n "$SIGNAL" ] && WHY="limit block seen: ${SIGNAL:0:120}" || WHY="no explicit limit text (acting on grant change alone)"

if [ "${DRY_RUN:-0}" = "1" ]; then
  log "DRY_RUN: would restart $SERVICE (grant $PREV_HASH -> $CUR_HASH; $WHY)"
  exit 0
fi

log "grant change ($PREV_HASH -> $CUR_HASH) -> restarting $SERVICE; $WHY"
if systemctl --user restart "$SERVICE" 2>>"$LOG"; then
  echo "$now" > "$LAST_RESTART"
  log "restart issued OK"
  nudge "fiokvaltas"
else
  log "restart FAILED"
fi
exit 0
