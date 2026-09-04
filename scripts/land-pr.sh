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
# A main-re a direkt push amugy sem menne at: a branch protection required
# checkje a `ci-passed`, es az enforce_admins be van kapcsolva.
#
# A lokalis pre-push kapu (install-test-gate-hook.sh) csak a KOZVETLEN main/master
# push-nal fut (tsc + syntax-check); a land-pr egy FEATURE branchet pushol, azt a
# kapu ATENGEDI. Ezert a gyors tipushiba-ellenorzest a land-pr MAGA futtatja le a
# branch push ELOTT -- a HEAD-rol nyitott IZOLALT worktree-ben, tehat pontosan azt
# meri, ami felmegy, nem a (esetleg piszkos) munkafat. A TELJES suite-ot a CI meri.
#
# Hasznalat (egy git worktree-bol, a landolando commitokkal a HEAD-en):
#   scripts/land-pr.sh "PR cim" ["PR leiras"]
#   scripts/land-pr.sh --branch <branch-nev> "PR cim" ["PR leiras"]
#   scripts/land-pr.sh --no-merge "PR cim"     # csak PR-t nyit, nem merge-el
#
# Kornyezeti valtozok (opcionalis):
#   LAND_PR_CI_WAIT_MAX   -- meddig varjunk a CI-re, masodpercben (alap: 1500)
#   LAND_PR_EMPTY_GRACE   -- ures rollup tureshatara, masodpercben (alap: 120)
#
# Kovetelmeny: `gh` CLI bejelentkezve a push-fiokkal (GITHUB_PUSH_ACCOUNT),
# `node` es telepitett node_modules, es az `origin` remote a valodi repora
# mutat. A script host-agnosztikus: a repot az origin-bol olvassa ki.
set -euo pipefail

BASE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CI_VERDICT="$BASE/scripts/lib/ci-verdict.mjs"

die() { echo "land-pr: HIBA -- $*" >&2; exit 1; }

# Az izolalt tipusellenorzo worktree takaritasa (a trap minden kilepesi uton fut).
TSC_TMP=""
cleanup() {
  if [ -n "$TSC_TMP" ]; then
    git worktree remove --force "$TSC_TMP/wt" >/dev/null 2>&1 || true
    rm -rf "$TSC_TMP"
    TSC_TMP=""
  fi
}
trap cleanup EXIT

# --- argumentumok --------------------------------------------------------------
BRANCH=""
DO_MERGE=1
TITLE=""
BODY=""
while [ $# -gt 0 ]; do
  case "$1" in
    # A `shift 2` hianyzo argumentummal `set -e` alatt NEMA kilepes lenne (exit 1,
    # semmilyen uzenet nelkul), ezert eloszor ellenorzunk.
    --branch)
      [ $# -ge 2 ] && [ -n "${2:-}" ] || die "a --branch utan add meg a branch nevet is."
      BRANCH="$2"; shift 2 ;;
    --no-merge) DO_MERGE=0; shift ;;
    # A fejlec-kommentet az ELSO nem-komment sorig irjuk ki. Fix sorszammal
    # (`sed -n '2,33p'`) a sugo nemán csonkul, amint a fejlec egy sorral no.
    -h|--help) awk 'NR>1 { if (!/^#/) exit; sub(/^# ?/, ""); print }' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) if [ -z "$TITLE" ]; then TITLE="$1"; elif [ -z "$BODY" ]; then BODY="$1"; fi; shift ;;
  esac
done
[ -n "$TITLE" ] || die "adj meg egy PR cimet. Pl: scripts/land-pr.sh \"fix(x): ...\""

# --- kornyezet ellenorzese -----------------------------------------------------
command -v gh >/dev/null 2>&1 || die "a 'gh' CLI nincs telepitve."
command -v node >/dev/null 2>&1 || die "a 'node' nincs telepitve -- a CI-allapot ertelmezesehez kell."
[ -f "$CI_VERDICT" ] || die "hianyzik a CI-verdikt parser: $CI_VERDICT"

# Melyik worktree-bol futunk? (a bare top-level nem jo -- ott nincs HEAD)
git rev-parse --show-toplevel >/dev/null 2>&1 \
  || die "ezt egy git worktree-bol futtasd (nem a bare repobol). Lasd scripts/agent-worktree.sh."

# A cel-repo az origin-bol (host-agnosztikus). FONTOS: a repo egy FORK, ezert a
# `gh` alapbol az UPSTREAM-re nyitna PR-t -- minden gh hivasnal explicit -R kell.
ORIGIN_URL="$(git remote get-url origin 2>/dev/null || true)"
# Harom remote-sema: https://host/owner/repo(.git), git@host:owner/repo(.git),
# es ssh://git@host/owner/repo(.git). Az utolsonal a "ssh://<user@host>/" prefixet
# vagjuk le (a [^/]+ elnyeli a "git@host" reszt, mert abban nincs '/').
REPO="$(printf '%s' "$ORIGIN_URL" | sed -E 's#^(https?://[^/]+/|ssh://[^/]+/|git@[^:]+:)##; s#\.git$##')"
case "$REPO" in */*) : ;; *) die "nem sikerult a repot kiolvasni az origin-bol ('$ORIGIN_URL')." ;; esac

# A landolando commitok a HEAD-en. Ha a HEAD == origin/main, nincs mit landolni.
git fetch -q origin main || die "nem sikerult fetch-elni az origin/main-t."
# A "0" itt KET dolgot jelenthetne: tenyleg nincs mit landolni, vagy a git hivas
# elszallt. A kettot a kilepokod donti el, nem a szam.
set +e
AHEAD="$(git rev-list --count origin/main..HEAD 2>&1)"
ahead_rc=$?
set -e
[ "$ahead_rc" -eq 0 ] \
  || die "nem tudom megallapitani, hany commit-tal vagy elorebb az origin/main-nal -- a 'git rev-list' hibaval tert vissza (exit $ahead_rc): $AHEAD"
case "$AHEAD" in
  ''|*[!0-9]*) die "a 'git rev-list --count' valasza nem szam ('$AHEAD'), ezert nem tudom, van-e mit landolni." ;;
esac
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

# --- 0. gyors lokalis tipusellenorzes a push ELOTT -----------------------------
# A pre-push kapu a feature-branch push-t atengedi (csak main/master push-nal fut),
# ezert a gyors, determinisztikus tipushiba-szurest ITT vegezzuk el: egy elgepelt
# tipus ne 2-3 perc CI utan deruljon ki, hanem meg push elott.
#
# IZOLALT WORKTREE-BEN futtatjuk, nem a munkafan. A munkafa piszkos lehet, es
# akkor a tsc MAST ellenorizne, mint ami felmegy -- mindket iranyba tevedhetne:
# egy meg nem commitolt javitas hamis zoldet, egy meg nem commitolt WIP-tores
# hamis pirosat adna. A HEAD-et ellenorizzuk, mert azt pusholjuk.
TSC_BIN="$BASE/node_modules/.bin/tsc"
[ -x "$TSC_BIN" ] \
  || die "hianyzik a TypeScript fordito ($TSC_BIN). A worktree-ben nincs telepitve a node_modules -- futtass 'npm ci'-t, vagy hasznald a scripts/agent-worktree.sh-t, ami symlinkeli."

echo "land-pr: gyors tipusellenorzes a HEAD-en, izolalt worktree-ben (tsc --noEmit)..." >&2
TSC_TMP="$(mktemp -d -t land-pr-tsc-XXXXXX)" || die "nem sikerult ideiglenes konyvtarat letrehozni a tipusellenorzeshez."
set +e
wt_err="$(git worktree add --detach -q "$TSC_TMP/wt" HEAD 2>&1)"
wt_rc=$?
set -e
[ "$wt_rc" -eq 0 ] || die "nem sikerult izolalt worktree-t nyitni a HEAD-re (exit $wt_rc): $wt_err"
ln -sfn "$BASE/node_modules" "$TSC_TMP/wt/node_modules"
set +e
( cd "$TSC_TMP/wt" && "$TSC_BIN" --noEmit )
tsc_rc=$?
set -e
if [ "$tsc_rc" -ne 0 ]; then
  die "a HEAD tipusellenorzese nem futott le tisztan (tsc kilepokod $tsc_rc, a hibak fentebb), ezert NEM pusholok. Javitsd a tipushibakat, commitold, es futtasd ujra. A teljes suite-ot a CI meri."
fi
cleanup

# --- 1. branch felnyomasa (a gyors pre-push kapu a main-push-nal futna, itt nem) ----
# `-u` NELKUL, szandekosan. A `-u` a JELENLEGI branch upstream-jet allitja at az
# eldobhato land-branchre. Ha a main-rol landolsz (a tipikus eset), a lokalis
# main ezutan az `origin/land/2026...`-ot koveti -- egy kesobbi `git pull` a
# main-en a mar TOROLT land-branchet huzna. Merve 2026-09-04-en a #14-nel:
#   branch.main.merge = refs/heads/land/20260904-212327-ffd4403
# A script sehol nem tamaszkodik a trackingre: minden git-refspec es minden gh
# hivas (-R) explicit.
git push origin "HEAD:refs/heads/$BRANCH" || die "a branch push nem sikerult (lasd a fenti kimenetet)."

# --- 2. PR nyitasa (vagy meglevo ujrahasznalasa) -------------------------------
PR_URL="$(gh pr list -R "$REPO" --head "$BRANCH" --base main --state open --json url --jq '.[0].url' 2>/dev/null || true)"
if [ -z "$PR_URL" ]; then
  # A kimenetet NEM tesszuk egy az egyben a PR_URL-be: a gh figyelmeztetest is
  # irhat a stderr-re, es akkor a "PR_URL" egy hibauzenettel kezdodne.
  set +e
  create_out="$(gh pr create -R "$REPO" --base main --head "$BRANCH" --title "$TITLE" --body "${BODY:-$TITLE}" 2>&1)"
  create_rc=$?
  set -e
  [ "$create_rc" -eq 0 ] || die "a PR nyitasa nem sikerult (exit $create_rc): $create_out"
  PR_URL="$(printf '%s\n' "$create_out" | grep -Eo 'https://[^[:space:]]+/pull/[0-9]+' | tail -1)"
  [ -n "$PR_URL" ] || die "a PR nyitasa lefutott, de nem talaltam PR-URL-t a kimenetben: $create_out"
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
#
# HAROM kulonbozo "nem zold" allapotot kell szetvalasztani, es EGYIKET SEM
# szabad a masik okaval magyarazni:
#   (a) meg nem regisztralt check  -> varunk (par masodperc keses a PR-nyitas utan)
#   (b) NINCS is CI                -> a repon ki van kapcsolva az Actions
#   (c) NEM LATOK ODA              -> a `gh` hivas maga hibazott (halozat, 401,
#                                     rate limit, hianyzo jogosultsag). Ez NEM
#                                     ugyanaz, mint (b)!
# A regi valtozat mindharmat egyetlen `|| echo 0`-ra kepezte, es (b) okat
# allitotta mindharomra. Most a KILEPOKOD donti el, nem a szam.
CI_WAIT_MAX="${LAND_PR_CI_WAIT_MAX:-1500}"
EMPTY_GRACE="${LAND_PR_EMPTY_GRACE:-120}"
GH_FAIL_MAX=4                   # ennyi EGYMAS UTANI gh-hiba utan feladjuk
POLL_INTERVAL=15

# A hatarido nem lehet rovidebb a CI sajat legrosszabb esetenel, kulonben egy
# lassu, de ZOLD CI-t dobnank el: ci.yml `test` = 15 perc, a ra kovetkezo
# `ci-passed` = 2 perc (sorosan), plusz a runner sorbanallasa. 1500s = 25 perc.
# (Ezt az osszefuggest a src/__tests__/landing-doctrine.test.ts orzi.)
echo "land-pr: varakozas a CI-re (tipikusan ~2-3 perc; hatarido $(( CI_WAIT_MAX / 60 )) perc)..." >&2
start="$(date +%s)"
deadline=$(( start + CI_WAIT_MAX ))
ci_confirmed=0                  # 1, ha mar lattunk regisztralt futast
gh_fail_streak=0

while true; do
  set +e
  roll="$(gh pr view "$PR_URL" -R "$REPO" --json statusCheckRollup --jq '.statusCheckRollup' 2>&1)"
  roll_rc=$?
  set -e

  if [ "$roll_rc" -ne 0 ]; then
    # (c) NEM LATOK ODA. Egy-ket atmeneti hiba belefer, tartos hiba nem.
    gh_fail_streak=$(( gh_fail_streak + 1 ))
    if [ "$gh_fail_streak" -ge "$GH_FAIL_MAX" ]; then
      die "a 'gh pr view' egymas utan ${gh_fail_streak}x hibaval tert vissza, ezert NEM tudom, zold-e a CI (ez nem azt jelenti, hogy piros). A PR nyitva marad: $PR_URL. A gh utolso hibauzenete: $roll"
    fi
    echo "land-pr: a 'gh pr view' hibat adott (${gh_fail_streak}/${GH_FAIL_MAX}), ujraprobalom -- $roll" >&2
    verdict="RETRY"
  else
    gh_fail_streak=0
    set +e
    verdict="$(printf '%s' "$roll" | node "$CI_VERDICT" 2>&1)"
    verdict_rc=$?
    set -e
    [ "$verdict_rc" -eq 0 ] \
      || die "a CI-allapot valaszat nem sikerult ertelmezni (ci-verdict kilepokod $verdict_rc): $verdict. A PR nyitva marad: $PR_URL"
  fi

  case "$verdict" in
    RETRY) : ;;
    PASS) echo "land-pr: a CI zold." >&2; break ;;
    FAIL) die "a CI NEM zold ezen a PR-en. A PR nyitva marad: $PR_URL -- javitsd a hibat es pushold ujra a branchet." ;;
    PENDING) ci_confirmed=1 ;;   # van regisztralt check -> biztos, hogy fut CI
    EMPTY)
      # Meg egy check sem regisztralt. A tureshatar utan a FORRASBOL nezzuk meg,
      # van-e egyaltalan futas -- de csak akkor hisszuk el a "nincs"-et, ha a
      # lekerdezes maga SIKERULT.
      if [ "$ci_confirmed" -eq 0 ] && [ "$(( $(date +%s) - start ))" -ge "$EMPTY_GRACE" ]; then
        set +e
        runs="$(gh run list -R "$REPO" --branch "$BRANCH" --limit 1 --json databaseId --jq 'length' 2>&1)"
        runs_rc=$?
        set -e
        if [ "$runs_rc" -ne 0 ]; then
          # (c), NEM (b): a hivas hibazott. Nem allitjuk, hogy nincs CI.
          die "a rollup ${EMPTY_GRACE}s utan is ures, es NEM tudom megallapitani, indult-e egyaltalan CI-futas: a 'gh run list' hibaval tert vissza (exit $runs_rc). Ez NEM azt jelenti, hogy nincs CI -- azt jelenti, hogy nem latok oda. A gh hibauzenete: $runs. A PR nyitva marad: $PR_URL"
        fi
        case "$runs" in
          ''|*[!0-9]*) die "a 'gh run list' valasza nem szam ('$runs'), ezert nem tudom eldonteni, indult-e CI-futas. A PR nyitva marad: $PR_URL" ;;
        esac
        if [ "$runs" -eq 0 ]; then
          # (b) Most mar BIZTOS: a lekerdezes sikerult, es tenyleg nulla futas van.
          msg="${EMPTY_GRACE}s alatt egyetlen CI-futas sem indult el ezen a branchen ($BRANCH), es a 'gh run list' SIKERES lekerdezese is nulla futast talalt. "
          msg="${msg}Ez azt jelenti, hogy a GitHub Actions ki van kapcsolva ezen a repon/fork-on -- a rollup ilyenkor orokre ures marad. "
          msg="${msg}Teendo: GitHub -> Settings -> Actions -> General -> 'Allow all actions and reusable workflows', majd pushold ujra a branchet (PR nyitva: $PR_URL). "
          msg="${msg}Vagy landolj kezzel, miutan lokalisan zold a teljes suite: 'npm test' -> 'gh pr merge $PR_URL --squash --delete-branch'."
          die "$msg"
        fi
        ci_confirmed=1   # van futas, csak meg nem jelent meg a PR rollupjaban
      fi
      ;;
  esac

  if [ "$(date +%s)" -ge "$deadline" ]; then
    die "a CI a hatarido ($(( CI_WAIT_MAX / 60 )) perc) alatt nem fejezodott be. Ez NEM azt jelenti, hogy a CI piros -- csak azt, hogy meg nem vegzett. Nezd meg: $PR_URL (ha rendszeresen keves, emeld a LAND_PR_CI_WAIT_MAX erteket)."
  fi
  sleep "$POLL_INTERVAL"
done

# --- 4. merge zold CI utan -----------------------------------------------------
gh pr merge "$PR_URL" --squash --delete-branch \
  || die "a merge nem sikerult (talan branch protection / jogosultsag). PR: $PR_URL"
echo "land-pr: MERGE-ELVE es a branch torolve. PR: $PR_URL" >&2

# --- 5. lokalis main frissitese ------------------------------------------------
git fetch -q origin main && echo "land-pr: origin/main = $(git rev-parse --short origin/main). Frissitsd a lokalis checkoutod, ha kell." >&2
echo "land-pr: KESZ. Az elo peldanyra a scripts/deploy-live.sh viszi ki (idozitve fut)." >&2
