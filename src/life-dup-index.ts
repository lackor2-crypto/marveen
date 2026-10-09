// WHICH FILES IN THE LIFE TREE ARE COPIES OF EACH OTHER (#513, point 4).
//
// The owner chose both views (TG 8265, "C"): the Explorer marks a file that is
// in the Life tree more than once, and the Drive / MEGA pages say whether a
// cloud file is already in the Life tree or only in the cloud.
//
// Both need to know the tree's content, and the tree is large and slow
// (measured 2026-10-09: 73,964 files, 738.9 GB on a 9p mount; 50,272 files
// share a size with another one, 374.7 GB). So:
//
//   - NOTHING here runs inside a request. One background run walks the tree
//     (path, size, mtime -- about a minute), then hashes ONLY the files that
//     share their size with another one, smallest first. It yields, it can be
//     stopped, and it resumes: a hash is kept while the file's size and mtime
//     are what they were when it was taken.
//   - "Not found" is only said from a FINISHED run. Before that the answer is
//     "not checked yet" -- zero copies from an index that never ran is not
//     "no copies".
//   - Two files are "the same" only by size + md5. A cloud that gives no hash
//     (MEGA) can only match by name + size, and that answer is its own word
//     ("probable"), never "present".
//
// The run is started by the owner from the page. It only reads.

import { readdir, stat } from 'node:fs/promises'
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { STORE_DIR } from './config.js'
import { getDb } from './db.js'
import { depotRoot, DEPOT_SYSTEM_ROOT } from './depot.js'
import { hashFile } from './life-doc-ids.js'
import { listMounts } from './life-mounts.js'
import { trashRelPath, legacyTrashRelPath } from './life-tree.js'
import { logger } from './logger.js'

const norm = (rel: string): string => String(rel || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
const WALK_MAX_DEPTH = 40

export type DupPhase = 'idle' | 'scanning' | 'hashing'

export interface DupStatus {
  phase: DupPhase
  /** True until one run has finished completely: answers are "not checked yet" until then. */
  neverFinished: boolean
  startedAt: string | null
  finishedAt: string | null
  /** Files seen by the walk of the current / last run. */
  files: number
  /** Files that share their size with another one (the only ones that are hashed). */
  candidates: number
  candidateBytes: number
  hashedFiles: number
  hashedBytes: number
  /** Files that could not be read (kept out of every answer, counted here). */
  unreadable: number
  /** The run was stopped by the owner before it finished. */
  stopped: boolean
  /** The tree root could not be walked: nothing was concluded from this run. */
  rootError: string | null
}

interface Row { rel: string; size: number; mtime_ms: number; md5: string | null; hashed_size: number | null; hashed_mtime_ms: number | null }

let tablesDb: unknown = null
function ensureTables(): void {
  const db = getDb()
  if (tablesDb === db) return
  db.exec(`
    CREATE TABLE IF NOT EXISTS life_file_index (
      rel TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      size INTEGER NOT NULL,
      mtime_ms INTEGER NOT NULL,
      md5 TEXT,
      hashed_size INTEGER,
      hashed_mtime_ms INTEGER,
      run INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_life_file_index_size ON life_file_index(size);
    CREATE INDEX IF NOT EXISTS idx_life_file_index_md5 ON life_file_index(md5);
    CREATE INDEX IF NOT EXISTS idx_life_file_index_name ON life_file_index(name, size);
  `)
  tablesDb = db
}

function statusFile(): string { return join(STORE_DIR, 'life-dup-index.json') }

const EMPTY: DupStatus = {
  phase: 'idle', neverFinished: true, startedAt: null, finishedAt: null, files: 0, candidates: 0,
  candidateBytes: 0, hashedFiles: 0, hashedBytes: 0, unreadable: 0, stopped: false, rootError: null,
}

let live: DupStatus | null = null
let running: Promise<DupStatus> | null = null
let stopAsked = false

function readSaved(): DupStatus {
  try {
    const j = JSON.parse(readFileSync(statusFile(), 'utf8'))
    // A saved "scanning"/"hashing" is a run the process did not survive: it is idle now.
    return { ...EMPTY, ...j, phase: 'idle' }
  } catch { return { ...EMPTY } }
}

function save(s: DupStatus): void {
  try {
    if (!existsSync(STORE_DIR)) mkdirSync(STORE_DIR, { recursive: true })
    const tmp = statusFile() + '.tmp'
    writeFileSync(tmp, JSON.stringify(s), 'utf8')
    renameSync(tmp, statusFile())
  } catch (err) { logger.warn({ err: String(err) }, '[masolatok] could not save the run status') }
}

export function dupStatus(): DupStatus {
  return live ? { ...live } : readSaved()
}

/** Ask a running pass to stop after the file it is on. Hashes taken so far are kept. */
export function stopDupIndex(): DupStatus {
  if (running) stopAsked = true
  return dupStatus()
}

const yieldNow = (): Promise<void> => new Promise<void>((r) => setImmediate(r))

async function scan(root: string, run: number, s: DupStatus): Promise<boolean> {
  try { if (!(await stat(root)).isDirectory()) { s.rootError = 'not a folder'; return false } } catch (err: any) {
    s.rootError = String(err?.code || err?.message || err)
    return false
  }
  const db = getDb()
  const skip = new Set<string>([norm(trashRelPath()), norm(legacyTrashRelPath()), norm(DEPOT_SYSTEM_ROOT)])
  for (const m of listMounts()) skip.add(m.rel)
  const upsert = db.prepare(`
    INSERT INTO life_file_index (rel, name, size, mtime_ms, run) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(rel) DO UPDATE SET name = excluded.name, size = excluded.size, mtime_ms = excluded.mtime_ms, run = excluded.run`)
  let dirs = 0
  let complete = true
  const walk = async (rel: string, depth: number): Promise<void> => {
    if (stopAsked) return
    if (depth > WALK_MAX_DEPTH) { complete = false; return }
    let entries: import('node:fs').Dirent[]
    try { entries = await readdir(rel ? join(root, ...rel.split('/')) : root, { withFileTypes: true }) } catch {
      // A folder that cannot be listed makes the picture partial: nothing under it may be called "gone".
      complete = false
      s.unreadable++
      return
    }
    if (++dirs % 32 === 0) await yieldNow()
    // A git repository is version control's business: its files are not "copies" to tidy up.
    if (entries.some((e) => e.name === '.git')) return
    const batch: Array<[string, string, number, number]> = []
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'desktop.ini') continue
      const child = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) { if (!skip.has(child)) await walk(child, depth + 1); continue }
      if (!e.isFile()) continue
      try {
        const st = await stat(join(root, ...child.split('/')))
        batch.push([child, e.name, st.size, Math.round(st.mtimeMs)])
      } catch { s.unreadable++ }
    }
    if (batch.length) {
      db.transaction(() => { for (const b of batch) upsert.run(b[0], b[1], b[2], b[3], run) })()
      s.files += batch.length
    }
  }
  await walk('', 0)
  if (stopAsked) return false
  // Rows the walk did not see are files that are gone -- but ONLY a complete walk may say so.
  if (complete) db.prepare('DELETE FROM life_file_index WHERE run != ?').run(run)
  return true
}

const CANDIDATES = `
  FROM life_file_index
  WHERE size > 0 AND size IN (SELECT size FROM life_file_index WHERE size > 0 GROUP BY size HAVING COUNT(*) > 1)`
const STALE = `(md5 IS NULL OR hashed_size IS NOT size OR hashed_mtime_ms IS NOT mtime_ms)`

async function hashPending(root: string, s: DupStatus): Promise<void> {
  const db = getDb()
  const tot = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS b ${CANDIDATES}`).get() as { n: number; b: number }
  s.candidates = tot.n
  s.candidateBytes = tot.b
  const done = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS b ${CANDIDATES} AND NOT ${STALE}`).get() as { n: number; b: number }
  s.hashedFiles = done.n
  s.hashedBytes = done.b
  const nextBySize = db.prepare(`SELECT rel, size, mtime_ms ${CANDIDATES} AND ${STALE} AND (size > ? OR (size = ? AND rel > ?)) ORDER BY size ASC, rel ASC LIMIT 200`)
  const put = db.prepare('UPDATE life_file_index SET md5 = ?, hashed_size = ?, hashed_mtime_ms = ? WHERE rel = ?')
  let afterSize = 0
  let afterRel = ''
  let sinceSave = 0
  for (;;) {
    const rows = nextBySize.all(afterSize, afterSize, afterRel) as Array<{ rel: string; size: number; mtime_ms: number }>
    if (!rows.length) return
    for (const r of rows) {
      if (stopAsked) return
      afterSize = r.size
      afterRel = r.rel
      try {
        const h = await hashFile(join(root, ...r.rel.split('/')))
        // The file changed while it was read: this hash describes nothing that exists. Left for the next run.
        if (h.size === r.size) {
          put.run(h.md5, r.size, r.mtime_ms, r.rel)
          s.hashedFiles++
          s.hashedBytes += r.size
        }
      } catch { s.unreadable++ }
      if (++sinceSave >= 50) { sinceSave = 0; save(s) }
      await yieldNow()
    }
  }
}

/**
 * Start a run (or join the one that is running). Returns at once with the
 * status; the work goes on in the background.
 */
export function startDupIndex(): DupStatus {
  if (running) return dupStatus()
  ensureTables()
  const root = depotRoot()
  const prev = readSaved()
  const s: DupStatus = {
    ...EMPTY, neverFinished: prev.neverFinished, phase: 'scanning', startedAt: new Date().toISOString(),
    finishedAt: prev.finishedAt,
  }
  live = s
  stopAsked = false
  running = (async () => {
    try {
      if (!root) { s.rootError = 'no depot'; return s }
      const run = Date.now()
      const walked = await scan(root, run, s)
      if (walked) {
        s.phase = 'hashing'
        save(s)
        await hashPending(root, s)
      }
      s.stopped = stopAsked
      if (walked && !stopAsked) { s.neverFinished = false; s.finishedAt = new Date().toISOString() }
    } catch (err) {
      s.rootError = s.rootError || String((err as Error)?.message || err)
      logger.warn({ err }, '[masolatok] the copy index run failed')
    } finally {
      s.phase = 'idle'
      save(s)
      logger.info({ files: s.files, candidates: s.candidates, hashed: s.hashedFiles, stopped: s.stopped, rootError: s.rootError }, '[masolatok] copy index run ended')
      live = null
      running = null
      stopAsked = false
    }
    return s
  })()
  return { ...s }
}

/** For tests: wait for the running pass. */
export async function waitDupIndex(): Promise<DupStatus> {
  return running ? await running : dupStatus()
}

const FRESH = `md5 IS NOT NULL AND hashed_size IS size AND hashed_mtime_ms IS mtime_ms`

/**
 * The files directly in `folderRel` that have a copy elsewhere in the Life
 * tree: name -> where the other copies are. Only proven copies (size + md5).
 * `checked: false` = no run has finished yet, so an empty answer means
 * "not checked", not "no copies".
 */
export function duplicatesIn(folderRel: string): { checked: boolean; copies: Record<string, string[]> } {
  ensureTables()
  const st = dupStatus()
  const folder = norm(folderRel)
  const db = getDb()
  const prefix = folder ? folder + '/' : ''
  const rows = db.prepare(`
    SELECT rel, name, size, md5 FROM life_file_index
    WHERE rel >= ? AND rel < ? AND ${FRESH}`).all(prefix, prefix + '￿') as Array<{ rel: string; name: string; size: number; md5: string }>
  const others = db.prepare(`SELECT rel FROM life_file_index WHERE size = ? AND md5 = ? AND rel != ? AND ${FRESH} ORDER BY rel LIMIT 50`)
  const copies: Record<string, string[]> = {}
  for (const r of rows) {
    if (r.rel.slice(prefix.length).includes('/')) continue // deeper than this folder
    const o = (others.all(r.size, r.md5, r.rel) as Array<{ rel: string }>).map((x) => x.rel)
    if (o.length) copies[r.name] = o
  }
  return { checked: !st.neverFinished, copies }
}

export type CloudMatchState = 'present' | 'probable' | 'absent' | 'unknown'
export interface CloudMatch { state: CloudMatchState; where: string[] }

/**
 * Is this cloud file already in the Life tree?
 *   present  -- a file of the same size and md5 is there (proven)
 *   probable -- the cloud gave no hash; a file of the same NAME and size is there
 *   absent   -- a finished run knows of no such file
 *   unknown  -- cannot be said: no run finished yet, the cloud gave no size
 *               (a Google document), or same-size files are not hashed yet
 */
export function matchCloudFiles(items: Array<{ name: string; size: number | null; md5?: string | null }>): CloudMatch[] {
  ensureTables()
  const checked = !dupStatus().neverFinished
  const db = getDb()
  const byMd5 = db.prepare(`SELECT rel FROM life_file_index WHERE size = ? AND md5 = ? AND ${FRESH} ORDER BY rel LIMIT 20`)
  const bySize = db.prepare(`SELECT COUNT(*) AS n, SUM(CASE WHEN ${FRESH} THEN 0 ELSE 1 END) AS stale FROM life_file_index WHERE size = ?`)
  const byName = db.prepare('SELECT rel FROM life_file_index WHERE name = ? AND size = ? ORDER BY rel LIMIT 20')
  return items.map((it) => {
    const size = typeof it.size === 'number' && it.size >= 0 ? it.size : null
    if (size === null) return { state: 'unknown' as const, where: [] }
    const md5 = String(it.md5 || '').toLowerCase()
    if (md5) {
      const hit = (byMd5.all(size, md5) as Array<{ rel: string }>).map((x) => x.rel)
      if (hit.length) return { state: 'present' as const, where: hit }
      const c = bySize.get(size) as { n: number; stale: number | null }
      // Same-size files exist but are not hashed (a file that is alone at its size is never hashed
      // by the run): it may be the same file, and that is not known.
      if (c.n > 0 && (c.stale || 0) > 0) return { state: 'unknown' as const, where: [] }
      return { state: checked ? 'absent' as const : 'unknown' as const, where: [] }
    }
    const hit = (byName.all(String(it.name || ''), size) as Array<{ rel: string }>).map((x) => x.rel)
    if (hit.length) return { state: 'probable' as const, where: hit }
    return { state: checked ? 'absent' as const : 'unknown' as const, where: [] }
  })
}
