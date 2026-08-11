#!/usr/bin/env bash
# agent-wake.sh
#
# Nudges the logged-in Claude accounts so their rate-limit figures refresh.
#
# Why this exists (Boss, 2026-08-11): the rate-limit numbers only appear while
# an agent is actually working -- Claude reports them alongside real turns. An
# idle agent therefore shows nothing, and Boss watched lackor3 sit blank all
# morning until he messaged it by hand: "magatol nem eledt fel". After a reboot
# every account starts idle, so the whole board reads as unknown exactly when
# Boss most wants to know whether there is capacity.
#
# Scope is deliberately the ACCOUNT agents only. Boss: "az ingyeneseknek nem
# kell akik az openruteren keresztul vannak" -- the free OpenRouter agents draw
# on a shared per-minute budget (kanban 45c3cfad), so waking fourteen of them on
# every boot would spend that budget on saying hello.
#
# The nudge is a real message through the agent queue, which is what makes the
# agent take a turn and thus report its limits. Kept to one short line: this is
# a ping, not an assignment, and it should cost close to nothing.

set -uo pipefail

STORE="${MARVEEN_STORE:-$HOME/marveen/store}"
LOG="$STORE/agent-wake.log"
API="${MARVEEN_API:-http://localhost:3420}"
PROJECT_ROOT="${MARVEEN_ROOT:-$HOME/marveen}"
MESSAGE="${MARVEEN_WAKE_MESSAGE:-Jo reggelt. Ebreszto -- valaszolj egy rovid sorral hogy ebren vagy, es ezzel frissul a keret-allapotod a dashboardon. Mas teendo nincs.}"

# The main agent runs as the channels service, not as one of the listed agents,
# so it comes from the install config rather than the API.
MAIN_AGENT="$(grep -E '^MAIN_AGENT_ID=' "$PROJECT_ROOT/.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d ' "')"
# Last-resort fallback matches src/config.ts (MAIN_AGENT_ID default), not one
# install's agent id -- naming a specific one here would wake nothing on a host
# whose .env is missing or unreadable.
MAIN_AGENT="${MAIN_AGENT:-marveen}"
SENDER="${MARVEEN_WAKE_SENDER:-$MAIN_AGENT}"

# Which agents to wake is DISCOVERED, never hardcoded (Boss, 2026-08-11: "remelem
# nem fixen csak ennek a 3-nak irtad meg!? hanem ha csatlakoztatok meg 5-ot akkor
# azok is fognak mukodni"). A fixed list would quietly skip every account added
# later -- and the failure would be invisible: no error, just a blank limit
# reading for the new account, which is the very symptom this script exists to
# prevent.
#
# The signal is claudePlan: the dashboard sets it to the account name for agents
# backed by a logged-in Claude account, and leaves it null for the OpenRouter
# pool. That is the same distinction Boss drew ("az ingyeneseknek nem kell akik
# az openruteren keresztul vannak"), read from live state instead of restated.
discover_targets() {
  local token="$STORE/.dashboard-token"
  [ -f "$token" ] || return 1
  curl -s --max-time 20 -H "Authorization: Bearer $(cat "$token")" "$API/api/agents" 2>/dev/null | python3 -c '
import json, sys
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(1)
agents = data if isinstance(data, list) else data.get("agents", [])
names = [a.get("name") for a in agents if a.get("claudePlan") and a.get("name")]
if not names:
    sys.exit(1)
print(" ".join(names))
' 2>/dev/null
}

if [ -n "${MARVEEN_WAKE_TARGETS:-}" ]; then
  TARGETS="$MARVEEN_WAKE_TARGETS"
else
  discovered="$(discover_targets)" || discovered=""
  if [ -n "$discovered" ]; then
    TARGETS="$MAIN_AGENT $discovered"
  else
    # The dashboard may not be up yet on a boot run. Waking the main agent alone
    # is still better than nothing, and it is the one whose id we know without
    # the API.
    TARGETS="$MAIN_AGENT"
    log_pending="discovery failed (dashboard not answering) -- main agent only"
  fi
fi

log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$1" >> "$LOG" 2>/dev/null || true; }

[ -n "${log_pending:-}" ] && log "$log_pending"
log "targets: ${TARGETS}"

sent=0
failed=0
for agent in $TARGETS; do
  # Skip an agent that is not running: startAgentProcess is the dashboard's job
  # (reconcileDesiredAgents), and a queued message for a dead session would just
  # sit there. Waking is a nice-to-have, never a reason to fight the fleet state.
  if ! tmux has-session -t "agent-${agent}" 2>/dev/null && [ "$agent" != "$SENDER" ]; then
    log "skip ${agent}: no tmux session"
    continue
  fi
  out="$(printf '%s' "$MESSAGE" | bash "$HOME/marveen/scripts/agent-msg.sh" "$SENDER" "$agent" - 2>&1)"
  case "$out" in
    *OK\ id=*) sent=$((sent + 1)); log "woke ${agent}: ${out}" ;;
    *)         failed=$((failed + 1)); log "FAILED ${agent}: ${out}" ;;
  esac
done

log "done: ${sent} woken, ${failed} failed"
[ "$failed" -eq 0 ]
