#!/usr/bin/env bash
# email-fastpath-guard.sh -- watch the direct-IMAP fast path for email-body
# loading and alert (durably, via the agent's own message queue) the moment
# it regresses, instead of waiting for a human to notice slow-loading mail.
#
# WHY THIS EXISTS (2026-08-18): the fast path silently broke for EVERY email
# account the moment the dashboard first saved an account config after the
# fast-path code shipped -- a TOML-format mismatch between the config writer
# (smol-toml stringify, always nested-table form) and the old hand-rolled
# reader in email-imap.ts (only understood the dotted-key form). It went
# undetected for about 12 days until Boss happened to notice one message load
# slowly with an attachment. The reader is now a real TOML library
# (format-agnostic), which should make THIS bug class structurally
# impossible going forward -- but this guard exists for the *next*
# regression: a future code change, or a genuinely misconfigured new
# account. See checkImapAccountConfig() in src/web/email-imap.ts and the
# /api/email/fastpath-status route in src/web/routes/email.ts -- this script
# is just a scheduled caller of that same check (the same one the Email
# page's red status banner uses).
#
# Reports through the agent message queue (agent-msg.sh), so a durable
# record survives even if the current turn's context is lost. Silent when
# healthy; alerts on state transitions and re-escalates every 2h while still
# broken, so a missed first alert cannot leave the problem unnoticed forever
# without spamming every 15-minute tick.
#
# Usage: bash scripts/email-fastpath-guard.sh [--report-only]

set -uo pipefail

BASE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STORE="${MARVEEN_STORE:-$BASE/store}"
LOG="$STORE/email-fastpath-guard.log"
STATE="$STORE/email-fastpath-guard.state"
PORT="${MARVEEN_WEB_PORT:-3420}"
TOKEN_FILE="$STORE/.dashboard-token"
REPORT_ONLY=0
[ "${1:-}" = "--report-only" ] && REPORT_ONLY=1

env_val() { sed -n "s/^$1=//p" "$BASE/.env" 2>/dev/null | tail -1 | tr -d '"'"'"'\r'; }
MAIN_AGENT="${MAIN_AGENT_ID:-$(env_val MAIN_AGENT_ID)}"
MAIN_AGENT="${MAIN_AGENT:-marveen}"

log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$1" >> "$LOG" 2>/dev/null || true; }

[ -r "$TOKEN_FILE" ] || { log "no dashboard token, skipped"; exit 0; }
TOKEN="$(cat "$TOKEN_FILE")"

RESP="$(curl -s -m 10 "http://127.0.0.1:${PORT}/api/email/fastpath-status" -H "Authorization: Bearer $TOKEN" 2>&1)"
if [ -z "$RESP" ]; then
  log "empty response from dashboard, skipped"
  exit 0
fi

# Parse with node (always present in this repo; jq is not guaranteed). Prints
# one "label<TAB>reason" line per broken account, nothing when all accounts
# are healthy, or the literal PARSE_ERROR if the body isn't the expected shape.
BROKEN="$(node -e '
let raw = "";
process.stdin.on("data", d => raw += d);
process.stdin.on("end", () => {
  try {
    const data = JSON.parse(raw);
    const accounts = Array.isArray(data.accounts) ? data.accounts : [];
    for (const a of accounts) {
      if (!a.ok) console.log(`${a.label || a.account}\t${a.reason || "ismeretlen ok"}`);
    }
  } catch {
    console.log("PARSE_ERROR");
  }
});
' <<< "$RESP" 2>/dev/null)"

if [ "$BROKEN" = "PARSE_ERROR" ]; then
  log "PARSE_ERROR resp=$(printf '%s' "$RESP" | head -c 200)"
  exit 0
fi

PREV="$(cat "$STATE" 2>/dev/null || echo 'ok 0')"
PREV_STATUS="$(printf '%s' "$PREV" | cut -d' ' -f1)"
PREV_ALERT_TS="$(printf '%s' "$PREV" | cut -d' ' -f2)"
NOW_TS="$(date +%s)"

if [ -z "$BROKEN" ]; then
  log "OK"
  [ "$REPORT_ONLY" = "1" ] && echo "OK"
  if [ "$PREV_STATUS" = "broken" ]; then
    send_out="$(printf '[EMAIL-OR] Helyreallt: a gyors level-test betoltes ismet mukodik minden fioknal.' \
      | bash "$BASE/scripts/agent-msg.sh" "$MAIN_AGENT" "$MAIN_AGENT" - 2>&1)"
    log "recovery delivery: ${send_out:-<no output>}"
  fi
  printf 'ok %s\n' "$NOW_TS" > "$STATE" 2>/dev/null || true
  exit 0
fi

log "BROKEN: $(printf '%s' "$BROKEN" | tr '\n' ';')"
if [ "$REPORT_ONLY" = "1" ]; then
  printf '%s\n' "$BROKEN"
  exit 1
fi

# Alert on the transition to broken, and re-escalate at most every 2h while it
# stays broken -- frequent enough that a missed/ignored first alert cannot
# leave the problem unnoticed indefinitely, not so often that a genuine
# outage spams every 15-minute tick.
COOLDOWN=7200
SHOULD_ALERT=0
if [ "$PREV_STATUS" != "broken" ]; then
  SHOULD_ALERT=1
elif [ $((NOW_TS - PREV_ALERT_TS)) -ge "$COOLDOWN" ]; then
  SHOULD_ALERT=1
fi

if [ "$SHOULD_ALERT" = "1" ]; then
  DETAIL="$(printf '%s' "$BROKEN" | awk -F'\t' '{printf "- %s: %s\n", $1, $2}')"
  REPORT="$(cat <<EOF
[EMAIL-OR] A gyors level-test betoltes (direct-IMAP fast path) elromlott.

Erintett fiok(ok):
$DETAIL

Ez azt jelenti: a level torzse most a mellekletekkel EGYUTT toltodik be,
lassan (a himalaya-fallback fut a direct-IMAP helyett).

Diagnozis / javitasi menetrend (ugyanaz, mint a 2026-08-18-i
TOML-format-drift incidensnel):
1. Nezd meg mi valtozott: git log -5 -- src/web/email-imap.ts
   src/web/routes/email.ts, es a config.toml legutobbi mtime-jat/tartalmat
   az erintett fioknal.
2. checkImapAccountConfig() (src/web/email-imap.ts) adja a fenti okot -- ha
   "hianyzo IMAP mezo" vagy "nem ertelmezheto IMAP szerver-cim", eloszor azt
   nezd meg, tenyleg ez van-e a config.toml-ban az erintett fioknal.
3. Ha a gyokerok egy KOD-regresszio es biztonsagosan javithato: javitsd,
   majd a szokasos menetrenddel ellenorizd es telepitsd (npx tsc --noEmit
   -p . -> a valtozott fajlok szinkronizalasa a szigetelt worktree-be ->
   npx vitest run ott -> npm run build -> systemctl --user restart
   lackor2-bot-dashboard.service -> curl-lel ellenorizd a
   /api/email/fastpath-status-t).
4. Ha a gyokerok egy VALODI hianyzo/rossz hitelesito adat (uj fiok rossz
   jelszoval, OAuth2 fiok jelszo-parancs nelkul, stb.): ezt NEM lehet
   automatikusan kitalalni vagy javitani -- jelentsd pontosan, mi hianyzik,
   ne probalj hitelesito adatot kitalalni vagy modositani.
5. Barhogy is vegzodik: irj rovid osszefoglalot (gyokerok, javitottad-e vagy
   miert nem, a build zold-e).
EOF
)"
  send_out="$(printf '%s\n' "$REPORT" | bash "$BASE/scripts/agent-msg.sh" "$MAIN_AGENT" "$MAIN_AGENT" - 2>&1)"
  log "alert delivery: ${send_out:-<no output>}"
fi

ALERT_TS="$PREV_ALERT_TS"
[ "$SHOULD_ALERT" = "1" ] && ALERT_TS="$NOW_TS"
printf 'broken %s\n' "$ALERT_TS" > "$STATE" 2>/dev/null || true
exit 1
