#!/usr/bin/env bash
# dashboard-health-guard.sh
#
# Restart=always covers a dashboard that EXITS. It does nothing for a dashboard
# that is still running but no longer answering -- an event-loop stall, a wedged
# native module, a port held by a process that stopped serving. From outside,
# both look identical: the fleet goes quiet. This guard closes that gap by
# testing the thing users actually depend on (an HTTP response), not the thing
# systemd can see (a live PID).
#
# Written after an ~11.5 hour overnight outage (2026-08-11) that nobody could
# have noticed remotely: Boss asked the right question -- "mi van ha nem vagyok
# itthon két hétig?"
#
# Deliberately conservative:
#   - Three probes, spaced, before acting. A single failed curl during a GC
#     pause or a heavy request must never trigger a restart.
#   - Restarts through systemd, never by hand. A hand-rolled `node dist/index.js`
#     runs OUTSIDE the unit, which is precisely the mistake that caused the
#     outage this script exists to prevent.
#   - Always exits 0: a guard that enters `failed` looks like an incident and
#     silences itself.

set -uo pipefail

PORT="${WEB_PORT:-3420}"
URL="http://localhost:${PORT}/"
UNIT="lackor2-bot-dashboard.service"
STATE_DIR="${MARVEEN_STORE:-$HOME/marveen/store}"
LOG="$STATE_DIR/dashboard-health-guard.log"
PROBES=3
PROBE_GAP_SECONDS=5
CURL_TIMEOUT=10

log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$1" >> "$LOG" 2>/dev/null || true; }

# A dashboard that was stopped on purpose stays stopped: this guard is for
# unexpected death, not for overriding maintenance.
state="$(systemctl --user is-enabled "$UNIT" 2>/dev/null || echo unknown)"
if [ "$state" = "disabled" ] || [ "$state" = "masked" ]; then
  exit 0
fi

healthy=0
for i in $(seq 1 "$PROBES"); do
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time "$CURL_TIMEOUT" "$URL" 2>/dev/null || echo 000)"
  # Any HTTP status means the server is answering. 401/403 are healthy too --
  # the dashboard is auth-gated, and demanding 200 here would restart a
  # perfectly working server whenever the probe lacks a token.
  if [ "$code" != "000" ]; then
    healthy=1
    break
  fi
  [ "$i" -lt "$PROBES" ] && sleep "$PROBE_GAP_SECONDS"
done

if [ "$healthy" = "1" ]; then
  exit 0
fi

log "no HTTP response after ${PROBES} probes -- restarting ${UNIT}"
systemctl --user restart "$UNIT" 2>>"$LOG"
sleep 15

code="$(curl -s -o /dev/null -w '%{http_code}' --max-time "$CURL_TIMEOUT" "$URL" 2>/dev/null || echo 000)"
if [ "$code" = "000" ]; then
  log "restart did NOT bring the dashboard back (still no response)"
else
  log "restart succeeded (HTTP ${code})"
fi

exit 0
