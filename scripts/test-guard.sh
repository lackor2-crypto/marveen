#!/usr/bin/env bash
# test-guard.sh -- run the whole suite against committed HEAD and report failures.
#
# WHY THIS EXISTS (Boss, 2026-08-11): a test sat red on main and nobody noticed.
# It pinned the installer's dashboard unit at Restart=on-failure as a scope
# marker; the intent legitimately changed months later, the assertion did not,
# and it simply stayed broken. His reaction was the right one -- "hat ilyennek
# nem szabad lennie hogy eloforduljon. fel kell kesziteni a marveen t hogy ilyen
# tobbet nem forduljon elo."
#
# The stale assertion was the symptom. The disease was that NOTHING RAN THE
# TESTS: no CI, no pre-commit hook, no schedule. The suite only ever ran when a
# human happened to ask, so "red" and "green" were indistinguishable states of
# the repo for weeks at a time. A rule telling agents to write better
# assertions would not have caught this; only running them does.
#
# Runs against COMMITTED HEAD in a throwaway git worktree, deliberately:
#   - the suite refuses to run inside a live install (it mutates store/, .env,
#     .claude/skills/), which is why a worktree is required and not a nicety;
#   - HEAD is what other machines get. A pass that depends on uncommitted local
#     edits is not a pass.
#
# Reports through the agent message queue, so the main agent decides what is
# worth the owner's attention. Silent when everything is green.

set -uo pipefail

BASE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STORE="${MARVEEN_STORE:-$BASE/store}"
LOG="$STORE/test-guard.log"
REPORT_ONLY=0
[ "${1:-}" = "--report-only" ] && REPORT_ONLY=1

env_val() { sed -n "s/^$1=//p" "$BASE/.env" 2>/dev/null | tail -1 | tr -d '"'"'"'\r'; }
MAIN_AGENT="${MAIN_AGENT_ID:-$(env_val MAIN_AGENT_ID)}"
MAIN_AGENT="${MAIN_AGENT:-marveen}"

log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$1" >> "$LOG" 2>/dev/null || true; }

command -v git >/dev/null 2>&1 || { log "git missing, skipped"; exit 0; }
[ -d "$BASE/node_modules" ] || { log "node_modules missing, skipped"; exit 0; }

# The worktree lives under the repo's own git-ignored .worktrees/, NOT under
# $TMPDIR: the suite's setup (src/__tests__/setup/assert-not-live-install.ts)
# refuses to run from transient storage (/tmp, /var/tmp, /dev/shm), because the
# hook-path guard rejects tmp-rooted hook commands. A /tmp worktree made every
# file "fail" with zero tests run (814/814 on 2026-09-29) -- a false red.
mkdir -p "$BASE/.worktrees" 2>/dev/null
WORKTREE="$(mktemp -d "$BASE/.worktrees/testguard.XXXXXX")" || { log "worktree dir creation failed, skipped"; exit 0; }
# Always clean up: a leaked worktree keeps a git lock entry around and the next
# run inherits the mess.
cleanup() {
  git -C "$BASE" worktree remove "$WORKTREE" --force >/dev/null 2>&1
  rm -rf "$WORKTREE"
  git -C "$BASE" worktree prune >/dev/null 2>&1
}
trap cleanup EXIT

if ! git -C "$BASE" worktree add "$WORKTREE" -d HEAD >/dev/null 2>&1; then
  log "worktree creation failed, skipped"
  exit 0
fi
ln -sfn "$BASE/node_modules" "$WORKTREE/node_modules" 2>/dev/null

# The "this install" parity tests must read the settings.json the main agent
# RUNS on. That dir is resolved from the live store/ and .env, which the
# throwaway worktree does not have -- there the resolver falls back to
# ~/.claude, a file the main agent may no longer use (false red, #442). Resolve
# it here, in the live install, and hand it to the suite. No build -> unset ->
# the tests keep their own resolution.
LIVE_MAIN_CONFIG_DIR="$(cd "$BASE" && timeout 20 node --input-type=module -e \
  "const m = await import('$BASE/dist/web/agent-config.js'); console.log(m.mainAgentEffectiveConfigDir()); process.exit(0)" 2>/dev/null | tail -1)"

OUTPUT="$(cd "$WORKTREE" && MARVEEN_LIVE_MAIN_CONFIG_DIR="$LIVE_MAIN_CONFIG_DIR" npx vitest run --reporter=dot 2>&1)"
STATUS=$?

HEAD_SHA="$(git -C "$BASE" rev-parse --short HEAD 2>/dev/null)"
SUMMARY="$(printf '%s' "$OUTPUT" | grep -E '^ *(Test Files|Tests) ' | head -4)"

if [ "$STATUS" -eq 0 ]; then
  log "PASS ($HEAD_SHA) $(printf '%s' "$SUMMARY" | tr '\n' ' ')"
  [ "$REPORT_ONLY" = "1" ] && printf 'PASS (%s)\n%s\n' "$HEAD_SHA" "$SUMMARY"
  exit 0
fi

# Name the failing tests, not just the count. "3 failed" sends someone digging;
# the file and test name is what makes the report actionable on its own.
FAILED="$(printf '%s' "$OUTPUT" | grep -E '^ *(FAIL|×|✗)' | head -20)"
REPORT="$(printf 'A teszt-sor PIROS a HEAD-en (%s).\n\n%s\n\nBuko tesztek:\n%s' "$HEAD_SHA" "$SUMMARY" "$FAILED")"

log "FAIL ($HEAD_SHA)"
printf '%s\n' "$REPORT" >> "$LOG" 2>/dev/null || true

if [ "$REPORT_ONLY" = "1" ]; then
  printf '%s\n' "$REPORT"
  exit 1
fi

# The send result is checked, not discarded -- a guard whose own delivery can
# fail silently is the same class of bug it exists to catch.
send_out="$(printf '[TESZT-OR] %s\n\nNezd meg: vagy a kod romlott el, vagy a teszt rogzit egy mar nem ervenyes elvarast. A masodik is hiba, nem "csak egy teszt".' "$REPORT" \
  | bash "$BASE/scripts/agent-msg.sh" "$MAIN_AGENT" "$MAIN_AGENT" - 2>&1)"
log "delivery: ${send_out:-<no output>}"

case "$send_out" in
  *OK\ id=*) exit 1 ;;
  *) log "DELIVERY FAILED"; exit 1 ;;
esac
