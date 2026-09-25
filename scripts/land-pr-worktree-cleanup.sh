#!/usr/bin/env bash
# land-pr-worktree-cleanup.sh -- remove the worktree a PR was just landed from.
#
# Called by scripts/land-pr.sh as its last step, AFTER the PR's state was read
# back as MERGED (kanban #384, Boss 2026-09-25: "ha keszen vagy akkor torlesnek
# automatikusnak kellene lennie. minden agentnel."). Before this, landed
# worktrees stayed behind and the wake-up reminder told every agent to ask
# before removing them -- one agent collected four in a single day.
#
# Usage (from inside the worktree):  land-pr-worktree-cleanup.sh <pushed-sha>
#
# Removes ONLY when nothing can be lost:
#   - this is a linked worktree, never the main checkout,
#   - it sits directly under the worktree root (MARVEEN_WORKTREE_ROOT or
#     <checkout>/.worktrees) -- i.e. agent-worktree.sh / code-bridge made it,
#   - HEAD is still the commit that was pushed (no new commit during the CI wait),
#   - the tree is clean, untracked files included (the node_modules symlink the
#     worktree scripts create does not count).
# Otherwise it says WHY it kept the worktree and exits 0. The local branch goes
# too when its tip is the landed commit: land-pr squash-merges, so a surviving
# branch would be checked out again by the next `agent-worktree.sh <name>`
# instead of a fresh one from main.
#
# Never fails the landing: every outcome exits 0; the message is the result.

set -uo pipefail

PUSHED_SHA="${1:-}"
say() { echo "land-pr: $*" >&2; }

[ -n "$PUSHED_SHA" ] || { say "a worktree-t NEM toroltem: nem kaptam meg a felnyomott commitot."; exit 0; }

real() { (cd "$1" 2>/dev/null && pwd -P) || true; }

WT_DIR="$(git rev-parse --show-toplevel 2>/dev/null || true)"
GIT_DIR_ABS="$(real "$(git rev-parse --git-dir 2>/dev/null || echo /nonexistent)")"
COMMON_ABS="$(real "$(git rev-parse --git-common-dir 2>/dev/null || echo /nonexistent)")"
OWNER_ROOT="$(dirname "${COMMON_ABS:-/}")"
WT_ROOT="$(real "${MARVEEN_WORKTREE_ROOT:-$OWNER_ROOT/.worktrees}")"
WT_REAL="$(real "${WT_DIR:-/nonexistent}")"

keep_why=""
if [ -z "$WT_REAL" ] || [ -z "$GIT_DIR_ABS" ] || [ "$GIT_DIR_ABS" = "$COMMON_ABS" ]; then
  keep_why="ez nem egy kulon worktree (a fo checkoutot sosem torlom)"
elif [ -z "$WT_ROOT" ] || [ "$(dirname "$WT_REAL")" != "$WT_ROOT" ]; then
  keep_why="nem a worktree-gyoker (${WT_ROOT:-?}) kozvetlen almappaja, igy nem egy agens-worktree"
elif [ "$(git rev-parse HEAD 2>/dev/null)" != "$PUSHED_SHA" ]; then
  keep_why="a HEAD elmozdult a felnyomott commit ota -- uj, nem landolt commit van rajta"
else
  st="$(git status --porcelain --untracked-files=all 2>&1)"
  st_rc=$?
  if [ "$st_rc" -ne 0 ]; then
    # Could not look: that is not "clean".
    keep_why="nem tudtam megnezni, tiszta-e (git status exit $st_rc): $st"
  else
    dirty="$(printf '%s\n' "$st" | grep -v -e '^?? node_modules$' -e '^$' || true)"
    [ -n "$dirty" ] && keep_why="commitolatlan valtozas van benne: $(printf '%s' "$dirty" | head -n 3 | tr '\n' ';')"
  fi
fi

if [ -n "$keep_why" ]; then
  say "a worktree-t NEM toroltem (${WT_DIR:-?}): $keep_why"
  exit 0
fi

LOCAL_BRANCH="$(git symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
cd "$OWNER_ROOT" 2>/dev/null || cd /
link_was=0
if [ -L "$WT_REAL/node_modules" ]; then rm -f "$WT_REAL/node_modules"; link_was=1; fi
rm_out="$(git -C "$OWNER_ROOT" worktree remove "$WT_REAL" 2>&1)"
rm_rc=$?
if [ "$rm_rc" -ne 0 ]; then
  [ "$link_was" = 1 ] && [ -d "$OWNER_ROOT/node_modules" ] && ln -sfn "$OWNER_ROOT/node_modules" "$WT_REAL/node_modules"
  say "a worktree-t nem sikerult torolni (exit $rm_rc): $rm_out -- a landolast ez nem befolyasolja."
  exit 0
fi
say "a landolt worktree torolve: $WT_REAL"
if [ -n "$LOCAL_BRANCH" ] && [ "$LOCAL_BRANCH" != "main" ] && [ "$LOCAL_BRANCH" != "master" ] \
  && [ "$(git -C "$OWNER_ROOT" rev-parse --verify -q "refs/heads/$LOCAL_BRANCH" 2>/dev/null)" = "$PUSHED_SHA" ]; then
  if git -C "$OWNER_ROOT" branch -D "$LOCAL_BRANCH" >/dev/null 2>&1; then
    say "a lokalis '$LOCAL_BRANCH' branch is torolve (a tartalma a mainen van)."
  else
    say "a lokalis '$LOCAL_BRANCH' branchet nem sikerult torolni -- a kovetkezo agent-worktree.sh a regi agat huzna vissza: git branch -D $LOCAL_BRANCH"
  fi
fi
say "a shelled munkakonyvtara megszunt -- lepj ki: cd $OWNER_ROOT"
exit 0
