#!/usr/bin/env bash
# agent-worktree.sh -- give one agent its own isolated copy of the checkout.
#
# Layer A of kanban 37129602 (Boss, 2026-08-11: "oldjuk meg hogy az agentek ne
# utkozzenek ossze"). Layers B and C (the claim registry and the PreToolUse
# gate) keep two agents off the same file in the LIVE checkout; this one removes
# the sharing entirely for work that deserves it: a git worktree is a second
# working directory on the same repository, with its own branch and its own
# files, so two agents can edit the same file at the same time and the collision
# surfaces at merge -- where git can see it -- instead of as a silent overwrite.
#
# When to use which:
#   - small edit, minutes, one or two files      -> live checkout, layers B+C
#   - a feature, hours, many files, risky        -> a worktree (this script)
#   - anything you want to test before it lands  -> a worktree (the test suite
#     REFUSES to run in a live install anyway)
#
# Usage:
#   scripts/agent-worktree.sh <agent> [branch]      # create/enter
#   scripts/agent-worktree.sh --list                # what exists
#   scripts/agent-worktree.sh --remove <agent>      # clean up when merged
#
# The worktree gets a node_modules symlink so tests run without a second
# install. It is NOT the running instance: nothing you do there affects the live
# dashboard until you merge and rebuild.

set -uo pipefail

BASE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKTREE_ROOT="${MARVEEN_WORKTREE_ROOT:-$BASE/.worktrees}"

usage() {
  sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

list_worktrees() {
  git -C "$BASE" worktree list
}

remove_worktree() {
  local agent="$1"
  local dir="$WORKTREE_ROOT/$agent"
  [ -d "$dir" ] || { echo "Nincs ilyen worktree: $dir" >&2; return 1; }
  # The symlink must go first: `git worktree remove` refuses a dirty tree, and a
  # node_modules symlink counts as an untracked file.
  rm -f "$dir/node_modules"
  git -C "$BASE" worktree remove --force "$dir" || return 1
  echo "Eltavolitva: $dir"
}

case "${1:-}" in
  ''|-h|--help) usage 0 ;;
  --list) list_worktrees; exit 0 ;;
  --remove) [ -n "${2:-}" ] || usage 1; remove_worktree "$2"; exit $? ;;
esac

AGENT="$1"
BRANCH="${2:-work/$AGENT}"
DIR="$WORKTREE_ROOT/$AGENT"

if [ -d "$DIR" ]; then
  echo "Mar letezik: $DIR"
  echo "Branch: $(git -C "$DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"
  exit 0
fi

mkdir -p "$WORKTREE_ROOT"

# An existing branch is checked out; a new one is created from the current HEAD.
if git -C "$BASE" show-ref --verify --quiet "refs/heads/$BRANCH"; then
  git -C "$BASE" worktree add "$DIR" "$BRANCH" || exit 1
else
  git -C "$BASE" worktree add -b "$BRANCH" "$DIR" || exit 1
fi

# Symlink, not a copy: node_modules is ~1 GB and identical.
[ -d "$BASE/node_modules" ] && ln -sfn "$BASE/node_modules" "$DIR/node_modules"

cat <<EOF
Kesz: $DIR  (branch: $BRANCH)

  cd $DIR
  npx vitest run            # a tesztek itt FUTNAK (elo telepitesen nem)
  git add -A && git commit
  cd $BASE && git merge $BRANCH && npm run build   # majd dashboard ujraindit

Ha vegeztel:  scripts/agent-worktree.sh --remove $AGENT
EOF
