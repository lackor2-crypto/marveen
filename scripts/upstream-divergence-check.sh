#!/usr/bin/env bash
# Megmeri, mennyivel jar elottunk az upstream (Szotasz/marveen), es abbol
# mennyi huzhato at utkozes nelkul. Az eredmenyt a store/upstream-sync-status.json
# fajlba irja, ezt olvassa az Attekintes "Upstream szinkron" doboza.
#
# MIERT LETEZIK EZ A SCRIPT
# -------------------------
# A store/upstream-sync-status.json 2026-08-10 ota egy KEZZEL beirt
# pillanatkep volt (lastRunType: "manual"), es senki nem frissitette: sem
# script, sem utemezett feladat nem irta. A benne allo szamokbol ketto nem
# volt reprodukalhato a repobol (merve 2026-08-19-en):
#
#     mezo             a fajlban   a valosag
#     behindCount      63          63   <- helyes
#     conflictCount    4           4    <- helyes, es a 4 fajlnev is pontos
#     cleanFileCount   110         108  <- SEMMILYEN szamolassal nem jon ki
#     aheadCount       95          87   <- egyik helyi agra sem igaz
#
# Vagyis a doboz egy magabiztos, de kitalalt szamot mutatott. Ez a script
# attol szabadul meg: minden szam gitbol jon, es a JSON megmondja, mikor es
# mihez kepest mertuk.
#
# Amit NEM csinal: nem nyul a munkakonyvtarhoz es az indexhez. A
# `git merge-tree --write-tree` csak objektumokat ir az objektum-adatbazisba,
# a checkoutot nem billenti meg -- ezert biztonsagos akkor is lefuttatni,
# amikor egy ugynok epp dolgozik a repoban.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}" || exit 1
OUT="${REPO_ROOT}/store/upstream-sync-status.json"
RUN_TYPE="${1:-scheduled}"

export GIT_TERMINAL_PROMPT=0   # halozati hiba eseten NE kerjen jelszot es fagyjon meg

# --- 1. Melyik helyi agrol beszelunk? -------------------------------------
# Levalt (detached) HEAD-nel nincs ag, amihez viszonyithatnank; ilyenkor a
# main a beszedes tartalek.
LOCAL_REF="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)"
if [ -z "${LOCAL_REF}" ] || [ "${LOCAL_REF}" = "HEAD" ]; then
  LOCAL_REF="main"
fi

# --- 2. Elerheto-e egyaltalan az upstream tavoli? -------------------------
ERR=""
if ! git remote get-url upstream >/dev/null 2>&1; then
  ERR="no-upstream-remote"
fi

# --- 3. Frissites. A halozat hianya nem hiba, csak regebbi upstream-oldal.
FETCH_OK=false
if [ -z "${ERR}" ]; then
  if timeout 180 git fetch --quiet --prune upstream >/dev/null 2>&1; then
    FETCH_OK=true
  fi
fi

# --- 4. Az upstream alapertelmezett aga --------------------------------
# A forkolt repo fejlesztesi aga nem feltetlenul a main: itt a
# refs/remotes/upstream/HEAD a develop-ra mutat. Ha az upstream/HEAD nincs
# beallitva, a main a tartalek.
UPSTREAM_REF=""
if [ -z "${ERR}" ]; then
  SYM="$(git symbolic-ref -q refs/remotes/upstream/HEAD 2>/dev/null)"
  if [ -n "${SYM}" ]; then
    UPSTREAM_REF="${SYM#refs/remotes/}"
  elif git rev-parse --verify -q refs/remotes/upstream/main >/dev/null 2>&1; then
    UPSTREAM_REF="upstream/main"
  else
    ERR="no-upstream-branch"
  fi
fi

# --- 5. Mindket vegpont letezik-e? ---------------------------------------
# A merge-tree nemletezo refre is 1-gyel lep ki, epp ugy, mint amikor
# utkozest talal -- ezert ELOTTE ellenorizzuk, kulonben egy elgepelt agnevbol
# "van egy utkozesunk" lenne.
if [ -z "${ERR}" ]; then
  git rev-parse --verify -q "${LOCAL_REF}^{commit}" >/dev/null 2>&1 || ERR="no-local-branch"
fi
if [ -z "${ERR}" ]; then
  git rev-parse --verify -q "${UPSTREAM_REF}^{commit}" >/dev/null 2>&1 || ERR="no-upstream-branch"
fi

AHEAD=""; BEHIND=""; CLEAN=""; CONFLICTS=""; CONFLICT_LIST=""; CONTENT=""
REVERTED_MERGE=""; COMPARE_FROM=""
if [ -z "${ERR}" ]; then
  # --- 5/b. VISSZAVONT BEHUZAS: hol allunk VALOJABAN? --------------------
  # A `git revert -m 1` a tartalmat adja vissza, a historiat nem: a behuzo
  # merge ELOZMENY marad, ezert a git ugy latja, hogy azt a 137 commitot mar
  # behuztuk. Merve 2026-08-23-an: 1 commit / 2 fajl allt a dobozban, holott
  # az upstream tartalmabol semmi nem volt nalunk.
  #
  # A viszonyitasi pont ilyenkor a behuzas ELOTTI allapot (a merge elso
  # szuloje). Nem talalgatunk: a `git revert` altal irt "This reverts commit
  # <sha>" sorbol olvassuk ki, MELYIK commitot vontuk vissza, es csak akkor
  # lepunk vissza, ha az tenylegesen egy MERGE (ket szulo), aminek a masodik
  # szuloje az upstream aganak elozmenye. Egyszeru commit visszavonasa nem
  # mozditja a viszonyitasi pontot.
  COMPARE_FROM="${LOCAL_REF}"
  while read -r rev; do
    [ -n "${rev}" ] || continue
    target="$(git log -1 --format=%B "${rev}" 2>/dev/null \
              | sed -n 's/^This reverts commit \([0-9a-f]\{7,40\}\).*/\1/p' | head -1)"
    [ -n "${target}" ] || continue
    parents="$(git log -1 --format=%P "${target}" 2>/dev/null)"
    set -- ${parents}
    [ "$#" -eq 2 ] || continue                      # nem merge -> nem erdekel
    git merge-base --is-ancestor "$2" "${UPSTREAM_REF}" 2>/dev/null || continue
    COMPARE_FROM="$(git rev-parse "${target}^1" 2>/dev/null)"
    REVERTED_MERGE="$(git rev-parse --short "${target}" 2>/dev/null)"
    # A legREGEBBI ilyen visszavonas a helyes kiindulopont, ezert nem allunk meg.
  done <<EOF
$(git log "${LOCAL_REF}" --format=%H --grep='^This reverts commit' 2>/dev/null)
EOF
  [ -n "${COMPARE_FROM}" ] || COMPARE_FROM="${LOCAL_REF}"

  # --- 6. Commit-tavolsag mindket iranyba --------------------------------
  BEHIND="$(git rev-list --count "${COMPARE_FROM}..${UPSTREAM_REF}" 2>/dev/null)"
  AHEAD="$(git rev-list --count "${UPSTREAM_REF}..${LOCAL_REF}" 2>/dev/null)"

  # --- 6/b. TARTALMI elteres (fa vs fa) ---------------------------------
  # A commit-tavolsag onmagaban felrevezet, ha egy behuzast KESOBB
  # visszavontunk: a merge commit os marad, ezert a BEHIND lecsokken
  # (merve 2026-08-23-an: 1), holott az upstream tartalma nincs nalunk
  # (ugyanakkor 681 fajl tartalma tert el). Ez a ket-pontos diff a mi
  # sajat fejlesztéseinket is beszamitja -- epp ezert NEM a behuzando
  # halmaz merteke, hanem egyetlen kerdesre valaszol: azonos-e a ket fa.
  # Ha ez nem nulla, a doboz nem mondhatja, hogy naprakeszek vagyunk.
  CONTENT="$(git diff --name-only "${LOCAL_REF}" "${UPSTREAM_REF}" 2>/dev/null | grep -c .)"

  # --- 7. Fajl-szintu kep a kozos osbol nezve ----------------------------
  # A ket-pontos diff (LOCAL..UPSTREAM) a SAJAT valtozasainkat is beszamitana
  # -- itt merve 234 fajlt adott a valos 112 helyett. A kozos os (merge-base)
  # az egyetlen helyes kiindulopont: onnan nezve azt latjuk, amit AZ UPSTREAM
  # csinalt.
  BASE="$(git merge-base "${COMPARE_FROM}" "${UPSTREAM_REF}" 2>/dev/null)"
  if [ -n "${BASE}" ]; then
    git diff --name-only "${BASE}" "${UPSTREAM_REF}" 2>/dev/null | sort -u > /tmp/uds-upstream-files.$$

    # --- 8. Valodi osszefesules-proba (semmit nem ir a munkakonyvtarba) ---
    # Kilepokod 0 = tiszta, 1 = van utkozes, barmi mas = a git nem tudta
    # elvegezni (pl. regi git, nincs --write-tree). Az utolso esetben inkabb
    # "nem tudjuk" (null) all a fajlban, mint egy talalgatas.
    MT="$(git merge-tree --write-tree --name-only "${COMPARE_FROM}" "${UPSTREAM_REF}" 2>/dev/null)"
    MT_RC=$?
    if [ "${MT_RC}" -eq 0 ]; then
      : > /tmp/uds-conflicts.$$
      CONFLICTS=0
    elif [ "${MT_RC}" -eq 1 ]; then
      # 1. sor: a letrejott fa azonositoja. Utana az utkozo fajlnevek az elso
      # ures sorig, azon tul mar csak az emberi uzenetek allnak.
      printf '%s\n' "${MT}" | sed -n '2,/^$/p' | grep . | sort -u > /tmp/uds-conflicts.$$
      CONFLICTS="$(grep -c . /tmp/uds-conflicts.$$)"
    else
      CONFLICTS=""
    fi

    if [ -n "${CONFLICTS}" ]; then
      # A "tisztan athuzhato" halmaz-kulonbseg, nem kivonas: ha egy utkozes
      # olyan utvonalon jelenne meg, amit az upstream-diff nem tartalmaz
      # (atnevezes/torles), a kivonas alameroe.
      CLEAN="$(comm -23 /tmp/uds-upstream-files.$$ /tmp/uds-conflicts.$$ | grep -c .)"
      CONFLICT_LIST="/tmp/uds-conflicts.$$"
    fi
  fi
fi

# --- 9. Kiiras. A JSON-t python allitja elo, hogy a fajlnevekben levo
# idezojel/backslash ne tudja elrontani a formatumot.
python3 - "${OUT}" "${LOCAL_REF}" "${UPSTREAM_REF}" "${AHEAD}" "${BEHIND}" \
         "${CONFLICTS}" "${CLEAN}" "${CONFLICT_LIST}" "${FETCH_OK}" "${ERR}" "${RUN_TYPE}" \
         "${CONTENT}" "${REVERTED_MERGE}" <<'PY'
import json, os, sys, datetime

(out, local_ref, up_ref, ahead, behind, conflicts, clean, clist, fetch_ok, err,
 run_type, content, reverted) = sys.argv[1:14]

def num(s):
    try:
        return int(s)
    except (TypeError, ValueError):
        return None

files = []
if clist and os.path.exists(clist):
    with open(clist, encoding='utf-8') as f:
        files = [l.rstrip('\n') for l in f if l.strip()]
    os.unlink(clist)

data = {
    'checkedAt': datetime.datetime.now().astimezone().isoformat(timespec='seconds'),
    'aheadCount': num(ahead),
    'behindCount': num(behind),
    'conflictingFiles': files,
    'conflictCount': num(conflicts),
    'cleanFileCount': num(clean),
    'contentDiffCount': num(content),
    # Melyik visszavont behuzas miatt nem a HEAD a viszonyitasi pont. Ures =
    # nincs ilyen, a szamok a jelenlegi agrol szolnak.
    'revertedMerge': reverted or None,
    'localRef': local_ref or None,
    'upstreamRef': up_ref or None,
    'fetchOk': fetch_ok == 'true',
    'error': err or None,
    'lastRunType': run_type,
}
tmp = out + '.tmp'
with open(tmp, 'w', encoding='utf-8') as f:
    json.dump(data, f, ensure_ascii=False, indent=2)
    f.write('\n')
os.replace(tmp, out)
print(json.dumps({k: data[k] for k in
      ('behindCount', 'aheadCount', 'conflictCount', 'cleanFileCount', 'contentDiffCount', 'revertedMerge',
       'upstreamRef', 'fetchOk', 'error')}, ensure_ascii=False))
PY

rm -f /tmp/uds-upstream-files.$$ /tmp/uds-conflicts.$$
