#!/usr/bin/env bash
# kanban-audit.sh
#
# Periodic board sweep (Boss, 2026-08-11). The approval endpoint now refuses to
# close a card without reviewing its neighbours, which handles the moment work
# finishes. This is the second net, for what that moment misses entirely: work
# that was finished and NEVER submitted at all, so no approval call was ever made
# to intercept.
#
# That is not hypothetical -- it is what prompted this. Boss handed out five
# cards as work; three were long done, live on the machine, and still sitting in
# planned/waiting because nobody moved them. A board that lies costs him real
# time: he re-assigns finished work, and the agent goes looking for something
# that already exists.
#
# Read-only by design. It reports, it never moves a card or files an approval:
# deciding a card is finished needs judgement about whether the work actually
# holds up, and a cron job has none. Output goes to Telegram only when there is
# something to say.
#
# Usage:
#   bash scripts/kanban-audit.sh                 report + send to the main agent
#   bash scripts/kanban-audit.sh --report-only   print the report, send nothing
#
# --report-only exists because the 4-hourly `kanban-audit` scheduled skill runs
# AS the main agent: having it call this script in send mode would make the main
# agent message itself and then re-report the same findings. In that context the
# skill wants the text, not a second delivery path.

set -uo pipefail

REPORT_ONLY=0
[ "${1:-}" = "--report-only" ] && REPORT_ONLY=1

# Repo root = this script's parent dir, so it works from any CWD and any install
# path (same resolution as agent-msg.sh). $HOME/marveen is only the last resort.
BASE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STORE="${MARVEEN_STORE:-$BASE/store}"
TOKEN_FILE="$STORE/.dashboard-token"

# The main agent's id is per-install (MAIN_AGENT_ID in .env). Hardcoding one
# would send this report to an agent that does not exist on any other machine,
# and agent-msg.sh would fail the send -- silently, as far as the board is
# concerned.
MAIN_AGENT="${MAIN_AGENT_ID:-$(sed -n 's/^MAIN_AGENT_ID=//p' "$BASE/.env" 2>/dev/null | tail -1 | tr -d '"'"'"'\r')}"
MAIN_AGENT="${MAIN_AGENT:-marveen}"
API="${MARVEEN_API:-http://localhost:3420}"
STALE_DAYS="${KANBAN_AUDIT_STALE_DAYS:-7}"

[ -f "$TOKEN_FILE" ] || exit 0
TOKEN="$(cat "$TOKEN_FILE")"

export API TOKEN
cards="$(curl -s --max-time 20 -H "Authorization: Bearer $TOKEN" "$API/api/kanban" 2>/dev/null)" || exit 0
[ -n "$cards" ] || exit 0
approvals="$(curl -s --max-time 20 -H "Authorization: Bearer $TOKEN" "$API/api/approvals" 2>/dev/null)"
[ -n "$approvals" ] || approvals='[]'

# Boss's rule, 2026-08-16: as many pending approvals as there are waiting cards,
# paired one to one. Answered by the SERVER's own function
# (waitingApprovalBalance in src/kanban-related.ts) rather than by a second
# implementation here -- the hand-written measurement that first found this
# imbalance matched on action_payload alone and reported cards as orphans that
# already had an approval carrying their id in the description text.
#
# tsx runs the TypeScript source directly, so the check does not go stale
# waiting for a build. If tsx is missing the balance section is simply absent;
# the rest of the sweep still reports, because a partial audit beats none.
balance=''
if [ -x "$BASE/node_modules/.bin/tsx" ]; then
  balance="$(printf '{"cards":%s,"approvals":%s}' "$cards" "$approvals" \
    | "$BASE/node_modules/.bin/tsx" "$BASE/scripts/kanban-approval-balance.ts" 2>/dev/null)"
fi

report="$(printf '%s' "$cards" | STALE_DAYS="$STALE_DAYS" BALANCE="$balance" python3 -c '
import json, os, sys, time

try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)

cards = data if isinstance(data, list) else data.get("cards", [])
now = int(time.time())
stale_days = int(os.environ.get("STALE_DAYS", "7"))
stale_cutoff = now - stale_days * 86400

# in_progress with no movement for a week: either abandoned or actually done
# and never moved. Both are worth a look; neither is decidable from here.
stuck = [
    c for c in cards
    if c.get("status") == "in_progress" and (c.get("updated_at") or 0) < stale_cutoff
]

# The waiting/approval pairing is NOT decided here any more: it is answered by
# waitingApprovalBalance on the server side, via scripts/kanban-approval-balance.ts,
# and passed in as $BALANCE. (No apostrophes in this block: it is a single-quoted
# shell string, and one stray quote ends the program mid-comment.)
# Two implementations of "does this approval belong
# to this card" would drift, and the drift is silent -- one side calls a card
# submitted while the other calls it an orphan.
lines = []
balance = os.environ.get("BALANCE", "").strip()
if balance:
    lines.append(balance)
if stuck:
    lines.append("FOLYAMATBAN %d+ NAPJA MOZDULATLAN (%d):" % (stale_days, len(stuck)))
    for c in stuck[:10]:
        lines.append("  #%s %s -- %s" % (c.get("seq"), c["id"][:8], (c.get("title") or "")[:60]))

print("\n".join(lines))
' 2>/dev/null)" || exit 0

[ -n "$report" ] || exit 0

if [ "$REPORT_ONLY" = "1" ]; then
  printf '%s\n' "$report"
  exit 0
fi

# Sent AS the main agent to itself: the message queue only accepts a known
# agent id as sender, and "kanban-audit" is a script, not an agent -- the first
# run failed with HTTP 403 for exactly that reason (caught immediately, because
# the delivery result is logged rather than discarded).
# Report through the agent message queue rather than straight to Telegram: the
# main agent decides what is worth Boss's attention and can act on the findings,
# which a raw cron message cannot.
#
# The send result is LOGGED, not discarded. A guard whose own delivery can fail
# silently is the same class of bug it exists to catch -- and this codebase has
# already paid for that lesson twice in one night (a capture that reported
# success without writing, an Explorer kill with no start).
LOG="$STORE/kanban-audit.log"
send_out="$(printf '[KANBAN-AUDIT] A tabla es a jovahagyasok elternek egymastol:\n\n%s\n\nNezd at: amelyik tenyleg kesz, add fel jovahagyasra; amelyik nem, told vissza vagy kommenteld.' "$report" \
  | bash "$BASE/scripts/agent-msg.sh" "$MAIN_AGENT" "$MAIN_AGENT" - 2>&1)"

{
  printf '%s findings:\n%s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$report"
  printf '  delivery: %s\n' "${send_out:-<no output>}"
} >> "$LOG" 2>/dev/null || true

# agent-msg.sh prints "OK id=<n>" on success; anything else is a failed send and
# must not look like a clean run.
case "$send_out" in
  *OK\ id=*) exit 0 ;;
  *) exit 1 ;;
esac
