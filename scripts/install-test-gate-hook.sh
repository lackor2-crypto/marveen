#!/usr/bin/env bash
# Idempotent installer: blocks a push to main/master if the pushed commit's
# full test suite (or tsc --noEmit) is not green.
#
# MIERT LETEZIK EZ:
# 2026-08-28-an egy merge (44aa096) ket elavult teszt-regexet vitt fel a
# main-re. A "teljes suite legyen zold landolas elott" addig CSAK szabaly
# volt (FIX_LANDING_POLICY), technikai kikenyszerites nelkul -- csak azert
# derult ki, mert valaki utolag kezzel lefuttatta. Boss dontese (2026-08-28):
# ez ne fordulhasson elo megint, kelljen hozza technikai kapu, ne csak
# fegyelem. Ez a hook pontosan azt a kezi ellenorzest automatizalja, amit
# addig egy agensnek kellett volna mindig eszben tartania.
#
# A puskolt commit-ot egy IDEIGLENES, elkulonitett worktree-be teszi at es
# OTT futtatja a suite-ot -- fuggetlenul attol, hogy a hivo checkout "elo"-
# nek szamit-e (lasd src/__tests__/setup/assert-not-live-install.ts, ami
# a fo /home/boss-szerü checkoutban MINDIG megtagadja a futtatast).
#
# Composes with the shared pre-push.d dispatcher (see install-git-guard-hook.sh).
#
# Kikapcsolas vesztheszet eseten (pl. a kapu maga akadt el):
#   MARVEEN_SKIP_TEST_GATE=1 git push ...
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOOK_DIR="$(cd "$(git -C "$ROOT" rev-parse --git-common-dir)" && pwd)/hooks"
DISPATCH="$HOOK_DIR/pre-push"
GATE="$HOOK_DIR/pre-push.d/20-require-green-suite-main"
MARK="marveen-pre-push-dispatcher"
mkdir -p "$HOOK_DIR/pre-push.d"

# 1. The gate sub-hook: run the full suite (+ tsc) on the pushed commit,
#    in an isolated worktree, before allowing a push to main/master.
cat > "$GATE" <<'EOF'
#!/usr/bin/env bash
set -uo pipefail

if [ "${MARVEEN_SKIP_TEST_GATE:-0}" = "1" ]; then
  echo "pre-push: MARVEEN_SKIP_TEST_GATE=1 -- teszt-kapu kihagyva." >&2
  exit 0
fi

ZERO="0000000000000000000000000000000000000000"
REPO_ROOT="$(git rev-parse --show-toplevel)"

target_sha=""
target_branch=""
while read -r local_ref local_sha remote_ref remote_sha; do
  [ "$local_sha" = "$ZERO" ] && continue   # branch deletion
  case "$remote_ref" in refs/heads/main|refs/heads/master) ;; *) continue ;; esac
  target_sha="$local_sha"
  target_branch="${remote_ref#refs/heads/}"
done

# Nincs main/master push ebben a batch-ben -- a kapunak nincs dolga.
[ -n "$target_sha" ] || exit 0

echo "pre-push: teljes teszt suite + tsc ellenorzese ${target_branch} push elott (commit ${target_sha:0:7})..." >&2

PARENT_DIR="$(mktemp -d)"
TMP_WT="$PARENT_DIR/test-gate-${target_sha:0:12}"
FAIL_LOG="$(mktemp)"
cleanup() {
  rm -f "$FAIL_LOG"
  git -C "$REPO_ROOT" worktree remove --force "$TMP_WT" >/dev/null 2>&1 || true
  rm -rf "$PARENT_DIR"
}
trap cleanup EXIT

if ! git -C "$REPO_ROOT" worktree add --detach "$TMP_WT" "$target_sha" >/dev/null 2>&1; then
  echo "" >&2
  echo "BLOKKOLVA: nem sikerult ideiglenes worktree-t letrehozni a teszteleshez (${target_sha:0:7})." >&2
  echo "Mivel a push nem ellenorizheto, nem engedelyezett. Vesztheszet: MARVEEN_SKIP_TEST_GATE=1 git push ..." >&2
  exit 1
fi

if [ -d "$REPO_ROOT/node_modules" ]; then
  ln -s "$REPO_ROOT/node_modules" "$TMP_WT/node_modules"
fi

if ! (cd "$TMP_WT" && npx tsc --noEmit) >"$FAIL_LOG" 2>&1; then
  echo "" >&2
  echo "BLOKKOLVA: tsc --noEmit NEM tiszta a ${target_branch}-re puskolt commit-on (${target_sha:0:7})." >&2
  echo "" >&2
  tail -60 "$FAIL_LOG" >&2
  echo "" >&2
  echo "Javitsd a hibat, majd probald ujra. Vesztheszet: MARVEEN_SKIP_TEST_GATE=1 git push ..." >&2
  exit 1
fi

if ! (cd "$TMP_WT" && npx vitest run) >"$FAIL_LOG" 2>&1; then
  echo "" >&2
  echo "BLOKKOLVA: a teljes teszt suite NEM zold a ${target_branch}-re puskolt commit-on (${target_sha:0:7})." >&2
  echo "" >&2
  tail -60 "$FAIL_LOG" >&2
  echo "" >&2
  echo "Javitsd a hibat, majd probald ujra. Vesztheszet: MARVEEN_SKIP_TEST_GATE=1 git push ..." >&2
  exit 1
fi

echo "pre-push: teljes teszt suite + tsc zold, push engedelyezve (${target_sha:0:7})." >&2
exit 0
EOF
chmod +x "$GATE"

# 2. Ensure the shared dispatcher exists (idempotent, may already be there
#    from install-git-guard-hook.sh; safe to (re)create with the same marker).
if [ ! -f "$DISPATCH" ] || ! grep -q "$MARK" "$DISPATCH" 2>/dev/null; then
  if [ -f "$DISPATCH" ]; then
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
fi

echo "✓ test-gate: full-suite + tsc push gate for main/master installed."
