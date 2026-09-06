// code-task-preamble: the routing preface the bridge puts in front of EVERY
// task it hands to the executor -- at CLAIM time, not at enqueue time.
//
// WHY IT EXISTS (kanban #222)
// Every chat tab this install has registered lives in ONE folder, and it is not
// the Marveen folder. A task about Marveen therefore reaches a session whose
// working directory is somewhere else entirely -- and the session stopped to ask
// whether it had been routed correctly instead of doing the work (measured on
// task d234aa7f; the two runs that carried a hand-written preface did work, and
// failed on the account's session limit, not on routing). The window's own
// folder never decides where the work belongs; the task text does. So the
// dispatcher now says that itself, in front of every task.
//
// WHY AT CLAIM TIME
//  * the worker needs no change: it already writes the claim response's `prompt`
//    to the CLI's stdin (scripts/windows/marvin-code-worker.ps1);
//  * the stored row -- and everything the owner reads on the dashboard -- keeps
//    the owner's own words, undoubled;
//  * PROMPT_MAX_CHARS stays the owner's budget instead of the boilerplate's;
//  * there are three enqueue call sites (REST, Telegram /code, approvals) and
//    exactly ONE claim, so one place covers all of them, queued rows included.
//
// WHAT IT MUST NOT DO: claim to know the executor's machine.
// Marveen runs here; the executor may be a Windows box, a second host, or this
// very machine. The one path this install can state as FACT is its own POSIX
// PROJECT_ROOT. The `\\wsl.localhost\...` form is how a Windows peer usually
// reaches a WSL filesystem, but nothing here has measured that it works from
// there -- so it goes in explicitly labelled as an unverified suggestion, never
// as an instruction, and the executor is told to check the path before building
// on it. (Marvin, 2026-09-06: "TILOS unverified UNC-t ... ugy beleirni mintha
// tudnank hogy mukodik. Amig nincs megmerve, az csak javaslat lehet.")

import { PROJECT_ROOT, APP_LANG } from '../config.js'
import { toLocalWorkspacePath } from './code-bridge-workspace.js'

/** What kind of host MARVEEN runs on. The caller measures it (detectHostKind);
 *  this module never guesses, because a wrong guess prints a path that cannot
 *  exist on the reader's machine. */
export type MarveenHostKind = 'wsl' | 'windows' | 'unix'

export interface PreambleInput {
  /** Where the claimed session runs, exactly as the worker reported it
   *  (`F:\...`, `\\wsl.localhost\...` or a POSIX path). May be empty: an empty
   *  value means "not known", and the preface then says MORE, not less. */
  workspacePath: string
  hostKind: MarveenHostKind
  /** Test seam; defaults to this install's own root. */
  projectRoot?: string
  /** Test seam; defaults to the WSL distro name from the environment. */
  distro?: string | null
  /** Test seam; defaults to the install language. */
  lang?: 'hu' | 'en'
}

/**
 * Is the session already working inside the Marveen checkout?
 *
 * If it is, the "here is where the source lives" paragraph is pure noise and is
 * left out. A path we cannot translate to this machine's view counts as
 * OUTSIDE: "I cannot tell" must not silently become "it is already there".
 */
function isInsideRepo(workspacePath: string, root: string): boolean {
  const raw = (workspacePath ?? '').trim()
  if (raw === '') return false
  const local = toLocalWorkspacePath(raw)
  if (local === null) return false
  // A Windows-shaped path is case-insensitive; a POSIX one is not, and folding
  // its case could mistake a different directory for the repo.
  const winShaped = !raw.startsWith('/')
  const norm = (s: string): string => (winShaped ? s.toLowerCase() : s).replace(/[\\/]+$/, '')
  const a = norm(local)
  const b = norm(root)
  return a === b || a.startsWith(b + '/')
}

/** The WSL distro name, or null when this process cannot see it. Absent under a
 *  systemd user service -- which is how Marveen actually runs -- so "not known"
 *  is a normal answer here, and the text says so rather than inventing a name. */
function envDistro(): string | null {
  const v = (process.env['WSL_DISTRO_NAME'] ?? '').trim()
  return v === '' ? null : v
}

function sourceParagraph(root: string, hostKind: MarveenHostKind, distro: string | null, hu: boolean): string {
  const winRoot = root.replace(/\//g, '\\')
  const head = hu
    ? `2. Ha a feladat a Marveen sajat forrasat erinti: az ezen a telepitesen a(z) ${root} uton van.`
    : `2. If the task concerns Marveen's own source: on this install it lives at ${root}.`
  if (hostKind === 'wsl') {
    const name = distro ?? 'Ubuntu'
    const guessNote = distro
      ? ''
      : hu
        ? ' (a disztro nevet innen nem latjuk, ez csak a szokasos alapertelmezes)'
        : ' (the distro name is not visible from here; this is only the usual default)'
    return head + (hu
      ? ` Marveen WSL-ben fut. Hogy ez a TE gepedrol milyen uton latszik, azt innen nem tudjuk megmerni.`
        + ` Ha Windowsrol dolgozol, a WSL fajlrendszer szokasos alakja \\\\wsl.localhost\\${name}${winRoot}${guessNote}`
        + ` -- ezt ezen a telepitesen SENKI NEM MERTE MEG, tehat javaslat, nem parancs. Eloszor gyozodj meg rola,`
        + ` hogy tenyleg eled az utat, es csak utana epits ra.`
      : ` Marveen runs inside WSL. What that path looks like from YOUR machine cannot be measured from here.`
        + ` If you are on Windows, the usual form is \\\\wsl.localhost\\${name}${winRoot}${guessNote}`
        + ` -- nothing on this install has verified it, so treat it as a suggestion, not an instruction. Check that`
        + ` you can actually reach the path before building on it.`)
  }
  if (hostKind === 'windows') {
    return head + (hu
      ? ` Ugyanezen a gepen ez ${winRoot} alakban latszik; ha te MASIK gepen futsz, az odavezeto utat innen nem tudjuk megmondani.`
      : ` On this same machine that reads as ${winRoot}; if you run on a DIFFERENT machine, the path from there cannot be stated from here.`)
  }
  return head + (hu
    ? ` Hogy ez a te gepedrol milyen uton erheto el, azt innen nem tudjuk megmondani -- eloszor gyozodj meg rola, hogy eled.`
    : ` How that path is reachable from your machine cannot be stated from here -- check that you can reach it first.`)
}

/**
 * The preface itself. Always four short paragraphs at most: what decides where
 * the work belongs, where the source is (only when the session is NOT already
 * in it), how to work on it, and what to do when a step cannot run here.
 */
export function buildCodeTaskPreamble(input: PreambleInput): string {
  const root = input.projectRoot ?? PROJECT_ROOT
  const hu = (input.lang ?? (APP_LANG === 'hu' ? 'hu' : 'en')) === 'hu'
  const distro = input.distro === undefined ? envDistro() : input.distro
  const out: string[] = []

  out.push(hu
    ? '[KOD-HID ELOHANG -- ezt a Marveen dashboard fuzte ide, nem a feladat kuldoje irta.]'
    : '[CODE BRIDGE PREFACE -- added by the Marveen dashboard, not written by the sender.]')

  out.push(hu
    ? '1. A munka helyet a FELADAT SZOVEGE donti el, nem az, hogy ez a VS Code ablak melyik mappaban all.'
      + ' A feladat jo helyre erkezett: ne allj le rakerdezni a routingra, es ne kerdezd meg, hogy neked szol-e.'
    : '1. WHERE the work belongs is decided by the TASK TEXT, not by which folder this VS Code window happens to'
      + ' be open in. The task reached the right place: do not stop to ask about routing or whether it is meant for you.')

  if (!isInsideRepo(input.workspacePath, root)) {
    out.push(sourceParagraph(root, input.hostKind, distro, hu))
  }

  out.push(hu
    ? '3. Ha a Marveen forrasan dolgozol: izolalt git worktree-ben (scripts/agent-worktree.sh), a vegen teljes'
      + ' teszt + tsc, a landolas scripts/land-pr.sh (PR + CI) -- a main-re direkt push tilos. Kanban kartyat ne mozgass.'
    : '3. If you work on the Marveen source: do it in an isolated git worktree (scripts/agent-worktree.sh), finish'
      + ' with the full test suite + tsc, and land through scripts/land-pr.sh (PR + CI) -- never push straight to main.'
      + ' Do not move kanban cards.')

  out.push(hu
    ? '4. Ha barmelyik lepes ezen a gepen nem fut le (nem ered el az utat, hianyzik egy eszkoz), NE talalgass es ne'
      + ' kerulgesd: allj meg, es mondd meg pontosan, melyik parancs milyen hibauzenetet adott.'
    : '4. If any step cannot run on your machine (the path is unreachable, a tool is missing), do NOT guess and do'
      + ' NOT work around it: stop and report exactly which command produced which error message.')

  // 5. WHY THE LANGUAGE IS SAID OUT LOUD (kanban #233)
  // The completion notice quotes the executor's closing summary VERBATIM --
  // that path is deliberately token-free, so nothing downstream can translate
  // it (see code-bridge-notify.ts). The install language therefore has to be
  // stated here, at the only point where the text is still being written.
  // Boss, 2026-09-06: "ha angolra van allitva akor angolul".
  out.push(hu
    ? '5. A ZARO OSSZEFOGLALOT -- amit a tulajdonos a Telegramon fog olvasni -- MAGYARUL ird meg, ez ennek a'
      + ' telepitesnek a nyelve. A Marveen szo szerint idezi, forditani nem tudja. A kod, a kommentek, a commit-uzenetek'
      + ' es a nyers parancs-kimenetek maradnak ugy, ahogy vannak.'
    : '5. Write the CLOSING SUMMARY -- the text the owner will read in Telegram -- in ENGLISH, this install\'s'
      + ' language. Marveen quotes it verbatim and cannot translate it. Code, comments, commit messages and raw'
      + ' command output stay as they are.')

  return out.join('\n')
}

/** The prompt as the executor should receive it. */
export function withCodeTaskPreamble(prompt: string, input: PreambleInput): string {
  return `${buildCodeTaskPreamble(input)}\n\n---\n\n${prompt}`
}
