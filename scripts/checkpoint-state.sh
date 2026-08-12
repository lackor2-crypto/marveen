#!/usr/bin/env bash
# checkpoint-state.sh -- write an agent's structured task-state checkpoint.
#
# WHY: the checkpoint used to be taken in exactly one place, the PreCompact hook.
# That covers a compaction and nothing else, so a /clear (manual or gate-sent)
# threw the whole working state away, and a session that died between compactions
# came back with nothing. The knowledge base (docs/context-compaction-knowledge.md,
# points 23 and 46) says the RIGHT moment is a task boundary -- feature finished,
# tests green, commit created -- because a checkpoint taken there is already on
# disk whenever the context is dropped afterwards, for whatever reason.
#
# Usage:
#   bash scripts/checkpoint-state.sh <agent> '<json>'       # JSON as an argument
#   ... | bash scripts/checkpoint-state.sh <agent> -        # JSON on STDIN
#   bash scripts/checkpoint-state.sh <agent> --clear        # task done, drop the record
#
# The JSON fields (all optional; nextAction is the one that almost always matters):
#   objective, phase, summary, doneSteps[], alreadyDelegated[], rejected[],
#   decisions[], constraints[], exactValues[], filesChanged[], openQuestions[],
#   pendingDecision, nextAction
#
# Example:
#   bash scripts/checkpoint-state.sh myagent '{"objective":"ship the gate",
#     "phase":"TESTING","doneSteps":["endpoint done"],"rejected":["polling -- too slow"],
#     "exactValues":["threshold=150000"],"nextAction":"run the suite"}'
#
# Output: "OK <agent> <n> field(s)" on success, "FAIL <reason>" + exit 1 otherwise.
# Env: MARVEEN_WEB_PORT (default 3420).
set -uo pipefail

# base dir = the parent of this script's dir, so it works from any CWD / any install
BASE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Port resolution follows the hooks (WEB_PORT env, then .env, then the default),
# so an install on a non-default port works without setting anything extra.
# MARVEEN_WEB_PORT is honoured too because other scripts in the repo use it.
PORT="${WEB_PORT:-${MARVEEN_WEB_PORT:-}}"
if [ -z "$PORT" ] && [ -r "$BASE/.env" ]; then
  PORT="$(sed -n 's/^WEB_PORT=//p' "$BASE/.env" | head -n1 | tr -d '"' | tr -d "'" | tr -d '[:space:]')"
fi
PORT="${PORT:-3420}"
TOKEN_FILE="$BASE/store/.dashboard-token"

AGENT="${1:?agent required}"
ARG="${2:?json required (or - for STDIN, or --clear)}"
# Env first, same as the hooks: lets a test point at another dashboard without
# writing a token file into the checkout (that file marks a LIVE install).
TOKEN="${MARVEEN_DASHBOARD_TOKEN:-}"
if [ -z "$TOKEN" ]; then
  [ -r "$TOKEN_FILE" ] || { echo "FAIL: no token file at $TOKEN_FILE"; exit 1; }
  TOKEN="$(cat "$TOKEN_FILE")"
fi
URL="http://localhost:${PORT}/api/agent-taskstate/${AGENT}"

if [ "$ARG" = "--clear" ]; then
  CODE="$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "$URL" -H "Authorization: Bearer $TOKEN" || true)"
  [ "$CODE" = "200" ] && { echo "OK $AGENT cleared"; exit 0; }
  echo "FAIL clear http=$CODE"; exit 1
fi

[ "$ARG" = "-" ] && ARG="$(cat)"

# Validate locally first: a malformed body would be stored as an EMPTY record,
# which then silently replays nothing -- the exact failure this script prevents.
BODY="$(ARG="$ARG" python3 -c '
import json, os, sys
try:
    d = json.loads(os.environ["ARG"])
except Exception as e:
    sys.stderr.write("invalid JSON: %s\n" % e); sys.exit(1)
if not isinstance(d, dict):
    sys.stderr.write("JSON must be an object\n"); sys.exit(1)
if not any(str(v).strip() for v in d.values()):
    sys.stderr.write("all fields empty -- nothing to checkpoint\n"); sys.exit(1)
print(json.dumps(d))
')" || { echo "FAIL invalid payload"; exit 1; }

RESP="$(curl -s -X POST "$URL" -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" -d "$BODY" -w $'\n%{http_code}' 2>/dev/null || true)"
CODE="$(printf '%s' "$RESP" | tail -n1)"
JSON="$(printf '%s' "$RESP" | sed '$d')"

# A 200 alone is not proof: confirm the record came back with content, the same
# verify-the-result discipline agent-msg.sh applies to inter-agent sends.
FIELDS="$(printf '%s' "$JSON" | python3 -c '
import sys, json
try:
    r = json.load(sys.stdin).get("record") or {}
except Exception:
    print(-1); sys.exit(0)
print(sum(1 for k, v in r.items() if k not in ("agent", "ts", "consumed") and (v if not isinstance(v, str) else v.strip())))
' 2>/dev/null || echo -1)"

if [ "$CODE" = "200" ] && [ "$FIELDS" -gt 0 ] 2>/dev/null; then
  echo "OK $AGENT $FIELDS field(s)"
  exit 0
fi
echo "FAIL http=$CODE fields=$FIELDS"
exit 1
