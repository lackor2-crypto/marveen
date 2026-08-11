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
SENDER="${MARVEEN_WAKE_SENDER:-lackor2-bot}"
# Space-separated ids; override for a different install.
TARGETS="${MARVEEN_WAKE_TARGETS:-lackor2-bot usalackor lackor3}"
MESSAGE="${MARVEEN_WAKE_MESSAGE:-Jo reggelt. Ebreszto -- valaszolj egy rovid sorral hogy ebren vagy, es ezzel frissul a keret-allapotod a dashboardon. Mas teendo nincs.}"

log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$1" >> "$LOG" 2>/dev/null || true; }

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
