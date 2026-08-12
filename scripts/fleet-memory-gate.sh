#!/usr/bin/env bash
# fleet-memory-gate.sh  --check <agent> | --verdict | --status | --shed  [--dry-run]
#
# Commit 3 v1 -- SAFE-MODE / MEMORY GATE (decision logic, single source of truth).
#
# The Marveen fleet auto-respawns on every user-manager (re)init: the dashboard's
# channel-monitor reconcile loop starts every desired-but-down agent ~15s apart.
# On a 7.4 GiB WSL VM that startup storm drove app.slice to a 6.9G peak and an OOM
# poweroff (2026-07-09). This gate decides, per agent, whether a NEW start is
# allowed given current MemAvailable + running-agent count. It NEVER kills or
# restarts anything -- it only answers "may this agent start now?" and (as a side
# effect) manages the safe-mode flag + a deduped Telegram alert.
#
# Contract (exit codes):
#   0   -> ALLOW this start
#   10  -> BLOCK this start (memory/cap; non-core in safe-mode band, or hard pause)
#   (any internal error -> exit 0 / ALLOW: fail-open, so a broken gate can never
#    freeze the fleet -- worst case is the pre-Commit-3 behaviour.)
#
# Bands (usedPct = 100 * (MemTotal - MemAvailable) / MemTotal):
#   usedPct < WARN            -> allow all; clear safe-mode flag
#   WARN <= usedPct < HARD    -> allow ONLY core agents (safe-mode); warn once
#   usedPct >= HARD           -> hard pause: block ALL new spawns; alert once
#   running non-core >= CAP   -> block non-core regardless of band
#
# Kill-switch: MARVEEN_MEM_GATE_DISABLE=1 -> immediate exit 0 (pure pass-through).
#
# Read-only except its own state files (safe-mode flag + alert-dedupe stamp);
# Telegram send is best-effort; --dry-run makes it fully side-effect free.

set -uo pipefail

MODE=""; ARG=""; DRY_RUN=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --check)   MODE="check"; ARG="${2:-}"; shift 2 ;;
    --verdict) MODE="verdict"; shift ;;
    --status)  MODE="status"; shift ;;
    --shed)    MODE="shed"; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    *) shift ;;
  esac
done
[[ -z "$MODE" ]] && MODE="verdict"

# Kill-switch: pure pass-through, no reads, no side effects.
if [[ "${MARVEEN_MEM_GATE_DISABLE:-0}" == "1" ]]; then
  echo "gate-disabled: allow (MARVEEN_MEM_GATE_DISABLE=1)"
  exit 0
fi

# Resolve this install's own dir + main agent id from its .env (no hardcoded
# owner/agent/chat-id -- distribution rule). SERVICE_ID falls back to
# MAIN_AGENT_ID which falls back to "marveen"; the main agent MUST be core so
# a memory-pressure band never throttles the operator's primary bot.
INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
_env_val() { [[ -f "$INSTALL_DIR/.env" ]] && grep -E "^$1=" "$INSTALL_DIR/.env" | head -1 | cut -d= -f2- | tr -d '"'"'"'\r'; }
MAIN_AGENT_ID="$(_env_val MAIN_AGENT_ID)"; MAIN_AGENT_ID="${MAIN_AGENT_ID:-marveen}"

WARN_PCT="${MARVEEN_MEM_WARN_PCT:-80}"
HARD_PCT="${MARVEEN_MEM_HARD_PCT:-90}"
# Real env var wins (lets an operator override per-invocation without touching
# .env); otherwise fall back to .env, like MAIN_AGENT_ID above -- a hand-edited
# .env is the documented way to configure this script (see file header), but
# only MAIN_AGENT_ID actually read it until now.
_AGENT_CAP_ENV="$(_env_val MARVEEN_AGENT_CAP)"
AGENT_CAP="${MARVEEN_AGENT_CAP:-${_AGENT_CAP_ENV:-12}}"
# Core = never-throttled agents. Defaults to THIS install's main agent so the
# primary bot always survives the safe-mode band; override with MARVEEN_CORE_AGENTS.
CORE_AGENTS="${MARVEEN_CORE_AGENTS:-$MAIN_AGENT_ID}"
STAGGER_SEC="${MARVEEN_STAGGER_SEC:-20}"   # consumed by fleet-safe-start.sh
STATE_DIR="${MARVEEN_STORE:-$INSTALL_DIR/store}"
SAFE_FLAG="$STATE_DIR/.fleet-safe-mode"
ALERT_STAMP="$STATE_DIR/.fleet-memgate-alert"   # "band:epoch" of last alert
OBSERVE_FLAG="$STATE_DIR/.fleet-memgate-observe"  # if present -> observe-only

# OBSERVE-ONLY mode (Istvan standing directive 2026-07-09, re-confirmed 2026-07-15):
# monitor + alert stay ON, but the gate NEVER blocks a start and NEVER writes the
# safe-mode marker -- Istvan makes the throttle/rollback call himself. Toggle via the
# file flag (touch/rm store/.fleet-memgate-observe) or MARVEEN_MEM_GATE_OBSERVE=1.
OBSERVE=0
if [[ "${MARVEEN_MEM_GATE_OBSERVE:-0}" == "1" || -f "$OBSERVE_FLAG" ]]; then OBSERVE=1; fi
ENV_FILE="${TELEGRAM_ENV:-$HOME/.claude/channels/telegram/.env}"
# Alert target: the owner's chat id. Resolve from the channel access.json (the
# first allow-listed sender) so no chat-id is ever hardcoded; override with
# MARVEEN_ALERT_CHAT_ID. Empty -> the Telegram alert is skipped (log only), never
# sent to a stranger.
ACCESS_JSON="${TELEGRAM_ACCESS:-$HOME/.claude/channels/telegram/access.json}"
CHAT_ID="${MARVEEN_ALERT_CHAT_ID:-}"
if [[ -z "$CHAT_ID" && -f "$ACCESS_JSON" ]] && command -v python3 >/dev/null 2>&1; then
  CHAT_ID="$(python3 -c 'import json,sys
try:
  a=json.load(open(sys.argv[1]));v=a.get("allowFrom") or []
  print(v[0] if v else "")
except Exception: print("")' "$ACCESS_JSON" 2>/dev/null)"
fi
ALERT_COOLDOWN=600   # seconds; do not repeat the same band's alert within this

log() { echo "[fleet-memory-gate] $*" >&2; }

# --- read memory ---
mem_total="$(awk '/^MemTotal:/{print $2}' /proc/meminfo 2>/dev/null)"
mem_avail="$(awk '/^MemAvailable:/{print $2}' /proc/meminfo 2>/dev/null)"
if [[ -z "${mem_total:-}" || -z "${mem_avail:-}" || "$mem_total" -le 0 ]]; then
  log "cannot read /proc/meminfo -- fail-open (allow)"
  echo "meminfo-unreadable: allow"
  exit 0
fi
used_pct=$(( (mem_total - mem_avail) * 100 / mem_total ))
avail_mb=$(( mem_avail / 1024 ))

# --- count running non-core agents (tmux agent-* sessions; dependency-free) ---
running=0
if command -v tmux >/dev/null 2>&1; then
  running="$(tmux ls 2>/dev/null | grep -c '^agent-' || echo 0)"
fi

is_core() {
  local a="$1"; local c
  IFS=',' read -ra _cores <<< "$CORE_AGENTS"
  for c in "${_cores[@]}"; do [[ "$a" == "$(echo "$c" | tr -d ' ')" ]] && return 0; done
  return 1
}

# --- shedding helpers (--shed) ----------------------------------------------
# The bands above only gate NEW starts. That was not enough on 2026-08-12: 14
# agents were already running when the VM ran out of memory, the kernel hit a
# page-allocation failure, and the whole WSL VM stalled and went down -- the
# gate said "band=ok" the entire time because nothing new was trying to start.
# Shedding closes that hole by parking an already-running agent.
# Real env var wins over .env (same convention as MARVEEN_AGENT_CAP above), so a
# test can point the gate at a stub dashboard without touching the install.
DASH_PORT="${WEB_PORT:-$(_env_val WEB_PORT)}"; DASH_PORT="${DASH_PORT:-3420}"
PARK_LOG="$STATE_DIR/.fleet-parked-agents"

dash_token() {
  local f="$STATE_DIR/.dashboard-token"
  [[ -f "$f" ]] && tr -d ' \r\n' <"$f" || true
}

# Resident footprint (KB) of a tmux session's process tree; 0 when unmeasurable,
# which just means the session sorts last as a shed candidate.
session_rss_kb() {
  local session="$1" pane_pid kids total=0 p r
  command -v tmux >/dev/null 2>&1 || { echo 0; return; }
  pane_pid="$(tmux list-panes -t "$session" -F '#{pane_pid}' 2>/dev/null | head -1)"
  [[ -z "${pane_pid:-}" ]] && { echo 0; return; }
  kids="$(ps --ppid "$pane_pid" -o pid= 2>/dev/null)"
  for p in $pane_pid $kids; do
    r="$(ps -p "$p" -o rss= 2>/dev/null | tr -dc '0-9')"
    total=$(( total + ${r:-0} ))
  done
  echo "$total"
}

# Agents that may be parked: running AND idle, per the dashboard's own pane-state
# classifier (/api/agents/activity). Deliberately NOT re-derived here: "is this
# pane busy?" is a screenful of hard-won regexes in src/pane-state.ts, and a
# second, cruder copy in shell is how a fleet ends up pinned busy forever (or,
# worse, how a working agent gets killed mid-turn). No dashboard, no python3, or
# no token -> empty list -> nothing is shed. Fail-safe, like the rest of the gate.
shed_candidates() {
  local token; token="$(dash_token)"
  [[ -z "$token" ]] && return 0
  command -v python3 >/dev/null 2>&1 || return 0
  command -v curl >/dev/null 2>&1 || return 0
  curl -s --max-time 10 -H "Authorization: Bearer $token" \
    "http://127.0.0.1:${DASH_PORT}/api/agents/activity" 2>/dev/null \
    | python3 -c 'import json,sys
try: rows = json.load(sys.stdin)
except Exception: sys.exit(0)
for r in rows if isinstance(rows, list) else []:
    if r.get("running") and r.get("state") == "idle" and not r.get("isMain"):
        n = r.get("name")
        if n: print(n)' 2>/dev/null
}

# Best-effort deduped Telegram alert (band-cooldown).
send_alert() {
  local band="$1" msg="$2"
  (( DRY_RUN )) && { log "DRY-RUN alert [$band]: $msg"; return 0; }
  # No resolvable owner chat id -> never send (would otherwise go nowhere or, with
  # a hardcoded default, to a stranger). Log and move on.
  [[ -z "$CHAT_ID" ]] && { log "no owner chat id resolved; skipping Telegram alert [$band]"; return 0; }
  local now prev_band prev_ep
  now="$(date +%s)"
  if [[ -f "$ALERT_STAMP" ]]; then
    prev_band="$(cut -d: -f1 "$ALERT_STAMP" 2>/dev/null)"
    prev_ep="$(cut -d: -f2 "$ALERT_STAMP" 2>/dev/null | tr -dc '0-9')"
    if [[ "$prev_band" == "$band" && -n "${prev_ep:-}" ]] && (( now - prev_ep < ALERT_COOLDOWN )); then
      log "alert [$band] within cooldown; skipping"; return 0
    fi
  fi
  local token=""
  [[ -f "$ENV_FILE" ]] && token="$(grep -E '^TELEGRAM_BOT_TOKEN=' "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'"'"' \r\n')"
  if [[ -n "$token" ]]; then
    curl -s --max-time 15 "https://api.telegram.org/bot${token}/sendMessage" \
      --data-urlencode "chat_id=${CHAT_ID}" --data-urlencode "text=${msg}" >/dev/null 2>&1 \
      && log "Telegram sent [$band]" || log "Telegram send failed (best-effort)"
  else
    log "no TELEGRAM_BOT_TOKEN; alert only logged"
  fi
  echo "${band}:${now}" >"$ALERT_STAMP" 2>/dev/null || true
}

set_safe_mode() {
  (( DRY_RUN )) && return 0
  (( OBSERVE )) && return 0   # observe-only: never persist the safe-mode marker
  [[ -f "$SAFE_FLAG" ]] || echo "$(date '+%Y-%m-%d %H:%M:%S') used=${used_pct}% avail=${avail_mb}MB" >"$SAFE_FLAG" 2>/dev/null || true
}
clear_safe_mode() {
  (( DRY_RUN )) && return 0
  [[ -f "$SAFE_FLAG" ]] && rm -f "$SAFE_FLAG" 2>/dev/null || true
}

# --- determine band + side effects ---
band="ok"
if (( used_pct >= HARD_PCT )); then
  band="hard"
  set_safe_mode
  send_alert hard "Marveen memória-kapu: HARD PAUSE. Használt memória ${used_pct}% (elérhető ${avail_mb} MB), a ${HARD_PCT}% küszöb felett. Új agent-indítás LEÁLLÍTVA (futók érintetlenek). Nézd a párhuzamos agent-számot."
elif (( used_pct >= WARN_PCT )); then
  band="warn"
  set_safe_mode
  send_alert warn "Marveen memória-kapu: SAFE-MODE. Használt memória ${used_pct}% (elérhető ${avail_mb} MB), a ${WARN_PCT}% küszöb felett. Csak core agentek indulhatnak, a többi indítás visszafogva."
else
  clear_safe_mode
fi

status_line="used=${used_pct}% avail=${avail_mb}MB running_agents=${running} cap=${AGENT_CAP} band=${band}"

# Observe-only: alerts have already fired above; from here the gate only reports and
# always ALLOWS -- no block exit (10), no cap-block. Istvan owns the throttle call.
if (( OBSERVE )); then
  echo "observe-only (monitor+alert, no block): $status_line"
  exit 0
fi

case "$MODE" in
  status|verdict)
    echo "$status_line"
    # verdict exit: 0 if a generic non-core start would be allowed, else 10
    if [[ "$band" == "hard" ]]; then exit 10; fi
    if [[ "$band" == "warn" ]]; then exit 10; fi
    if (( running >= AGENT_CAP )); then exit 10; fi
    exit 0
    ;;
  shed)
    # Only ever fires in a genuine hard pause. In warn/ok the fleet is not in
    # danger and stopping someone's agent would be a surprise, not a rescue.
    if [[ "$band" != "hard" ]]; then
      echo "no-shed (band=${band}, needs >=${HARD_PCT}%): $status_line"; exit 0
    fi
    best=""; best_rss=0
    while read -r cand; do
      [[ -z "$cand" ]] && continue
      is_core "$cand" && continue
      cand_rss="$(session_rss_kb "agent-${cand}")"
      # First candidate always wins the empty slot: an unmeasurable footprint
      # (0 KB) must not make an idle agent unsheddable, or a broken `ps` would
      # silently switch shedding off exactly when the VM needs it.
      if [[ -z "$best" ]] || (( cand_rss > best_rss )); then best="$cand"; best_rss="$cand_rss"; fi
    done < <(shed_candidates)

    if [[ -z "$best" ]]; then
      send_alert shed "Marveen memória-kapu: a memória ${used_pct}%-on áll (elérhető ${avail_mb} MB), de nincs tétlen agens amit le lehetne állítani -- minden futó agens dolgozik. Kézi döntés kell, mielőtt a gép elfogy."
      echo "no-idle-candidate: $status_line"; exit 0
    fi

    best_mb=$(( best_rss / 1024 ))
    if (( DRY_RUN )); then
      echo "would-shed ${best} (${best_mb}MB): $status_line"; exit 0
    fi

    # Stop through the dashboard's own route: it also clears the desired
    # run-state, so the 60s reconcile loop does not start the agent right back
    # up and turn this into an oscillation.
    stop_code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 -X POST \
      -H "Authorization: Bearer $(dash_token)" \
      "http://127.0.0.1:${DASH_PORT}/api/agents/${best}/stop" 2>/dev/null)"
    if [[ "$stop_code" == "200" ]]; then
      echo "$(date '+%Y-%m-%d %H:%M:%S') ${best} rss=${best_mb}MB used=${used_pct}% avail=${avail_mb}MB" \
        >>"$PARK_LOG" 2>/dev/null || true
      send_alert shed "Marveen memória-kapu: a memória ${used_pct}%-ra ment fel (elérhető ${avail_mb} MB), ezért leállítottam a(z) ${best} agenst. Tétlen volt, nem veszett el munka, és kb. ${best_mb} MB szabadult fel. Ha kell, a dashboard Ügynökök oldalán visszaindíthatod."
      echo "shed ${best} (${best_mb}MB): $status_line"; exit 0
    fi
    log "stop request for ${best} failed (HTTP ${stop_code:-?})"
    echo "shed-failed ${best} (HTTP ${stop_code:-?}): $status_line"; exit 0
    ;;
  check)
    agent="$ARG"
    if [[ -z "$agent" ]]; then log "--check needs an agent name"; echo "no-agent: allow"; exit 0; fi
    if is_core "$agent"; then
      # Core agents (dashboard/channels are services, not gated) may start except
      # in a genuine hard pause.
      if [[ "$band" == "hard" ]]; then
        echo "block core (hard pause): $agent | $status_line"; exit 10
      fi
      echo "allow core: $agent | $status_line"; exit 0
    fi
    # non-core
    if [[ "$band" == "hard" || "$band" == "warn" ]]; then
      echo "block non-core (${band}): $agent | $status_line"; exit 10
    fi
    if (( running >= AGENT_CAP )); then
      send_alert cap "Marveen memória-kapu: agent-cap elérve (${running}/${AGENT_CAP}). Új nem-core agent-indítás visszafogva, amíg csökken a szám."
      echo "block non-core (cap ${running}/${AGENT_CAP}): $agent | $status_line"; exit 10
    fi
    echo "allow: $agent | $status_line"; exit 0
    ;;
esac
exit 0
