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
API="${MARVEEN_API:-http://localhost:3420}"
STALE_DAYS="${KANBAN_AUDIT_STALE_DAYS:-7}"

[ -f "$TOKEN_FILE" ] || exit 0
TOKEN="$(cat "$TOKEN_FILE")"

export API TOKEN
cards="$(curl -s --max-time 20 -H "Authorization: Bearer $TOKEN" "$API/api/kanban" 2>/dev/null)" || exit 0
[ -n "$cards" ] || exit 0

report="$(printf '%s' "$cards" | STALE_DAYS="$STALE_DAYS" python3 -c '
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

# waiting cards are, by the workflow, supposed to have an approval pending.
waiting = [c for c in cards if c.get("status") == "waiting"]

approvals = []
try:
    import urllib.request
    req = urllib.request.Request(
        os.environ.get("API", "http://localhost:3420") + "/api/approvals",
        headers={"Authorization": "Bearer " + os.environ.get("TOKEN", "")},
    )
    with urllib.request.urlopen(req, timeout=20) as r:
        raw = json.load(r)
        approvals = raw if isinstance(raw, list) else raw.get("approvals", [])
except Exception:
    approvals = []

pending_card_ids = set()
for a in approvals:
    if a.get("status") != "pending":
        continue
    payload = a.get("action_payload") or ""
    try:
        cid = json.loads(payload).get("kanban_card_id")
        if cid:
            pending_card_ids.add(cid)
    except Exception:
        pass
    desc = a.get("action_description") or ""
    for tok in desc.split():
        t = tok.strip("(),.\"")
        if len(t) == 8 and all(ch in "0123456789abcdef" for ch in t.lower()):
            pending_card_ids.add(t)

# A waiting card with no pending approval is the exact failure Boss caught:
# the work is parked as "done enough to wait" and nobody is being asked.
orphan_waiting = [
    c for c in waiting
    if not any(c["id"].startswith(p) or p.startswith(c["id"]) for p in pending_card_ids)
]

lines = []
if orphan_waiting:
    lines.append("VARAKOZO, DE NINCS JOVAHAGYAS-KERES (%d):" % len(orphan_waiting))
    for c in orphan_waiting[:10]:
        lines.append("  #%s %s -- %s" % (c.get("seq"), c["id"][:8], (c.get("title") or "")[:60]))
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
  | bash "$BASE/scripts/agent-msg.sh" lackor2-bot lackor2-bot - 2>&1)"

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
