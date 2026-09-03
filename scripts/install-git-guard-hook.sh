#!/usr/bin/env bash
# Idempotent installer: protect main/master from force-pushes (history rewrites)
# with a pre-push hook. Auto-run by scripts/sync-hooks.sh on update.
#
# Composes with any existing pre-push hook via a pre-push.d/ dispatcher: each
# executable in pre-push.d/ receives the ref list on stdin and can veto the push.
#
# Override an intentional rewrite of a protected branch:
#   ALLOW_FORCE_PUSH=1 git push ...
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOOK_DIR="$(cd "$(git -C "$ROOT" rev-parse --git-common-dir)" && pwd)/hooks"
DISPATCH="$HOOK_DIR/pre-push"
GUARD="$HOOK_DIR/pre-push.d/10-no-force-push-protected"
MARK="marveen-pre-push-dispatcher"
mkdir -p "$HOOK_DIR/pre-push.d"

# 1. The guard sub-hook: reject a non-fast-forward push to a protected branch.
cat > "$GUARD" <<'EOF'
#!/usr/bin/env bash
# Reject a non-fast-forward (force / rebase / amend) push to a protected branch.
# A normal fast-forward or merge keeps the remote tip as an ancestor of the
# local tip; a rewrite does not. Override: ALLOW_FORCE_PUSH=1 git push ...
set -euo pipefail
ZERO="0000000000000000000000000000000000000000"
fail=0
while read -r local_ref local_sha remote_ref remote_sha; do
  [ "$local_sha" = "$ZERO" ] && continue            # branch deletion
  case "$remote_ref" in refs/heads/main|refs/heads/master) ;; *) continue ;; esac
  [ "$remote_sha" = "$ZERO" ] && continue           # brand-new branch
  if ! git merge-base --is-ancestor "$remote_sha" "$local_sha" 2>/dev/null; then
    if [ "${ALLOW_FORCE_PUSH:-0}" = "1" ]; then
      echo "pre-push: ALLOW_FORCE_PUSH=1 set; permitting force-push to ${remote_ref#refs/heads/}." >&2
    else
      echo "" >&2
      echo "BLOCKED: non-fast-forward (force) push to ${remote_ref#refs/heads/}." >&2
      echo "This rewrites shared history. If truly intended: ALLOW_FORCE_PUSH=1 git push ..." >&2
      fail=1
    fi
  fi
done
exit $fail
EOF
chmod +x "$GUARD"

# 1b. Second guard: never push to the `upstream` remote.
#
# `upstream` is the ORIGINAL project this install was forked from. We only ever
# pull FROM it. Git does not know that, and "upstream" is one typo away from
# the remote you actually use -- so an accidental `git push upstream main`
# would aim your work at someone else's project.
#
# On a fresh install with no `upstream` remote this guard is simply never
# triggered: it stays silent rather than reporting anything.
#
# Measured, and worth knowing: setting the remote's PUSH url to a dead address
# does NOT compose with this hook. Git resolves the transport and contacts the
# remote BEFORE running pre-push, so a dead push url makes the push fail with
# git's own opaque error and this guard never gets to speak. So we do not set
# one -- a hook that explains itself is worth more than a second silent wall.
#
# This lives in local git config: it guards against ACCIDENT, not intent
# (--no-verify steps over it). The unbreakable lock is simply not having write
# access to the upstream repo -- which is already the case.
UPSTREAM_GUARD="$HOOK_DIR/pre-push.d/30-upstream-readonly"
cat > "$UPSTREAM_GUARD" <<'EOF'
#!/usr/bin/env bash
# Refuse any push aimed at the `upstream` remote. See install-git-guard-hook.sh.
set -uo pipefail
REMOTE_NAME="${1:-}"
REMOTE_URL="${2:-}"
# Do not rely on the name alone: the url is telling too, in case the same repo
# was added under a different remote name.
UPSTREAM_URL="$(git remote get-url upstream 2>/dev/null || true)"
BLOCK=0
[ "${REMOTE_NAME}" = "upstream" ] && BLOCK=1
if [ -n "${UPSTREAM_URL}" ] && [ -n "${REMOTE_URL}" ] && [ "${REMOTE_URL}" = "${UPSTREAM_URL}" ]; then
  BLOCK=1
fi
if [ "${BLOCK}" -eq 1 ]; then
  cat >&2 <<MSG

  BLOCKED: this push is aimed at the UPSTREAM repository.

     remote : ${REMOTE_NAME}
     url    : ${REMOTE_URL:-${UPSTREAM_URL}}

     Upstream is the original project this one was forked from. We pull from
     it; pushing to it is not ours to do.

     You most likely meant to land on your OWN fork. Note: a direct push to
     origin main is blocked too now (branch protection + the local test-gate).
     The official way to land is a PR that the CI gates:

         scripts/land-pr.sh "commit cim"   # branch -> PR -> CI zold -> merge

     If you really do have something for upstream, the way to offer it is a
     pull request on GitHub, not a direct push.

MSG
  exit 1
fi
exit 0
EOF
chmod +x "$UPSTREAM_GUARD"

# 2. Dispatcher pre-push: replay stdin (the ref list) to every pre-push.d/* hook.
if [ -f "$DISPATCH" ] && ! grep -q "$MARK" "$DISPATCH" 2>/dev/null; then
  # Preserve a pre-existing, non-dispatcher pre-push by moving it under pre-push.d.
  mv "$DISPATCH" "$HOOK_DIR/pre-push.d/00-existing-prepush"
  chmod +x "$HOOK_DIR/pre-push.d/00-existing-prepush"
  echo "  (preserved existing pre-push as pre-push.d/00-existing-prepush)"
fi
cat > "$DISPATCH" <<EOF
#!/usr/bin/env bash
# $MARK : run every executable in pre-push.d/, passing the ref list to each.
set -euo pipefail
HOOK_DIR="\$(cd "\$(dirname "\$0")" && pwd)"
payload="\$(cat)"
status=0
for h in "\$HOOK_DIR"/pre-push.d/*; do
  [ -x "\$h" ] || continue
  printf '%s\n' "\$payload" | "\$h" "\$@" || status=1
done
exit \$status
EOF
chmod +x "$DISPATCH"

echo "✓ git-guard: force-push protection for main/master installed."
echo "✓ git-guard: pushing to the upstream remote is refused."
