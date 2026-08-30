// Pure logic for the "someone left work uncommitted" guard (kanban 18bf8b2c,
// point 4).
//
// Why (Boss, 2026-08-11): the evening's collisions all had the same shape --
// several agents' edits sitting side by side in one working tree, uncommitted,
// with no way to tell whose was whose. Version control is the safety net the
// industry leans on for exactly this (commit rather than overwrite, so a
// supervisor can roll back), but a net only works if the work actually lands in
// it. Uncommitted edits are also what makes a collision expensive: two agents in
// one file is survivable if both sides are committed, and a mess if neither is.
//
// What this deliberately does NOT do: commit on anyone's behalf. An automatic
// commit of half-finished work is worse than the problem -- it manufactures
// broken states that look deliberate. It reports, and lets whoever owns the
// change decide.

/** How long a file may sit modified before it is worth mentioning. Long enough
 *  that ordinary edit-test-commit cycles never trigger it. */
export const UNCOMMITTED_STALE_MS = 3 * 60 * 60_000

export interface DirtyFile {
  path: string
  /** Modification time of the file on disk (ms). */
  modifiedAt: number
}

export interface UncommittedAlertState {
  /** The set of paths the last alert covered, so an unchanged mess stays quiet. */
  lastSignature: string
  lastAlertAt: number
}

export const INITIAL_UNCOMMITTED_STATE: UncommittedAlertState = Object.freeze({ lastSignature: '', lastAlertAt: 0 })

/** Files dirty for longer than the threshold, oldest first. */
export function staleDirtyFiles(files: DirtyFile[], now: number, staleMs: number = UNCOMMITTED_STALE_MS): DirtyFile[] {
  return files
    .filter(f => now - f.modifiedAt >= staleMs)
    .sort((a, b) => a.modifiedAt - b.modifiedAt)
}

export function dirtySignature(files: DirtyFile[]): string {
  return files.map(f => f.path).sort().join('|')
}

/**
 * Whether to speak up now.
 *
 * Only when the SET of stale files has changed since the last alert: a working
 * tree that stays messy for a week must not produce a message every hour, or
 * the owner learns to ignore it -- and then a genuinely new mess goes unnoticed
 * too. A file that gets committed and a new one that goes stale both change the
 * signature, which is exactly when the news is new.
 */
export function shouldAlertUncommitted(
  stale: DirtyFile[],
  state: UncommittedAlertState,
): boolean {
  if (stale.length === 0) return false
  return dirtySignature(stale) !== state.lastSignature
}

/** One short line for the owner's channel. */
export function describeUncommitted(stale: DirtyFile[], now: number): string {
  const oldest = stale[0]
  const hours = Math.max(1, Math.round((now - oldest.modifiedAt) / 3_600_000))
  const names = stale.slice(0, 6).map(f => f.path)
  const more = stale.length > names.length ? ` (+${stale.length - names.length} tovabbi)` : ''
  return `📝 ${stale.length} commitolatlan fajl all a repoban, a legregebbi ${hours} oraja: `
    + names.join(', ') + more
    + '. Ha keszen van, commitold; ha nem, erdemes sajat worktree-ben folytatni (scripts/agent-worktree.sh).'
}

// ---------------------------------------------------------------------------
// A MASODIK ES A HARMADIK MODJA ANNAK, HOGY MUNKA MARADJON A FAN
//
// Boss, 2026-08-30: "mindig szokott maradni commitolatlan pusholatlan dolgok es
// akkor a masik agent eszreveszi o itt van egy felbehagyott munka -- nem, amikor
// vege van a munkanak commit es push azonnal" -- es kulon: "onmagatol ne
// keletkezzen semmilyen fajl (...) kesobb itt kiderul, hogy na egyebkent meg 8
// darab fajl ott van".
//
// A fenti figyelo eddig CSAK a kovetett, modositott fajlokat nezte, mert egy
// nem-kovetett scratch fajl "nem kockazatban levo munka". Ez igaz -- de attol
// meg ott van, es 2026-08-29-en pontosan igy allt egy napig nyolc probaszkript
// a repo gyokereben, szo nelkul. Ket uj kategoria, KULON mondattal, mert ket
// kulon teendo tartozik hozzajuk:
//
//   * szemet (nem-kovetett)  -> torold, vagy ha kell, commitold;
//   * pusholatlan commit     -> pushold, kulonben a kovetkezo agens felbehagyott
//                               munkat lat.
//
// A pusholatlan darabszam lehet NULL is, es az NEM nulla: "nincs upstream" vagy
// "nem tudtam megkerdezni a gitet" mas, mint "minden fel van pusholva". A hivo
// a null-t NEM mondja ki nullakent.
// ---------------------------------------------------------------------------

export interface TreeMess {
  /** Kovetett, modositott fajlok, amik mar tul regota allnak. */
  dirty: DirtyFile[]
  /** Nem-kovetett fajlok, amik mar tul regota allnak. */
  stray: DirtyFile[]
  /** Felpusholatlan commitok szama, vagy null = nem tudtam megkerdezni. */
  unpushed: number | null
  /** Az ag neve a pusholatlan mondathoz ('' = nem tudom). */
  branch: string
}

export function messSignature(m: TreeMess): string {
  return [
    dirtySignature(m.dirty),
    dirtySignature(m.stray),
    m.unpushed === null ? '?' : String(m.unpushed),
  ].join('#')
}

/** Van-e egyaltalan mondanivalo. A null unpushed sosem indit riasztast. */
export function messIsEmpty(m: TreeMess): boolean {
  return m.dirty.length === 0 && m.stray.length === 0 && !(m.unpushed && m.unpushed > 0)
}

export function shouldAlertMess(m: TreeMess, state: UncommittedAlertState): boolean {
  if (messIsEmpty(m)) return false
  return messSignature(m) !== state.lastSignature
}

function oraja(files: DirtyFile[], now: number): number {
  return Math.max(1, Math.round((now - files[0].modifiedAt) / 3_600_000))
}

function nevek(files: DirtyFile[]): string {
  const names = files.slice(0, 6).map(f => f.path)
  return names.join(', ') + (files.length > names.length ? ` (+${files.length - names.length} tovabbi)` : '')
}

/** Egy-harom rovid sor a tulajdonos csatornajara. Null, ha nincs mit mondani. */
export function describeMess(m: TreeMess, now: number): string | null {
  if (messIsEmpty(m)) return null
  const sorok: string[] = []
  if (m.dirty.length) {
    sorok.push(`📝 ${m.dirty.length} commitolatlan fajl all a repoban, a legregebbi ${oraja(m.dirty, now)} oraja: `
      + nevek(m.dirty)
      + '. Ha keszen van, commitold; ha nem, erdemes sajat worktree-ben folytatni (scripts/agent-worktree.sh).')
  }
  if (m.stray.length) {
    sorok.push(`🧹 ${m.stray.length} nem-kovetett fajl all a repoban, a legregebbi ${oraja(m.stray, now)} oraja: `
      + nevek(m.stray)
      + '. Ez nem kockazatban levo munka, hanem szemet: ha a fejlesztes keszen van, TOROLD -- ha a projekt resze, commitold.')
  }
  if (m.unpushed && m.unpushed > 0) {
    sorok.push(`⬆️ ${m.unpushed} commit nincs felpusholva${m.branch ? ` (${m.branch})` : ''}. `
      + 'A munka vegen a push is a munka resze: pusholatlanul a kovetkezo agens felbehagyott munkat lat.')
  }
  return sorok.join('\n')
}
