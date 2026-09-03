// A git-hivasok NEM tevedhetnek at egy masik repoba.
//
// A `cwd:` es a `git -C <ut>` latszolag eldonti, MELYIK repon dolgozunk.
// Nem donti el. Ha a kornyezetben ott van a `GIT_DIR`, az ERVENYTELENITI
// mindkettot: a git nem keres repot a munkakonyvtarbol felfele, hanem
// szo nelkul a `GIT_DIR` altal mutatott repoba ir -- a `cwd` ilyenkor mar
// csak a MUNKAFA lesz hozza.
//
// Ez nem elmeleti. 2026-09-03-an a pre-push kapu (`.git/hooks/pre-push.d/
// 20-require-green-suite-main`) elinditotta a teljes teszt-suite-ot. A kaput
// a git HOOK-kent hivja meg, es a hookok kornyezeteben a git MINDIG beallitja
// a `GIT_DIR`-t. A teszt-folyamatok ezt orokoltek, igy minden `git commit`,
// amit sajat ideiglenes konyvtarukba szantak, az ELO repo `main` agan kotott
// ki. Negy commit -- `elso`, `elso`, `elso`, `egy`, mind `T <t@t>` szerzovel --
// a teljes fat lecserelte egyetlen `a.txt`-re.
//
// Ezert nem eleg a hookot megjavitani: az a repon KIVUL el (`.git/hooks/`),
// friss telepitesen mas lehet, es barmelyik masik hook ugyanigy elsulhet.
// A vedelemnek ott kell allnia, ahol a git-et INDITJUK.

/**
 * Azok a valtozok, amik azt mondjak meg a gitnek, MELYIK repon dolgozzon.
 *
 * Az identitas (`GIT_AUTHOR_*`, `GIT_COMMITTER_*`), a jelszo-kezeles
 * (`GIT_ASKPASS`, `GIT_TERMINAL_PROMPT`) es az SSH-beallitas SZANDEKOSAN
 * nincs benne: azok nem teritik el a hivast, es a tesztek epitenek rajuk.
 */
export const REPO_POINTING_GIT_VARS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_INDEX_FILE',
  'GIT_INDEX_VERSION',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_QUARANTINE_PATH',
  'GIT_NAMESPACE',
  'GIT_PREFIX',
  'GIT_CEILING_DIRECTORIES',
  'GIT_GRAFT_FILE',
  'GIT_SHALLOW_FILE',
] as const

/**
 * A kapott kornyezet masolata, a repot elterito valtozok NELKUL.
 *
 * Mindig masolatot ad vissza -- a `process.env` megvaltoztatasa az egesz
 * folyamatra hatna, es pont az a fajta lathatatlan mellekhatas lenne, ami
 * ellen ez a fajl vedeni akar.
 */
export function cleanGitEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base }
  for (const key of REPO_POINTING_GIT_VARS) delete env[key]
  return env
}

/**
 * Melyik elterito valtozo van EPPEN a kornyezetben.
 *
 * Nem a hibakereseshez van: a teszt ezzel tudja bizonyitani, hogy a vedelem
 * tenylegesen levette oket, es nem csak "elvileg" tette volna.
 */
export function leakedGitVars(base: NodeJS.ProcessEnv = process.env): string[] {
  return REPO_POINTING_GIT_VARS.filter(k => base[k] !== undefined)
}
