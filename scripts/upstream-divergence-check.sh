#!/usr/bin/env bash
# Megmeri, mennyivel jar elottunk az `upstream` remote (barmelyik repo is az --
# a cimet a gitbol olvassuk, sehol nincs beegetve), es abbol mennyi huzhato at
# utkozes nelkul. Az eredmenyt a store/upstream-sync-status.json fajlba irja,
# ezt olvassa az Attekintes "Upstream szinkron" doboza.
#
# Nincs `upstream` remote -> `no-upstream-remote` ok, ures szamok, a doboz
# HALLGAT. Ez a helyes viselkedes egy friss telepitesen: aki nem forkolt, annak
# nincs mit szinkronizalnia.
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

# macOS has no `timeout` out of the box (coreutils ships it as gtimeout). A
# missing binary made every fetch fail there with "command not found", read as
# an upstream error. Fall back to running without a limit rather than not at all.
run_timeout() {
  if command -v timeout >/dev/null 2>&1; then timeout "$@"
  elif command -v gtimeout >/dev/null 2>&1; then gtimeout "$@"
  else shift; "$@"; fi
}
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
# A remote CIMET is kiolvassuk. Enelkul a doboz meg tudja mondani, mennyivel
# vagyunk lemaradva, de azt nem, hogy MITOL -- es aki ezt a Marveent forkolja,
# annak MAS a forrasa. Semmilyen repo-nev nem lehet beegetve a kodba.
ERR=""
UPSTREAM_URL=""
UPSTREAM_REPO=""
if ! UPSTREAM_URL="$(git remote get-url upstream 2>/dev/null)"; then
  ERR="no-upstream-remote"
  UPSTREAM_URL=""
fi
if [ -n "${UPSTREAM_URL}" ]; then
  # "git@github.com:Owner/Repo.git" es "https://github.com/Owner/Repo.git"
  # egyarant "Owner/Repo" lesz. Ami nem GitHub-cim, az valtozatlanul megy ki:
  # jobb a nyers URL, mint egy ures mezo.
  UPSTREAM_REPO="$(printf '%s' "${UPSTREAM_URL}" | sed -E 's#^.*github\.com[:/]##; s#\.git$##')"
fi

# --- 3. Frissites. A halozat hianya nem hiba, csak regebbi upstream-oldal.
# ★ A HIBA OKAT SOSE TALALGATJUK. Korabban a git stderr-je a /dev/null-ba ment,
#   es a felulet minden sikertelen fetch-re azt irta ki, hogy "nincs halozat" --
#   holott ugyanigy lehet lejart kulcs, atnevezett repo vagy DNS-hiba. A
#   tenyleges uzenet innentol a JSON-ba kerul, es a felulet AZT mutatja.
FETCH_OK=false
FETCH_ERR=""
if [ -z "${ERR}" ]; then
  FETCH_OUT="$(run_timeout 180 git fetch --quiet --prune upstream 2>&1)"
  FETCH_RC=$?
  if [ "${FETCH_RC}" -eq 0 ]; then
    FETCH_OK=true
  else
    # Az utolso nem-ures sor a beszedes: a git a lenyeget oda irja.
    FETCH_ERR="$(printf '%s' "${FETCH_OUT}" | grep . | tail -1 | cut -c1-300)"
    if [ -z "${FETCH_ERR}" ]; then
      if [ "${FETCH_RC}" -eq 124 ]; then
        FETCH_ERR="git fetch upstream: idotullepes (180 mp) -- a szerver nem valaszolt"
      else
        FETCH_ERR="git fetch upstream: nincs kimenet, kilepokod ${FETCH_RC}"
      fi
    fi
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

AHEAD=""; BEHIND=""; CLEAN=""; CONFLICTS=""; CONFLICT_LIST=""; CONTENT=""; SPLIT_FILES=""
# A szandekosan kihagyott upstream-fajlok nyilvantartasa (kanban #375). A repo
# resze, mert a dontes is az: a fork sajat valasztasa, nem gepi allapot.
SKIP_LIST="${REPO_ROOT}/governance/upstream-skipped-files.json"
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
  # A --grep itt csak ELO-SZURO, szandekosan horgony nelkul. A `^` mukodne
  # (merve 2026-08-23, git soronkent horgonyoz), de egy finom szemantikara
  # epulne: ha az valaha megvaltozik, a kereses NEMAN ures lesz, es a doboz
  # ujra 1 commitot mutatna. A valodi feltetel ugyis lentebb all: soralapu
  # kinyeres + merge-e + az upstreambol jott-e.
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
$(git log "${LOCAL_REF}" --format=%H --grep='This reverts commit' 2>/dev/null)
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
    #
    # A proba a MOSTANI agunkat (LOCAL_REF) fesuli ossze az upstreammel, a
    # kozos ossel (BASE) mint kifejezett alappal. Korabban a COMPARE_FROM-ot
    # (a visszavont behuzas ELOTTI regi commitot) fesulte ossze: az a regi
    # pont nem tartalmazza a sajat, azota keszult valtozasainkat, ezert egy
    # azota altalunk is modositott fajl "tisztan athuzhatonak" latszott.
    # Merve 2026-09-24-en: a doboz 76 utkozest mutatott, a mostani agunkhoz
    # merve 100 volt (kanban #375).
    MT="$(git merge-tree --write-tree --name-only --merge-base="${BASE}" "${LOCAL_REF}" "${UPSTREAM_REF}" 2>/dev/null)"
    MT_RC=$?
    if [ "${MT_RC}" -gt 1 ] && [ -z "${REVERTED_MERGE}" ]; then
      # Regi git (--merge-base < 2.40): visszavont behuzas nelkul a sima
      # ketpontos proba ugyanazt az alapot talalja meg.
      MT="$(git merge-tree --write-tree --name-only "${LOCAL_REF}" "${UPSTREAM_REF}" 2>/dev/null)"
      MT_RC=$?
    fi
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
      comm -23 /tmp/uds-upstream-files.$$ /tmp/uds-conflicts.$$ > /tmp/uds-clean.$$
      CLEAN="$(grep -c . /tmp/uds-clean.$$)"
      CONFLICT_LIST="/tmp/uds-conflicts.$$"
      # --- 8/b. MI VAN MEG TENYLEG HATRA? (kanban #375) ------------------
      # A fenti halmaz MINDEN fajlt tartalmaz, amit az upstream a kozos os
      # ota megvaltoztatott -- azt is, ami nalunk MAR byte-ra ugyanaz (mert
      # behuztuk), es azt is, amit SZANDEKOSAN kihagytunk. Merve 2026-09-24:
      # a #375 behuzasa utan is 723 "tisztan athuzhato" allt a dobozban, mert
      # ebbol 302 mar egyezett, a tobbi nagy resze pedig dontessel maradt ki.
      # A behuzastol ez a szam SOSEM csokkent volna. A python-blokk ezert
      # harom reszre bontja: mar behuzva / szandekosan kihagyva / meg hatra.
      git diff --name-only "${LOCAL_REF}" "${UPSTREAM_REF}" 2>/dev/null | sort -u > /tmp/uds-differ.$$
      git ls-tree -r --full-tree "${UPSTREAM_REF}" 2>/dev/null > /tmp/uds-uptree.$$
      SPLIT_FILES="/tmp/uds-clean.$$:/tmp/uds-differ.$$:/tmp/uds-uptree.$$"
    fi
  fi
fi

# --- 9. Kiiras. A JSON-t python allitja elo, hogy a fajlnevekben levo
# idezojel/backslash ne tudja elrontani a formatumot.
python3 - "${OUT}" "${LOCAL_REF}" "${UPSTREAM_REF}" "${AHEAD}" "${BEHIND}" \
         "${CONFLICTS}" "${CLEAN}" "${CONFLICT_LIST}" "${FETCH_OK}" "${ERR}" "${RUN_TYPE}" \
         "${CONTENT}" "${REVERTED_MERGE}" "${UPSTREAM_REPO}" "${FETCH_ERR}" \
         "${SPLIT_FILES}" "${SKIP_LIST}" <<'PY'
import json, os, sys, datetime

(out, local_ref, up_ref, ahead, behind, conflicts, clean, clist, fetch_ok, err,
 run_type, content, reverted, up_repo, fetch_err, split_files, skip_list) = sys.argv[1:18]

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

def lines(path):
    with open(path, encoding='utf-8') as f:
        return [l.rstrip('\n') for l in f if l.strip()]

# --- A "tisztan athuzhato" halmaz szetbontasa (kanban #375) ---------------
#   absorbed = nalunk mar byte-ra ugyanaz, mint az upstreamben (behuzva)
#   skipped  = SZANDEKOSAN kihagyva: a governance/upstream-skipped-files.json
#              sorolja fel, az upstream AKKORI blob-azonositojaval. Ha az
#              upstream azota ujra modositotta a fajlt, a regi dontes nem
#              ervenyes ra -> ujra "hatra van" lesz, uj dontes kell.
#              kind=deferred: halasztva (kesobb elovesszuk), kind=decided:
#              vegleges dontes.
#   clean    = ami ezek utan TENYLEG hatra van.
# Hianyzo lista = friss telepites, nincs kihagyas: 0, nem hiba. Olvashatatlan
# lista viszont NEM ures: a mezok null-ok maradnak, es a hiba kiirodik.
absorbed = skipped = deferred = None
skip_error = None
if split_files and clean:
    clean_path, differ_path, uptree_path = split_files.split(':')
    try:
        clean_set = lines(clean_path)
        differ = set(lines(differ_path))
        uptree = {}
        for l in lines(uptree_path):
            meta, _, name = l.partition('\t')
            parts = meta.split()
            if len(parts) >= 3:
                uptree[name] = parts[2]
        decided = {}
        if os.path.exists(skip_list):
            try:
                with open(skip_list, encoding='utf-8') as f:
                    raw = json.load(f)
                entries = raw.get('files') if isinstance(raw, dict) else None
                if not isinstance(entries, dict):
                    raise ValueError('a "files" mezo nem objektum')
                decided = entries
            except Exception as e:
                skip_error = ('governance/upstream-skipped-files.json: %s' % e)[:300]
        if skip_error is None:
            absorbed = skipped = deferred = 0
            remaining = 0
            for path in clean_set:
                if path not in differ:
                    absorbed += 1
                    continue
                d = decided.get(path)
                if isinstance(d, dict) and d.get('blob', '') == uptree.get(path):
                    skipped += 1
                    # "deferred" = kihagyva, de NEM vegleg (pl. kevert fajl,
                    # kesobb kezi valogatas) -- kulon szamoljuk, hogy a
                    # doboz ne mutassa lezart dontesnek.
                    if d.get('kind') == 'deferred':
                        deferred += 1
                    continue
                remaining += 1
            clean = str(remaining)
    except Exception as e:
        skip_error = ('split: %s' % e)[:300]
    for pth in split_files.split(':'):
        try:
            os.unlink(pth)
        except OSError:
            pass

data = {
    'checkedAt': datetime.datetime.now().astimezone().isoformat(timespec='seconds'),
    'aheadCount': num(ahead),
    'behindCount': num(behind),
    'conflictingFiles': files,
    'conflictCount': num(conflicts),
    # MEG HATRA LEVO, utkozes nelkul athuzhato fajlok (kanban #375 ota: a mar
    # behuzott es a szandekosan kihagyott fajlok NINCSENEK benne).
    'cleanFileCount': num(clean),
    # Az upstream altal valtoztatott, nalunk MAR ugyanolyan fajlok.
    'absorbedCount': absorbed,
    # Dontessel kihagyott fajlok (governance/upstream-skipped-files.json).
    'skippedCount': skipped,
    # Ebbol halasztott (kind=deferred): kesobb meg elovesszuk.
    'skippedDeferredCount': deferred,
    # A kihagyas-lista TENYLEGES olvasasi hibaja. Ilyenkor a fenti ket szam
    # null, es a cleanFileCount a szetbontas nelkuli, regi ertelmu szam.
    'skipListError': skip_error,
    'contentDiffCount': num(content),
    # Melyik visszavont behuzas miatt nem a HEAD a viszonyitasi pont. Ures =
    # nincs ilyen, a szamok a jelenlegi agrol szolnak.
    'revertedMerge': reverted or None,
    'localRef': local_ref or None,
    'upstreamRef': up_ref or None,
    # MELYIK repo az upstream. A gitbol olvasva, sehol nincs beegetve: a
    # forkolo sajat forrasat latja, nem a mienket.
    'upstreamRepo': up_repo or None,
    'fetchOk': fetch_ok == 'true',
    # A fetch TENYLEGES hibauzenete (nem talalgatott ok). Ures = nem hasalt el.
    'fetchError': fetch_err or None,
    'error': err or None,
    'lastRunType': run_type,
}
tmp = out + '.tmp'
with open(tmp, 'w', encoding='utf-8') as f:
    json.dump(data, f, ensure_ascii=False, indent=2)
    f.write('\n')
os.replace(tmp, out)
print(json.dumps({k: data[k] for k in
      ('behindCount', 'aheadCount', 'conflictCount', 'cleanFileCount', 'absorbedCount', 'skippedCount',
       'skippedDeferredCount',
       'skipListError', 'contentDiffCount', 'revertedMerge',
       'upstreamRef', 'upstreamRepo', 'fetchOk', 'fetchError', 'error')}, ensure_ascii=False))
PY

rm -f /tmp/uds-upstream-files.$$ /tmp/uds-conflicts.$$ /tmp/uds-clean.$$ /tmp/uds-differ.$$ /tmp/uds-uptree.$$

# --- 10. A tetelesen lista (es rajta az elv-kapu dontese) ugyanebbol a
# meresbol frissul. Eddig csak terminalbol keszult (npx tsx
# scripts/upstream-changelog.ts), igy a feluleten az "Ujrameres" utan is a
# regi lista allt, es a kapu-nezet orokre "meg nem futott"-at mondott.
# --no-llm: csak git, masodpercek -- a mar meglevo magyar szovegeket
# megtartja, uj tetelt nem fordit (az fizetos API-hivas, azt nem inditjuk
# magunktol). A lista hibaja NEM rontja el a fenti merest: az mar ki van irva.
if [ -z "${ERR}" ]; then
  TSX="${REPO_ROOT}/node_modules/.bin/tsx"
  if [ -x "${TSX}" ]; then
    run_timeout 120 "${TSX}" "${REPO_ROOT}/scripts/upstream-changelog.ts" --no-llm \
      || echo "upstream-changelog: a tetelesen lista NEM frissult (kilepokod $?) -- a regi lista maradt" >&2
  else
    echo "upstream-changelog: nincs ${TSX} (npm install hianyzik?) -- a tetelesen lista NEM frissult" >&2
  fi
fi
