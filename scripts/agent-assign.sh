#!/usr/bin/env bash
# agent-assign.sh -- hand a task to an agent TOGETHER WITH the files it owns.
#
# Write partitioning (kanban 18bf8b2c): the pattern the industry settled on for
# parallel coding agents is not "detect the collision", it is "never assign
# overlapping files in the first place" -- the orchestrator gives each agent a
# disjoint write set. The claim registry and the PreToolUse gate stay as the
# safety net underneath; this is the part that stops the net being needed.
#
# What it does, in one step:
#   1. claims every listed file for the assignee (batch, one call)
#   2. REFUSES to hand out work whose files someone else is already holding,
#      naming the holder -- assigning it anyway is how two agents end up in the
#      same file
#   3. sends the task through the verified inter-agent path (agent-msg.sh),
#      with the file list spelled out in the message
#
# Usage:
#   scripts/agent-assign.sh <agent> "<task>" <file> [file...]
#   scripts/agent-assign.sh --force <agent> "<task>" <file> [file...]   # ignore holders
#
# Example:
#   scripts/agent-assign.sh lackor3 "Javitsd az email-szuro hibat" src/web/email-search.ts src/__tests__/email-search.test.ts

set -uo pipefail

BASE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API="${MARVEEN_API:-http://localhost:3420}"
TOKEN_FILE="$BASE/store/.dashboard-token"

FORCE=0
if [ "${1:-}" = "--force" ]; then FORCE=1; shift; fi

AGENT="${1:-}"
TASK="${2:-}"
shift 2 2>/dev/null || true
FILES=("$@")

if [ -z "$AGENT" ] || [ -z "$TASK" ] || [ "${#FILES[@]}" -eq 0 ]; then
  sed -n '2,26p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 1
fi

if [ ! -f "$TOKEN_FILE" ]; then
  echo "Nincs dashboard-token ($TOKEN_FILE) -- fut a dashboard?" >&2
  exit 1
fi
TOKEN="$(cat "$TOKEN_FILE")"

# Paths are stored repo-relative; accept absolute ones for convenience.
REL_FILES=()
for f in "${FILES[@]}"; do
  case "$f" in
    "$BASE"/*) REL_FILES+=("${f#"$BASE"/}") ;;
    /*) echo "A(z) $f nem a telepitesen belul van, kihagyom." >&2 ;;
    *) REL_FILES+=("$f") ;;
  esac
done
[ "${#REL_FILES[@]}" -gt 0 ] || { echo "Nem maradt ervenyes fajl." >&2; exit 1; }

RESPONSE="$(python3 - "$API" "$TOKEN" "$AGENT" "$TASK" "${REL_FILES[@]}" <<'PY'
import json, sys, urllib.request
api, token, agent, task = sys.argv[1:5]
paths = sys.argv[5:]
body = json.dumps({"agent": agent, "paths": paths, "note": task[:120]}).encode()
req = urllib.request.Request(api + "/api/file-claims", data=body,
                             headers={"Content-Type": "application/json", "Authorization": "Bearer " + token},
                             method="POST")
try:
    with urllib.request.urlopen(req, timeout=15) as r:
        print(r.read().decode())
except Exception as e:
    print(json.dumps({"error": str(e)}))
PY
)"

BLOCKED="$(printf '%s' "$RESPONSE" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
if d.get("error"):
    print("HIBA: " + d["error"])
    sys.exit(0)
for r in d.get("rejected", []):
    print("%s -> %s" % (r["path"], r["holder"]))
')"

if [ -n "$BLOCKED" ] && [ "$FORCE" -eq 0 ]; then
  echo "NEM adtam ki a feladatot -- ezeken a fajlokon mas agens dolgozik:" >&2
  echo "$BLOCKED" | sed 's/^/  /' >&2
  echo "Valassz mas fajlokat, varj amig elengedi, vagy: scripts/agent-assign.sh --force ..." >&2
  exit 2
fi

MESSAGE="$TASK

A hozzad rendelt fajlok (csak ezeket szerkeszd, ezek le vannak foglalva neked):
$(printf '  - %s\n' "${REL_FILES[@]}")
Ha mas fajlhoz is hozza kell nyulnod, elobb szolj -- lehet hogy azon epp masik agens dolgozik."

printf '%s' "$MESSAGE" | bash "$BASE/scripts/agent-msg.sh" "${MARVEEN_ASSIGN_FROM:-$(grep -E '^MAIN_AGENT_ID=' "$BASE/.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d ' "')}" "$AGENT" -
