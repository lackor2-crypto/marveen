#!/usr/bin/env bash
# verify-branch-protection.sh -- a main branch vedelme MERHETO legyen, ne hiedelem.
#
# MIERT (2026-09-04):
# A landolas-atallas (kartya 7e82036c) bevezetett egy stabil nevu `ci-passed`
# aggregalt CI-jobot azzal a cellal, hogy a branch protection EZT kovetelje meg
# a Node-matrix valtozo nevei helyett. A kapcsolo at is lett allitva a GitHub-on
# -- de errol a repoban SEMMI nem szolt: egy review nem tudta ellenorizni, egy
# fork pedig nem tudta megismetelni. Ez a script teszi merhetove.
#
# A "nulla ket dolgot jelenthet" szabaly szerint HAROM allapotot kulonboztet meg,
# es egyiket sem magyarazza a masik okaval:
#   - a vedelem be van allitva  -> kiirja, mit kovetel meg
#   - NINCS vedelem             -> a GitHub "Branch not protected"-et valaszol
#   - NEM LATOK ODA             -> nincs gh, nincs bejelentkezes, vagy nincs
#                                  admin jog a repohoz (403). Ez NEM ugyanaz,
#                                  mint hogy nincs vedelem.
#
# Hasznalat:
#   scripts/verify-branch-protection.sh                      # csak jelentes (olvaso)
#   scripts/verify-branch-protection.sh --expect ci-passed   # + kilepokod 1, ha hianyzik
#   scripts/verify-branch-protection.sh --apply              # beallitja (IRO muvelet, kerdez)
set -euo pipefail

BRANCH="main"
EXPECT=""
APPLY=0
REQUIRED_CHECK="ci-passed"

die() { echo "verify-branch-protection: HIBA -- $*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --expect)
      [ $# -ge 2 ] && [ -n "${2:-}" ] || die "a --expect utan add meg a check nevet is."
      EXPECT="$2"; shift 2 ;;
    --branch)
      [ $# -ge 2 ] && [ -n "${2:-}" ] || die "a --branch utan add meg a branch nevet is."
      BRANCH="$2"; shift 2 ;;
    --apply) APPLY=1; shift ;;
    # A fejlec-kommentet az ELSO nem-komment sorig irjuk ki -- fix sorszammal a
    # sugo nemán csonkulna, amint a fejlec valtozik.
    -h|--help) awk 'NR>1 { if (!/^#/) exit; sub(/^# ?/, ""); print }' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) die "ismeretlen kapcsolo: $1 (segitseg: --help)" ;;
  esac
done

command -v gh >/dev/null 2>&1 \
  || die "a 'gh' CLI nincs telepitve, ezert NEM tudom megnezni a branch protectiont. Ez nem azt jelenti, hogy nincs vedelem -- azt jelenti, hogy nem latok oda. Telepitsd: https://cli.github.com/"
command -v node >/dev/null 2>&1 \
  || die "a 'node' nincs a PATH-on, pedig a valasz feldolgozasahoz kell. Telepitsd a Node.js-t."

# A repo az origin-bol (host-agnosztikus), ugyanazzal a semaval, mint a land-pr.sh.
ORIGIN_URL="$(git remote get-url origin 2>/dev/null || true)"
[ -n "$ORIGIN_URL" ] || die "ennek a checkoutnak nincs 'origin' remote-ja, ezert nem tudom, melyik GitHub-repot kellene megneznem."
REPO="$(printf '%s' "$ORIGIN_URL" | sed -E 's#^(https?://[^/]+/|ssh://[^/]+/|git@[^:]+:)##; s#\.git$##')"
case "$REPO" in
  */*) : ;;
  *) die "nem sikerult a repot kiolvasni az origin-bol ('$ORIGIN_URL'). Vart alak: <tulaj>/<repo>." ;;
esac

echo "verify-branch-protection: repo=$REPO branch=$BRANCH" >&2

set +e
PROT="$(gh api "repos/$REPO/branches/$BRANCH/protection" 2>&1)"
PROT_RC=$?
set -e

# PROTECTED: 1 = van vedelem, 0 = biztosan nincs. A "nem tudom" agak nem allitjak
# be, mert azok die-jal vegzodnek -- talalgatott allapot nem kerul tovabb.
PROTECTED=1
if [ "$PROT_RC" -ne 0 ]; then
  case "$PROT" in
    *"Branch not protected"*)
      PROTECTED=0
      ;;
    *"Must have admin rights"*|*"HTTP 403"*)
      die "nincs admin jogod ehhez a repohoz, ezert NEM tudom megnezni a branch protectiont. Ez NEM azt jelenti, hogy nincs vedelem -- azt jelenti, hogy nem latok oda. A gh valasza: $PROT"
      ;;
    *"HTTP 401"*|*"authentication"*|*"gh auth login"*)
      die "a 'gh' nincs bejelentkezve, ezert nem latok ra a branch protectionre. Ez NEM azt jelenti, hogy nincs vedelem. Javitas: gh auth login. A gh valasza: $PROT"
      ;;
    *"Not Found"*|*"HTTP 404"*)
      die "a GitHub 'Not Found'-ot adott a(z) $REPO / $BRANCH-re. Ez lehet elgepelt repo-nev, nemletezo branch, VAGY hianyzo jogosultsag -- a valaszbol nem dol el, ezert nem allitom egyiket sem. A gh valasza: $PROT"
      ;;
    *)
      die "a 'gh api' hibaval tert vissza (exit $PROT_RC), ezert nem tudom, van-e vedelem. A gh valasza: $PROT"
      ;;
  esac
fi

CONTEXTS=""
ENFORCE_ADMINS=""
if [ "$PROTECTED" -eq 1 ]; then
  # Innentol: a lekerdezes SIKERULT, tehat amit latunk, az a valosag.
  read_field() {
    printf '%s' "$PROT" | node -e '
let s = ""
process.stdin.on("data", (c) => (s += c))
process.stdin.on("end", () => {
  let d
  try {
    d = JSON.parse(s)
  } catch (err) {
    process.stderr.write("a gh valasza nem ervenyes JSON: " + err.message)
    process.exit(2)
  }
  if (process.argv[1] === "contexts") {
    const c = (d.required_status_checks && d.required_status_checks.contexts) || []
    process.stdout.write(c.join("\n"))
  } else {
    process.stdout.write(d.enforce_admins && d.enforce_admins.enabled ? "igen" : "nem")
  }
})' "$1"
  }
  set +e
  CONTEXTS="$(read_field contexts 2>&1)"; ctx_rc=$?
  ENFORCE_ADMINS="$(read_field enforce 2>&1)"; adm_rc=$?
  set -e
  [ "$ctx_rc" -eq 0 ] && [ "$adm_rc" -eq 0 ] \
    || die "a 'gh api' sikeresen valaszolt, de a valaszat nem tudtam ertelmezni: ${CONTEXTS}${ENFORCE_ADMINS}"
fi

echo ""
if [ "$PROTECTED" -eq 0 ]; then
  echo "EREDMENY: a(z) '$BRANCH' branch NINCS vedve."
  echo "  Ez biztos informacio: a GitHub valaszolt, es azt mondta, nincs vedelem."
  echo "  Kovetkezmeny: barki (es barmelyik agens) kozvetlenul a $BRANCH-re pusholhat,"
  echo "  a CI megkerulesevel -- a landolasi doktrina igy nincs kikenyszeritve."
  [ "$APPLY" -eq 1 ] || echo "  Beallitas: scripts/verify-branch-protection.sh --apply"
else
  echo "EREDMENY: a(z) '$BRANCH' branch VEDVE van."
  if [ -z "$CONTEXTS" ]; then
    echo "  Kotelezo status check: NINCS egy sem."
    echo "  Figyelem: vedelem van, de CI-kapu nincs -- egy PR zold CI nelkul is merge-elheto."
  else
    echo "  Kotelezo status checkek:"
    printf '%s\n' "$CONTEXTS" | sed 's/^/    - /'
  fi
  echo "  Adminra is vonatkozik (enforce_admins): $ENFORCE_ADMINS"
fi

EXPECT_FAILED=0
if [ -n "$EXPECT" ]; then
  echo ""
  if [ "$PROTECTED" -eq 1 ] && printf '%s\n' "$CONTEXTS" | grep -qx -- "$EXPECT"; then
    echo "OK: a(z) '$EXPECT' kotelezo status check."
  else
    EXPECT_FAILED=1
    echo "HIANYZIK: a(z) '$EXPECT' NEM kotelezo status check ezen a branchen."
    echo "  Kovetkezmeny: vagy a CI-kapu megkerulheto, vagy a required check egy elavult"
    echo "  (pl. atnevezett matrix-) nevre mutat, ami sosem fut le -- az orokre blokkol."
    [ "$APPLY" -eq 1 ] || echo "  Javitas: scripts/verify-branch-protection.sh --apply"
  fi
fi

if [ "$APPLY" -eq 1 ]; then
  echo ""
  echo "--apply: a(z) $REPO '$BRANCH' branchenek vedelmet a kovetkezore allitanam:"
  echo "    kotelezo status check:  $REQUIRED_CHECK"
  echo "    adminra is vonatkozik:  igen"
  echo "    force push / branch-torles: tiltva"
  echo "  Ez FELULIRJA a branch jelenlegi vedelmi beallitasait."
  printf "Vegrehajtsam? [i/N] "
  ans=""
  read -r ans || true
  case "$ans" in
    i|I|y|Y) : ;;
    *) echo "Megszakitva -- semmi nem valtozott."; exit "$EXPECT_FAILED" ;;
  esac
  set +e
  apply_out="$(gh api -X PUT "repos/$REPO/branches/$BRANCH/protection" --input - <<JSON 2>&1
{
  "required_status_checks": { "strict": false, "contexts": ["$REQUIRED_CHECK"] },
  "enforce_admins": true,
  "required_pull_request_reviews": null,
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
JSON
)"
  apply_rc=$?
  set -e
  [ "$apply_rc" -eq 0 ] || die "a branch protection beallitasa nem sikerult (exit $apply_rc). A gh valasza: $apply_out"
  echo "KESZ: a vedelem beallitva."
  echo "  Ellenorzes: scripts/verify-branch-protection.sh --expect $REQUIRED_CHECK"
  exit 0
fi

exit "$EXPECT_FAILED"
