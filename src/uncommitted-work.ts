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
