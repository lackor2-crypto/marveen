#!/usr/bin/env bash
# heavy-job.sh [--wait SEC] [--timeout SEC] <name> -- <command...>
#
# Single-flight queue for HEAVY jobs (tsc build, Playwright/chromium, a web-only
# instance, the full test suite). Card #683.
#
# Why: on 2026-10-17 21:32-21:37 a deploy build, a full `npx vitest run`, a
# web-only instance and three Playwright runs overlapped on the 10 GB WSL VM.
# Memory went 73% -> 93% (671 MB available), swap ran dry and the whole VM
# froze; after the Windows restart the fleet needed ~7 minutes to come back.
# Each job alone is fine. Together they are not. This wrapper makes them take
# turns: one heavy job at a time on the whole machine.
#
# How: an exclusive flock on STORE_DIR/heavy-job.lock (STORE_DIR is the shared
# store, so a job started from any worktree queues behind the others). The
# running job is written to STORE_DIR/heavy-job.json ({name,pid,started,cmd});
# scripts/fleet-memory-gate.sh --shed reads it to stop the job (and its
# children) when memory runs short. The lock fd is NOT inherited by the job, so
# a job that leaves a stray child behind does not keep the queue blocked.
#
# Waiting is visible: every 30 s a "varok" line names the job that holds the
# queue. If the wait runs past --wait (default 1800 s) it gives up with exit 75
# (EX_TEMPFAIL) -- it never runs the command unqueued after a timeout.
#
# Exit code: the command's own; 75 = queue wait timed out; 124 = --timeout hit.
# Fail-open on the queue itself: without flock(1) or a writable store the
# command just runs (a broken queue must not stop the work).
#
# Nested use (a heavy-job calling a script that calls heavy-job) runs the inner
# command directly -- MARVEEN_HEAVY_JOB_ACTIVE is set for the job, so it can
# never deadlock on its own lock.
set -uo pipefail

INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# One queue per MACHINE: a job started from a worktree must queue behind the one
# the live checkout runs, so a linked worktree resolves to the MAIN checkout's
# store (a worktree has no store/ of its own, or only a throwaway one).
resolve_store() {
  local common main
  common="$(git -C "$INSTALL_DIR" rev-parse --git-common-dir 2>/dev/null)" || common=""
  if [[ -n "$common" ]]; then
    [[ "$common" = /* ]] || common="$INSTALL_DIR/$common"
    main="$(dirname "$(cd "$common" 2>/dev/null && pwd)")"
    if [[ -d "$main/store" ]]; then echo "$main/store"; return; fi
  fi
  echo "$INSTALL_DIR/store"
}
STORE_DIR="${MARVEEN_STORE:-$(resolve_store)}"
LOCK="$STORE_DIR/heavy-job.lock"
REG="$STORE_DIR/heavy-job.json"
WAIT_SEC="${MARVEEN_HEAVY_JOB_WAIT:-1800}"
RUN_TIMEOUT=0

usage() { echo "usage: heavy-job.sh [--wait SEC] [--timeout SEC] <name> -- <command...>" >&2; exit 64; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --wait)    WAIT_SEC="${2:-}"; shift 2 ;;
    --timeout) RUN_TIMEOUT="${2:-}"; shift 2 ;;
    --) break ;;
    -*) usage ;;
    *) break ;;
  esac
done
NAME="${1:-}"; [[ -n "$NAME" ]] || usage
shift
[[ "${1:-}" == "--" ]] || usage
shift
[[ $# -gt 0 ]] || usage
[[ "$WAIT_SEC" =~ ^[0-9]+$ ]] || usage
[[ "$RUN_TIMEOUT" =~ ^[0-9]+$ ]] || usage
NAME="${NAME//[^a-zA-Z0-9_.-]/_}"

run_cmd() {
  if (( RUN_TIMEOUT > 0 )) && command -v timeout >/dev/null 2>&1; then
    timeout -k 10 "$RUN_TIMEOUT" "$@"
  else
    "$@"
  fi
}

# Nested, or no queue available: run directly.
if [[ -n "${MARVEEN_HEAVY_JOB_ACTIVE:-}" ]] || ! command -v flock >/dev/null 2>&1 || ! mkdir -p "$STORE_DIR" 2>/dev/null; then
  export MARVEEN_HEAVY_JOB_ACTIVE="${MARVEEN_HEAVY_JOB_ACTIVE:-1}"
  run_cmd "$@"; exit $?
fi

exec 9>"$LOCK" 2>/dev/null || { export MARVEEN_HEAVY_JOB_ACTIVE=1; run_cmd "$@"; exit $?; }

holder() {
  local n p
  n="$(sed -n 's/.*"name": *"\([^"]*\)".*/\1/p' "$REG" 2>/dev/null | head -1)"
  p="$(sed -n 's/.*"pid": *\([0-9]*\).*/\1/p' "$REG" 2>/dev/null | head -1)"
  echo "${n:-ismeretlen} (pid ${p:-?})"
}

waited=0
until flock -w 5 9; do
  waited=$(( waited + 5 ))
  if (( waited >= WAIT_SEC )); then
    echo "heavy-job: ${NAME}: ${waited} mp-ig nem jott el a soron (most fut: $(holder)), nem inditom el. / queue wait timed out." >&2
    exit 75
  fi
  if (( waited % 30 == 5 )); then
    echo "heavy-job: ${NAME}: varok, most fut: $(holder) (${waited} mp ota). / waiting in the queue." >&2
  fi
done

started="$(date +%s)"
cmd_text="$*"; cmd_text="${cmd_text//\\/\\\\}"; cmd_text="${cmd_text//\"/\\\"}"; cmd_text="${cmd_text:0:300}"
reg_tmp="$REG.$$"
printf '{"name": "%s", "pid": %s, "started": %s, "cmd": "%s"}\n' "$NAME" "$$" "$started" "$cmd_text" >"$reg_tmp" 2>/dev/null \
  && mv -f "$reg_tmp" "$REG" 2>/dev/null || rm -f "$reg_tmp" 2>/dev/null

unreg() {
  # Only remove the registry entry if it is still OURS.
  if sed -n 's/.*"pid": *\([0-9]*\).*/\1/p' "$REG" 2>/dev/null | grep -qx "$$"; then rm -f "$REG" 2>/dev/null; fi
}
child=0
on_term() { (( child > 0 )) && kill -TERM "$child" 2>/dev/null; }
trap on_term TERM INT
trap unreg EXIT

export MARVEEN_HEAVY_JOB_ACTIVE=1
# 9>&- : the job must not inherit the lock fd (see header).
# <&0 : a bare background job would get /dev/null as stdin (heredoc / pipe input).
run_cmd "$@" 9>&- <&0 &
child=$!
wait "$child"; rc=$?
# A trapped signal interrupts the first wait; wait again for the real exit code.
if kill -0 "$child" 2>/dev/null; then wait "$child"; rc=$?; fi
exit "$rc"
