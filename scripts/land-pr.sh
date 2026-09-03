#!/usr/bin/env bash
# land-pr.sh -- Land the current worktree's commits to main via a GitHub PR
# that the CI (.github/workflows/ci.yml) gates.
#
# MIERT (2026-09-03, Boss dontese "A", kartya 61a83b22):
# A teljes teszt-suite egy pre-push hookban ANTI-PATTERN -- a terhelt fejlesztoi/
# flotta-gepen a parhuzamos subprocessek miatt rendszertelenul bukott (30-34/435),
# holott a tartalom izolaltan 435/435 zold. A teljes suite helye a CI: tiszta,
# dedikalt ubuntu runneren, Node 20 ES 22, ~2 perc, flakyseg NELKUL.
#
# Ez a landolas UJ, HIVATALOS utja: nem direktben pusholunk a main-re, hanem
# felnyomunk egy branchet, PR-t nyitunk, MEGVARJUK amig a CI zold, es CSAK akkor
# merge-elunk. Igy egy rossz commit sosem kerul a main-re a teljes suite nelkul.
# A lokalis pre-push kapu (install-test-gate-hook.sh) kozben gyorsan lefut
# (tsc + syntax-check) a branch push-nal is -- azonnali elore-jelzes.
#
# Hasznalat (egy git worktree-bol, a landolando commitokkal a HEAD-en):
#   scripts/land-pr.sh "PR cim" ["PR leiras"]
#   scripts/land-pr.sh --branch <branch-nev> "PR cim" ["PR leiras"]
#   scripts/land-pr.sh --no-merge "PR cim"     # csak PR-t nyit, nem merge-el
#
# Kovetelmeny: `gh` CLI bejelentkezve a push-fiokkal (GITHUB_PUSH_ACCOUNT),
# es az `origin` remote a valodi repora mutat. A script host-agnosztikus:
# a repot az origin-bol, a fiokot a .env GITHUB_PUSH_ACCOUNT-bol olvassa.
set -euo pipefail

BASE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

die() { echo "land-pr: HIBA -- $*" >&2; exit 1; }

# --- argumentumok --------------------------------------------------------------
BRANCH=""
DO_MERGE=1
TITLE=""
BODY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --branch) BRANCH="${2:-}"; shift 2 ;;
    --no-merge) DO_MERGE=0; shift ;;
    -h|--help) sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) if [ -z "$TITLE" ]; then TITLE="$1"; elif [ -z "$BODY" ]; then BODY="$1"; fi; shift ;;
  esac
done
[ -n "$TITLE" ] || die "adj meg egy PR cimet. Pl: scripts/land-pr.sh \"fix(x): ...\""

# --- kornyezet ellenorzese -----------------------------------------------------
command -v gh >/dev/null 2>&1 || die "a 'gh' CLI nincs telepitve."
# Melyik worktree-bol futunk? (a bare top-level nem jo -- ott nincs HEAD)
TOPLEVEL="$(git rev-parse --show-toplevel 2>/dev/null)" \
  || die "ezt egy git worktree-bol futtasd (nem a bare repobol). Lasd scripts/agent-worktree.sh."

# A cel-repo az origin-bol (host-agnosztikus). FONTOS: a repo egy FORK, ezert a
# `gh` alapbol az UPSTREAM-re nyitna PR-t -- minden gh hivasnal explicit -R kell.
ORIGIN_URL="$(git remote get-url origin 2>/dev/null || true)"
REPO="$(printf '%s' "$ORIGIN_URL" | sed -E 's#^(https://[^/]+/|git@[^:]+:)##; s#\.git$##')"
case "$REPO" in */*) : ;; *) die "nem sikerult a repot kiolvasni az origin-bol ('$ORIGIN_URL')." ;; esac

# A landolando commitok a HEAD-en. Ha a HEAD == origin/main, nincs mit landolni.
git fetch -q origin main || die "nem sikerult fetch-elni az origin/main-t."
AHEAD="$(git rev-list --count origin/main..HEAD 2>/dev/null || echo 0)"
[ "$AHEAD" -gt 0 ] || die "a HEAD nincs elorebb az origin/main-nal -- nincs mit landolni."

# Branch nev: ha nem adtak meg, generalunk egyet a HEAD-bol.
if [ -z "$BRANCH" ]; then
  CUR="$(git symbolic-ref --quiet --short HEAD 2>/dev/null || echo '')"
  if [ -n "$CUR" ] && [ "$CUR" != "main" ] && [ "$CUR" != "master" ]; then
    BRANCH="$CUR"
  else
    BRANCH="land/$(date +%Y%m%d-%H%M%S)-$(git rev-parse --short HEAD)"
  fi
fi

echo "land-pr: branch='$BRANCH'  cim='$TITLE'  (HEAD $AHEAD commit-tal elorebb az origin/main-nal)" >&2

# --- 1. branch felnyomasa (a gyors pre-push kapu itt fut le) --------------------
git push -u origin "HEAD:refs/heads/$BRANCH" || die "a branch push nem sikerult (lasd a fenti kimenetet)."

# --- 2. PR nyitasa (vagy meglevo ujrahasznalasa) -------------------------------
PR_URL="$(gh pr list -R "$REPO" --head "$BRANCH" --base main --state open --json url --jq '.[0].url' 2>/dev/null || true)"
if [ -z "$PR_URL" ]; then
  PR_URL="$(gh pr create -R "$REPO" --base main --head "$BRANCH" --title "$TITLE" --body "${BODY:-$TITLE}" 2>&1)" \
    || die "a PR nyitasa nem sikerult: $PR_URL"
fi
echo "land-pr: PR -> $PR_URL" >&2

if [ "$DO_MERGE" -eq 0 ]; then
  echo "land-pr: --no-merge: a PR nyitva marad, a CI most fut. Merge kesobb: gh pr merge $PR_URL --squash" >&2
  exit 0
fi

# --- 3. CI bevarasa ------------------------------------------------------------
# A `gh pr checks --watch` megbizhatatlan: ha a checkek meg nem regisztraltak
# (nehany masodperc keses a PR-nyitas utan), "no checks reported"-tel azonnal
# elszall. Ezert a statusCheckRollup-ot POLL-ozzuk, ami determinisztikus.
echo "land-pr: varakozas a CI-re (ez ~2-3 perc)..." >&2
deadline=$(( $(date +%s) + 900 ))   # max 15 perc
while true; do
  roll="$(gh pr view "$PR_URL" -R "$REPO" --json statusCheckRollup --jq '.statusCheckRollup' 2>/dev/null || echo '[]')"
  verdict="$(printf '%s' "$roll" | python3 -c '
import sys, json
try: d = json.load(sys.stdin)
except Exception: d = []
if not d: print("EMPTY"); sys.exit()
pend = fail = 0
for c in d:
    st = (c.get("status") or "").upper()          # QUEUED / IN_PROGRESS / COMPLETED
    con = (c.get("conclusion") or "").upper()      # SUCCESS / FAILURE / ...
    if st != "COMPLETED": pend += 1
    elif con not in ("SUCCESS", "NEUTRAL", "SKIPPED"): fail += 1
print("FAIL" if fail else ("PENDING" if pend else "PASS"))
' 2>/dev/null || echo EMPTY)"
  case "$verdict" in
    PASS) echo "land-pr: a CI zold." >&2; break ;;
    FAIL) die "a CI NEM zold ezen a PR-en. A PR nyitva marad: $PR_URL -- javitsd a hibat es pushold ujra a branchet." ;;
    *) : ;;  # EMPTY (meg nincs check) vagy PENDING -> varunk tovabb
  esac
  [ "$(date +%s)" -ge "$deadline" ] && die "a CI nem fejezodott be idoben (~15 perc): $PR_URL"
  sleep 15
done

# --- 4. merge zold CI utan -----------------------------------------------------
gh pr merge "$PR_URL" --squash --delete-branch \
  || die "a merge nem sikerult (talan branch protection / jogosultsag). PR: $PR_URL"
echo "land-pr: MERGE-ELVE es a branch torolve. PR: $PR_URL" >&2

# --- 5. lokalis main frissitese ------------------------------------------------
git fetch -q origin main && echo "land-pr: origin/main = $(git rev-parse --short origin/main). Frissitsd a lokalis checkoutod, ha kell." >&2
echo "land-pr: KESZ." >&2
