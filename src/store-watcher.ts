import { watch, statSync, lstatSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { STORE_DIR } from './config.js'
import { logStoreFileEvent } from './db.js'
import { logger } from './logger.js'

// --- System file denylist ---
// Only files NOT on this list (and not matching SYSTEM_RE) are logged.
// Everything else = Marveen-managed state that would produce noise.
// "Agent-created" files are those that remain after filtering.
const SYSTEM_FILES = new Set([
  // SQLite database
  'claudeclaw.db', 'claudeclaw.db-wal', 'claudeclaw.db-shm',
  // Marveen runtime / scheduler state
  'schedule-last-run.json', 'external-ops-last-run',
  'kanban-audit-state.json',
  // Settings and config overrides written by dashboard routes
  'config-overrides.json', 'dashboard-settings.json',
  // Fleet and agent management
  'agents-desired.json', 'auto-restart.json', 'autonomy-config.json',
  // Auth and secrets
  '.dashboard-token', '.vault-key', 'vault.json', '.claude-oauth-token',
  // Federation config + inbound peer token (written by /api/federation/peers)
  'federation.json', '.federation-token',
  // Capability-summary cache (written by the capability-summary runner);
  // capability text, not a secret -- deliberately NOT in SENSITIVE_NAMES.
  'capability-summaries.json',
  // Usage and keepalive
  'claude-usage.json', '.channel-keepalive', '.channel-last-respawn',
  // Known Marveen-written log files
  'channels.log', 'channels.error.log',
  'dashboard.log', 'dashboard.error.log',
  'update.log',
])

// Regex for system-generated filename patterns.
// Also covers atomic-write temp files (keep in sync with settings-store.ts).
const SYSTEM_RE = /\.pid$|\.tmp$|\.tmp\.[a-f0-9]+$|\.migrated$|\.bak$|^\.DS_Store$/

// Filenames whose presence is sensitive; the audit row is flagged so the UI
// can show a sanitised label instead of hinting at secret values.
const SENSITIVE_NAMES = new Set(['.dashboard-token', 'vault.json', '.vault-key', '.claude-oauth-token', '.federation-token', 'federation.json'])

// --- Agent attribution slot ---
// Node.js is single-threaded; a route handler sets this before writing,
// the watch callback reads and clears it in the next event-loop tick.
// For direct writes (Bash/Write tool from outside the process), this stays
// null -- stored as null, shown as "ismeretlen" in the UI. There is no
// OS-level mechanism to identify the writer without a process audit daemon,
// so null is the honest and correct value.
let currentWriteActor: string | null = null

export function setStoreWriteActor(actor: string): void {
  currentWriteActor = actor
}

export function clearStoreWriteActor(): void {
  currentWriteActor = null
}

// --- Known-files tracking for creation detection ---
// Populated at watcher startup by scanning store/. A rename event for a path
// NOT in this set where the file NOW EXISTS means a new file was created.
let knownFiles = new Set<string>()

// --- Dedup ---
// fs.watch fires the same (eventType, filename) multiple times for a single
// logical operation. Collapse repeats within a short window.
const DEDUP_MS = 1000
const recentEvents = new Map<string, number>()

/** Directory (relative to STORE_DIR, '' = the root) -> its watcher. */
const dirWatchers = new Map<string, ReturnType<typeof watch>>()
let started = false
let generation = 0
/** True while the first walk fills knownFiles; events of that time wait in `pendingDuringSeed`. */
let seeding = false
const pendingDuringSeed = new Set<string>()
let seedDone: Promise<void> = Promise.resolve()
let reportedWatchErrors = new Set<string>()

function isSystemFile(rel: string): boolean {
  const name = basename(rel)
  return SYSTEM_FILES.has(name) || SYSTEM_RE.test(name)
}

/**
 * fs.watch({ recursive }) on Linux walks the tree in userland and THROWS from an
 * event handler when it meets an entry it cannot watch (a mode-000 file inside a
 * restore stage, a vanished dir). That throw cannot be caught around watch() and
 * reaches process 'uncaughtException'; it is watcher noise, not a reason to take
 * the dashboard down (incident 2026-10-03: a restore crashed the dashboard twice).
 */
export function isBenignWatchError(err: unknown): boolean {
  const e = err as { syscall?: string; code?: string } | null
  return !!e && e.syscall === 'watch' && (e.code === 'EACCES' || e.code === 'ENOENT' || e.code === 'EPERM')
}

/** Resolves when the first walk of store/ has finished (all directories watched, knownFiles filled). */
export function storeWatcherReady(): Promise<void> {
  return seedDone
}

/**
 * #860: one non-recursive watcher per directory, found by an ASYNC walk. Node's own recursive watch option on Linux walks
 * the tree in userland with a synchronous directory read and does it again for every new directory: on the 2.2 GB / 22 000 file store
 * (Claude session dirs under accounts/, backup staging under tmp/) the stall sampler caught it holding the dashboard
 * 3.3 s at a time (#watchFolder in internal/fs/recursive_watch). Coverage is the same: every directory under store/ is
 * watched, a new directory is adopted when its parent reports it, and its files are caught up through the same path.
 */
function watchDir(abs: string, rel: string): void {
  if (dirWatchers.has(rel)) return
  try {
    const w = watch(abs, { persistent: true }, (eventType, filename) => {
      if (!filename) return
      onEvent(rel ? `${rel}/${String(filename).replace(/\\/g, '/')}` : String(filename).replace(/\\/g, '/'), eventType)
    })
    // An unreadable subdirectory (another user's sandbox dir) can make a watcher emit 'error'; without a listener that
    // is an uncaughtException and the dashboard exits. Log once per (code, path), keep going.
    w.on('error', (err: NodeJS.ErrnoException) => {
      const key = JSON.stringify([err?.code ?? null, err?.path ?? null])
      if (reportedWatchErrors.has(key)) return
      reportedWatchErrors.add(key)
      logger.warn({ code: err?.code, path: err?.path }, 'store-watcher: subdirectory not watchable, skipped')
    })
    dirWatchers.set(rel, w)
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    const key = JSON.stringify([e?.code ?? null, e?.path ?? null, rel])
    if (reportedWatchErrors.has(key)) return
    reportedWatchErrors.add(key)
    logger.warn({ code: e?.code, rel }, 'store-watcher: directory not watchable, skipped')
  }
}

function closeDirTree(rel: string): void {
  for (const [k, w] of dirWatchers) {
    if (k === rel || k.startsWith(`${rel}/`)) {
      try { w.close() } catch { /* best-effort */ }
      dirWatchers.delete(k)
    }
  }
}

/** Watch `abs` and everything below it, asynchronously. `seed`: the files only fill knownFiles; otherwise they are
 *  files that appeared in a new directory before its watcher was ready, and go through the normal new-file path. */
async function walkTree(abs: string, rel: string, seed: boolean, gen: number): Promise<void> {
  if (gen !== generation) return
  watchDir(abs, rel)
  let entries: import('node:fs').Dirent[]
  try { entries = await readdir(abs, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    if (gen !== generation) return
    const childRel = rel ? `${rel}/${entry.name}` : entry.name
    if (entry.isDirectory()) await walkTree(join(abs, entry.name), childRel, seed, gen)
    else if (seed) knownFiles.add(childRel)
    else handleEntry(childRel, null)
  }
}

function onEvent(rel: string, eventType: string): void {
  // Consume (clear) the actor slot for ALL events, including system-file
  // events, so a slot set before a denylist-ed write cannot leak to the
  // next unrelated event.
  const agent = currentWriteActor
  currentWriteActor = null

  // Only rename events can indicate a new file. change = modification.
  if (eventType !== 'rename') return
  if (seeding) { pendingDuringSeed.add(rel); return }
  handleEntry(rel, agent)
}

function handleEntry(rel: string, agent: string | null): void {
  // If the entry no longer exists it was deleted or renamed away -- not a creation.
  let isDir = false
  try {
    // A directory is not a created file. The watcher reports 'rename' for a directory that appears; scanning only puts
    // FILES into knownFiles, so without this every directory would be logged as a new file (measured once: 26 527 rows
    // in one start, the synchronous INSERTs blocking the event loop for ~20 s).
    // lstat, not stat: a symlink to a directory is an entry the walk counts as a file, so a new one must still be
    // logged. The delete covers a known file replaced by a directory of the same name.
    isDir = lstatSync(`${STORE_DIR}/${rel}`).isDirectory()
  } catch {
    // Gone: deletion or rename-away. Update knownFiles, stop watching a vanished directory, and skip.
    knownFiles.delete(rel)
    closeDirTree(rel)
    return
  }
  if (isDir) {
    knownFiles.delete(rel)
    if (!dirWatchers.has(rel)) void walkTree(`${STORE_DIR}/${rel}`, rel, false, generation)
    return
  }

  // Skip system and temp files -- Marveen's own runtime writes.
  if (isSystemFile(rel)) return

  let fileSize: number | null = null
  try {
    fileSize = statSync(`${STORE_DIR}/${rel}`).size
  } catch {
    knownFiles.delete(rel)
    return
  }

  // Already known -> not a new creation (could be a rename-to-same or
  // replace; ignore to avoid false positives).
  if (knownFiles.has(rel)) return

  // Dedup: fs.watch may fire the rename event several times.
  const now = Date.now()
  const last = recentEvents.get(rel)
  if (last !== undefined && now - last < DEDUP_MS) return
  recentEvents.set(rel, now)
  if (recentEvents.size > 200) {
    for (const [k, t] of recentEvents) if (now - t >= DEDUP_MS) recentEvents.delete(k)
  }

  // New file -- record it and mark as known.
  knownFiles.add(rel)
  const isSensitive = SENSITIVE_NAMES.has(basename(rel)) ? 1 : 0

  try {
    logStoreFileEvent(rel, 'create', isSensitive, fileSize, agent)
  } catch (err) {
    logger.warn({ err, rel }, 'store-watcher: failed to log new file event')
  }
}

export function startStoreWatcher(): void {
  if (started) return
  started = true
  generation++
  const gen = generation
  knownFiles = new Set<string>()
  reportedWatchErrors = new Set<string>()
  pendingDuringSeed.clear()
  seeding = true
  seedDone = (async () => {
    try {
      await walkTree(STORE_DIR, '', true, gen)
    } catch (err) {
      logger.warn({ err }, 'Store file watcher failed to start')
    } finally {
      if (gen === generation) {
        seeding = false
        // Events that arrived during the first walk: a file the walk saw is known, a file it missed is new.
        const queued = [...pendingDuringSeed]
        pendingDuringSeed.clear()
        for (const rel of queued) handleEntry(rel, null)
        logger.info({ dir: STORE_DIR, knownCount: knownFiles.size, watchedDirs: dirWatchers.size }, 'Store file watcher started')
      }
    }
  })()
}

export function stopStoreWatcher(): void {
  generation++
  started = false
  seeding = false
  pendingDuringSeed.clear()
  for (const w of dirWatchers.values()) { try { w.close() } catch { /* best-effort */ } }
  dirWatchers.clear()
}
