#!/usr/bin/env bash
# deploy-live.sh
#
# Closes the "landed code never reaches the running app" gap (kanban 3b92bbec).
#
# The fleet lands work to origin/main via PRs (scripts/land-pr.sh). But the
# dashboard runs from the checkout at PROJECT_ROOT (dist/index.js), and nothing
# pulled origin/main onto that disk or rebuilt dist/. On 2026-09-04 this meant a
# full day of merged work (#8, #9, #10/#169, #11, #207) sat in git while the
# service ran a build from 2026-09-03 04:27. Symptom was silent: git HEAD looked
# current, the app did not.
#
# This guard is the missing "deploy" step, run on a timer: fetch origin/main,
# and IF it advanced past what is materialized on disk (or dist/ is older than
# the sources), materialize the new tree, rebuild, and restart the dashboard
# through systemd -- then verify the app actually answers.
#
# Deliberately conservative, in the spirit of dashboard-health-guard.sh:
#   - Never touches the working tree if it has LOCAL edits to tracked files:
#     a hand-fix in the live checkout is work, not garbage, and must not be
#     clobbered by an automatic pull. It logs loudly and skips instead.
#   - Only ever fast-forwards to origin/main. It does not merge, rebase, force,
#     or move to any other ref.
#   - Builds BEFORE restarting. A broken build leaves the old, working dist/ and
#     the running service untouched -- a bad commit cannot take the app down.
#   - Single-flight (flock): overlapping timer ticks, or a tick during a manual
#     deploy, wait out or skip rather than racing.
#   - "Zero" is two different things and it tells them apart: a fetch that FAILS
#     (offline, auth) is logged as "could not see upstream -- NOT up to date",
#     never as "nothing to deploy".
#   - Topology-agnostic: works whether PROJECT_ROOT is a normal checkout (fresh
#     install) or a bare repo that hosts .worktrees/ (this host's setup).
#   - Always exits 0 under the timer, so a transient hiccup does not park the
#     unit in `failed` and silence future deploys. Real failures are logged and
#     best-effort alerted, not swallowed by a dead unit.
#
# Kill switch: MARVEEN_AUTO_DEPLOY=0 disables it (the guard logs and exits 0).

set -uo pipefail

BASE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Read the install's own identity, never the author's (host-agnostic rule).
env_val() { sed -n "s/^$1=//p" "$BASE/.env" 2>/dev/null | tail -1 | tr -d '"'"'"'\r'; }

# PROJECT_ROOT is the checkout the SERVICE runs from. On this host that is the
# bare-repo top level; .env may point elsewhere on another install. Default to
# this script's repo root, which is correct for a normal checkout.
ROOT="${MARVEEN_PROJECT_ROOT:-$(env_val PROJECT_ROOT)}"
[ -n "$ROOT" ] && [ -d "$ROOT/.git" ] || ROOT="$BASE"
GIT_DIR="$ROOT/.git"

SERVICE_ID="${SERVICE_ID:-$(env_val SERVICE_ID)}"
[ -n "$SERVICE_ID" ] || SERVICE_ID="$(env_val MAIN_AGENT_ID)"
[ -n "$SERVICE_ID" ] || SERVICE_ID="marveen"

PORT="${WEB_PORT:-$(env_val WEB_PORT)}"
PORT="${PORT:-3420}"
URL="http://localhost:${PORT}/"
UNIT="${SERVICE_ID}-dashboard.service"

STATE_DIR="${MARVEEN_STORE:-$ROOT/store}"
LOG="$STATE_DIR/deploy.log"
SHA_FILE="$STATE_DIR/.deployed-sha"
LOCK="$STATE_DIR/deploy.lock"
BRANCH="main"
# Overridable only so the test suite can drive the health loop fast; production
# uses the defaults (20 tries x 2s = up to ~40s for a slow restart to answer).
HTTP_WAIT_TRIES="${MARVEEN_DEPLOY_HTTP_TRIES:-20}"
HTTP_WAIT_GAP="${MARVEEN_DEPLOY_HTTP_GAP:-2}"

mkdir -p "$STATE_DIR" 2>/dev/null || true
log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$1" >> "$LOG" 2>/dev/null || true; }

# Best-effort alert on a real deploy failure: always logs, and tries to hand the
# message to the main agent via the local dashboard so it reaches the owner on
# their channel. Never fatal -- if the dashboard is down (the very case we might
# be alerting about), the log line is the durable record.
alert() {
  local msg="$1"
  log "ALERT: $msg"
  local token
  token="$(cat "$STATE_DIR/.dashboard-token" 2>/dev/null || true)"
  [ -n "$token" ] || return 0
  curl -s -o /dev/null --max-time 8 -X POST "http://localhost:${PORT}/api/messages" \
    -H "Content-Type: application/json" -H "Authorization: Bearer $token" \
    -d "$(printf '{"from":"%s","to":"%s","content":"[DEPLOY] %s"}' "$SERVICE_ID" "$SERVICE_ID" "$msg")" \
    2>/dev/null || true
}

if [ "${MARVEEN_AUTO_DEPLOY:-1}" = "0" ]; then
  log "MARVEEN_AUTO_DEPLOY=0 -- auto-deploy disabled, skipping."
  exit 0
fi

git_root() { git --git-dir="$GIT_DIR" --work-tree="$ROOT" -c core.bare=false "$@"; }

# Single-flight. If another deploy (or a manual one) holds the lock, skip this
# tick quietly -- the next tick will pick up any newer main.
exec 9>"$LOCK" 2>/dev/null || { log "cannot open lock $LOCK -- skipping"; exit 0; }
if ! flock -n 9; then
  log "another deploy holds the lock -- skipping this tick."
  exit 0
fi

# --- 1. See upstream. A failed fetch is NOT "up to date". -------------------
if ! git --git-dir="$GIT_DIR" fetch --quiet origin "$BRANCH" 2>>"$LOG"; then
  log "could not fetch origin/$BRANCH (offline/auth?) -- NOT deploying, and NOT assuming up to date."
  exit 0
fi

TARGET="$(git --git-dir="$GIT_DIR" rev-parse "origin/$BRANCH" 2>/dev/null)"
if [ -z "$TARGET" ]; then
  log "origin/$BRANCH did not resolve -- skipping."
  exit 0
fi
SHORT="$(git --git-dir="$GIT_DIR" rev-parse --short "$TARGET" 2>/dev/null)"

DEPLOYED="$(cat "$SHA_FILE" 2>/dev/null || true)"

# What is physically materialized on disk right now? (Diff the work tree against
# the target; empty means the files already are the target.)
TREE_DIFF="$(git_root diff --name-only "$TARGET" -- . 2>/dev/null | head -1)"

# dist/ staleness: any tracked *.ts newer than dist/index.js means a rebuild is
# due even if the tree already matches (e.g. a materialize happened without a
# build, exactly the incident this guard was written for).
NEED_BUILD=0
if [ ! -f "$ROOT/dist/index.js" ]; then
  NEED_BUILD=1
elif [ -n "$(find "$ROOT/src" -name '*.ts' -newer "$ROOT/dist/index.js" -print -quit 2>/dev/null)" ]; then
  NEED_BUILD=1
fi

# --- Nothing to build or restart? -------------------------------------------
# If the disk already matches origin/main AND dist/ is fresh, the running app is
# current -- do not restart it. Just record the baseline sha (so a first run, or
# one after a manual deploy like this host's, does not churn on the next tick).
if [ -z "$TREE_DIFF" ] && [ "$NEED_BUILD" = "0" ]; then
  if [ "$TARGET" != "$DEPLOYED" ]; then
    printf '%s\n' "$TARGET" > "$SHA_FILE" 2>/dev/null || true
    log "already current at $SHORT (disk matches origin/main, dist fresh) -- recorded baseline, no restart."
  fi
  exit 0
fi

# --- 2. Never clobber a local hand-edit of a TRACKED file. ------------------
# We compare the work tree against the LAST DEPLOYED sha (what we put there). If
# it differs from that by anything other than moving toward TARGET, someone
# edited the live checkout by hand -- stop and let a human sort it out.
#
# First run, or a lost/missing .deployed-sha: we have NO recorded baseline, so
# the STRAY check below has nothing to compare against and would materialize
# unconditionally -- silently dropping any hand-edit of a tracked file. But we
# must NOT simply refuse whenever the tree differs from origin/main either: a
# STALE install differs by definition, and refusing there is exactly the
# incident this guard exists to fix (a tree that is a clean materialization of
# an OLDER commit must still deploy). So distinguish stale from hand-edited:
# find the most recent commit (within the last 20 of origin/main) that the work
# tree is a CLEAN materialization of, and adopt it as the baseline. If the tree
# matches no known commit, it carries genuine local edits -> stop for a manual
# bootstrap rather than clobber them.
if [ -z "$DEPLOYED" ]; then
  BASELINE=""
  for c in $(git --git-dir="$GIT_DIR" rev-list --max-count=20 "origin/$BRANCH" 2>/dev/null); do
    if [ -z "$(git_root diff --name-only "$c" -- . 2>/dev/null | head -1)" ]; then
      BASELINE="$c"; break
    fi
  done
  if [ -n "$BASELINE" ]; then
    DEPLOYED="$BASELINE"
    log "no .deployed-sha -- work tree is a clean materialization of $(git --git-dir="$GIT_DIR" rev-parse --short "$BASELINE" 2>/dev/null), adopting it as baseline for the hand-edit check."
  else
    log "no .deployed-sha and the work tree is not a clean materialization of any of the last 20 origin/$BRANCH commits -- likely a hand-edited/bootstrap checkout, NOT auto-deploying. Land or revert by hand first."
    alert "Marveen deploy: nincs .deployed-sha es a fa egyetlen ismert commitnak sem tiszta materializacioja -- kezi bootstrap kell, nem deployolok. store/deploy.log."
    exit 0
  fi
fi

if [ -n "$DEPLOYED" ]; then
  LOCAL_EDITS="$(git_root diff --name-only "$DEPLOYED" -- . 2>/dev/null)"
  # Files that legitimately change between DEPLOYED and TARGET:
  FORWARD="$(git --git-dir="$GIT_DIR" diff --name-only "$DEPLOYED" "$TARGET" 2>/dev/null)"
  STRAY="$(comm -23 <(printf '%s\n' "$LOCAL_EDITS" | sort -u) <(printf '%s\n' "$FORWARD" | sort -u) | grep -v '^$' || true)"
  if [ -n "$STRAY" ]; then
    log "REFUSING to deploy: the live checkout has local edits to tracked files not part of $DEPLOYED..$SHORT:"
    printf '%s\n' "$STRAY" | while read -r f; do [ -n "$f" ] && log "    local-edit: $f"; done
    log "    -> commit/land or revert these by hand, then the next tick will deploy. (No auto-clobber.)"
    exit 0
  fi
fi

# --- 3. Materialize origin/main onto the live checkout. ---------------------
IS_BARE="$(git --git-dir="$GIT_DIR" config --get core.bare 2>/dev/null || echo false)"
log "deploying $DEPLOYED..$SHORT (bare=$IS_BARE, tree_diff=$([ -n "$TREE_DIFF" ] && echo yes || echo no), need_build=$NEED_BUILD)"

if [ "$IS_BARE" = "true" ]; then
  # Bare top-level that hosts .worktrees/: flipping core.bare would evict the
  # worktree that sits on main. Instead materialize the tree in place with
  # plumbing -- read-tree -u --reset makes the work tree exactly match TARGET,
  # including deletions, and resets the index, without moving a symbolic HEAD.
  if ! git --git-dir="$GIT_DIR" --work-tree="$ROOT" read-tree -u --reset "$TARGET" 2>>"$LOG"; then
    log "read-tree materialize FAILED -- aborting before build/restart (old build stays live)."
    exit 0
  fi
else
  # Normal checkout (e.g. a fresh install): fast-forward hard to origin/main.
  if ! git --git-dir="$GIT_DIR" --work-tree="$ROOT" reset --hard "$TARGET" 2>>"$LOG"; then
    log "reset --hard FAILED -- aborting before build/restart (old build stays live)."
    exit 0
  fi
fi

# --- 4. Build BEFORE restart. A broken build must not take the app down. ----
# Build and restart commands are overridable so tests can exercise the git and
# decision logic without npm/systemd; the defaults are the real thing.
BUILD_CMD="${MARVEEN_DEPLOY_BUILD_CMD:-npm run build}"
RESTART_CMD="${MARVEEN_DEPLOY_RESTART_CMD:-systemctl --user restart "$UNIT"}"
if ! ( cd "$ROOT" && bash -c "$BUILD_CMD" ) >>"$LOG" 2>&1; then
  log "BUILD FAILED for $SHORT -- NOT restarting; the previous working dist/ stays live."
  alert "Marveen deploy: build failed a(z) $SHORT commitnal, a regi build fut tovabb. Nezd meg: store/deploy.log."
  exit 0
fi

# Record the sha only after a successful build+materialize, so a failed tick
# retries next time instead of marking a half-deploy as done.
printf '%s\n' "$TARGET" > "$SHA_FILE" 2>/dev/null || true

# --- 5. Restart through systemd (never a hand-rolled node process). ---------
if ! bash -c "$RESTART_CMD" 2>>"$LOG"; then
  log "restart FAILED for $SHORT ($RESTART_CMD)."
  alert "Marveen deploy: a $UNIT ujrainditasa nem sikerult ($SHORT). store/deploy.log."
  exit 0
fi

# --- 6. Verify the app actually came back. ----------------------------------
if [ "${MARVEEN_DEPLOY_SKIP_HEALTH:-0}" = "1" ]; then
  log "DEPLOYED $SHORT (health check skipped by MARVEEN_DEPLOY_SKIP_HEALTH)."
  exit 0
fi
ok=0
for i in $(seq 1 "$HTTP_WAIT_TRIES"); do
  # The assignment's exit status is curl's, so `|| code=000` fires exactly on a
  # curl failure -- and overwrites, rather than appends to, the "000" curl
  # already printed for a refused connection (the old `|| echo 000` produced
  # "000000", which is != "000", so ok=1 on the first tick and the health check
  # never actually verified: store/deploy.log said "HTTP 000000"). Only a real
  # HTTP answer counts as up: 2xx/3xx, plus 401/403 because a password-protected
  # dashboard answers with those.
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$URL" 2>/dev/null)" || code=000
  case "$code" in 2*|3*|401|403) ok=1; break;; esac
  sleep "$HTTP_WAIT_GAP"
done

if [ "$ok" = "1" ]; then
  log "DEPLOYED $SHORT live (HTTP $code, $UNIT restarted)."
else
  log "deployed $SHORT but the dashboard is NOT answering after restart -- dashboard-health-guard will keep trying."
  alert "Marveen deploy: $SHORT kikerult, de a dashboard nem valaszol az ujrainditas utan. store/deploy.log."
fi

exit 0
