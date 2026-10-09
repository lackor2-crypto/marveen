// #461: a work item's content must not live ONLY in the database. 2026-10-03 the live database was emptied
// and the presentation and business-card work items vanished although their files were still on the
// depot. This keeps ONE lossless snapshot file per work item next to the item (its own folder), written
// by a cheap periodic sweep (no hook in the many write paths: a missed path would lose data silently),
// and can rebuild the missing rows from those files. It never overwrites an existing row and never
// deletes anything the owner has.
//
// Where: <item folder>/marveen-item.json; an item without an own folder goes to
// <project folder>/.marveen-items/<id>.json. Project brand: <project folder>/marveen-brand.json.
// A permanently deleted item gets a TOMBSTONE in its snapshot, so the rebuild never revives it.

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { getDb } from './db.js'
import { logger } from './logger.js'
import { getProject, listProjects, type ProjectRow } from './projects.js'
import { projectFileTarget } from './project-files.js'
import { writeBlockReason } from './git-guard.js'
import { explorerRoot } from './life-explorer.js'
import { createWorkItem, ensureWorkbenchTables, type WorkItemRow } from './workbench.js'

export const SNAPSHOT_FILE = 'marveen-item.json'
export const SNAPSHOT_FALLBACK_DIR = '.marveen-items'
export const BRAND_FILE = 'marveen-brand.json'
export const SNAPSHOT_FORMAT = 1
export const SWEEP_MS = 60_000

/** Tables with a work_item_id column that are NOT part of an item's content. */
const SKIP_TABLES = new Set(['work_items', 'wb_doc_mirror', 'work_item_share_key'])
const SKIP_PREFIXES = ['workbench_agent_', 'work_item_shares']
/** Columns that must never reach a file on the depot. */
const SECRET_COL = /token|secret|passw|api_?key|credential|private_key/i

type Row = Record<string, unknown>

interface Snapshot {
  format: number
  exportedAt?: string
  tombstone?: boolean
  id?: string
  item?: Row
  project?: Row
  schema?: Record<string, string>
  tables?: Record<string, Row[]>
  doc_sources?: Row[]
}

const q = (t: string): string => `"${t.replace(/"/g, '""')}"`

function clean(row: Row): Row {
  const out: Row = {}
  for (const [k, v] of Object.entries(row)) if (!SECRET_COL.test(k)) out[k] = v
  return out
}

function contentTables(): { name: string; sql: string }[] {
  const db = getDb()
  const res: { name: string; sql: string }[] = []
  for (const t of db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table'").all() as { name: string; sql: string }[]) {
    if (SKIP_TABLES.has(t.name) || SKIP_PREFIXES.some((p) => t.name.startsWith(p))) continue
    const cols = (db.prepare(`PRAGMA table_info(${q(t.name)})`).all() as { name: string }[]).map((c) => c.name)
    if (cols.includes('work_item_id')) res.push(t)
  }
  return res
}

const sha = (s: string): string => createHash('sha256').update(s).digest('hex')

function snapshotPath(item: WorkItemRow, project: ProjectRow, mkdirFallback: boolean): string | null {
  if (item.folder) {
    const t = projectFileTarget(project, item.folder)
    if (t.ok) return writeBlockReason(`${t.dirRel}/${SNAPSHOT_FILE}`) ? null : join(t.dirAbs, SNAPSHOT_FILE)
  }
  const root = projectFileTarget(project, '')
  if (!root.ok) return null
  if (writeBlockReason(`${root.dirRel}/${SNAPSHOT_FALLBACK_DIR}/${item.id}.json`)) return null // a git repository: never written into
  const dir = join(root.dirAbs, SNAPSHOT_FALLBACK_DIR)
  if (!existsSync(dir)) {
    if (!mkdirFallback) return null
    mkdirSync(dir, { recursive: true })
  }
  return join(dir, `${item.id}.json`)
}

function atomicWrite(path: string, text: string): void {
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, text, { mode: 0o644 })
  renameSync(tmp, path)
}

function readJson(path: string): Snapshot | null {
  try { return JSON.parse(readFileSync(path, 'utf8')) as Snapshot } catch { return null }
}

const written = new Map<string, string>() // item id -> content hash last written/seen
let lastChanges = -1
let lastSweep: { at: number; items: number; written: number; ms: number } | null = null

export function snapshotStatus(): { lastSweepAt: number | null; items: number; written: number } {
  return { lastSweepAt: lastSweep?.at ?? null, items: lastSweep?.items ?? 0, written: lastSweep?.written ?? 0 }
}

/** One pass: write the snapshot of every item whose content changed. Returns how many files were written. */
export function sweepSnapshots(opts: { force?: boolean } = {}): number {
  ensureWorkbenchTables()
  const db = getDb()
  // The writers share this connection: no change since the last pass -> nothing to do.
  const changes = (db.prepare('SELECT total_changes() AS c').get() as { c: number }).c
  if (!opts.force && changes === lastChanges) return 0
  const t0 = Date.now()
  const items = db.prepare('SELECT * FROM work_items').all() as WorkItemRow[]
  const tables = contentTables()
  const byItem = new Map<string, Record<string, Row[]>>()
  for (const t of tables) {
    for (const r of db.prepare(`SELECT * FROM ${q(t.name)}`).all() as Row[]) {
      const id = String(r['work_item_id'])
      let m = byItem.get(id)
      if (!m) byItem.set(id, (m = {}))
      ;(m[t.name] ??= []).push(clean(r))
    }
  }
  const schema: Record<string, string> = {}
  for (const t of tables) schema[t.name] = t.sql
  const sourcesByClaim = new Map<string, Row[]>()
  if (tables.some((t) => t.name === 'wb_doc_sources')) {
    for (const r of db.prepare('SELECT * FROM wb_doc_sources').all() as Row[]) {
      const k = String(r['claim_id'])
      ;(sourcesByClaim.get(k) ?? sourcesByClaim.set(k, []).get(k)!).push(clean(r))
    }
  }
  const projects = new Map<string, ProjectRow | undefined>()
  const optedOut = new Set<string>()
  try { for (const r of db.prepare('SELECT work_item_id AS id FROM work_item_snapshot_off').all() as { id: string }[]) optedOut.add(r.id) } catch { /* table appears with the first deleted snapshot */ }
  let n = 0
  for (const item of items) {
    try {
      let project = projects.get(item.project_id)
      if (!projects.has(item.project_id)) projects.set(item.project_id, (project = getProject(item.project_id)))
      if (!project) continue
      const tbl = byItem.get(item.id) ?? {}
      const docSources = (tbl['wb_doc_claims'] ?? []).flatMap((c) => sourcesByClaim.get(String(c['id'])) ?? [])
      const snap: Snapshot = { format: SNAPSHOT_FORMAT, id: item.id, item: clean(item as unknown as Row), project: clean(project as unknown as Row), schema, tables: tbl, doc_sources: docSources }
      const hash = sha(JSON.stringify(snap))
      if (written.get(item.id) === hash) continue
      if (optedOut.has(item.id)) continue // the owner deleted this item's snapshot: it is NOT written back
      const path = snapshotPath(item, project, true)
      if (!path) continue
      const existing = existsSync(path) ? readJson(path) : null
      if (existing?.tombstone) continue
      if (existing) {
        const { exportedAt: _drop, ...rest } = existing
        if (sha(JSON.stringify(rest)) === hash) { written.set(item.id, hash); continue }
      }
      atomicWrite(path, JSON.stringify({ ...snap, exportedAt: new Date().toISOString() }))
      written.set(item.id, hash)
      n++
    } catch (err) {
      logger.warn({ err, item: item.id }, 'workbench-snapshot: could not write one snapshot')
    }
  }
  // The project brand, one file per project folder.
  try {
    const hasBrand = (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'workbench_brand'").get())
    if (hasBrand) {
      for (const b of db.prepare('SELECT * FROM workbench_brand').all() as Row[]) {
        const project = getProject(String(b['project_id']))
        const root = project ? projectFileTarget(project, '') : null
        if (!project || !root || !root.ok) continue
        const templates = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'workbench_brand_templates'").get()
          ? (db.prepare('SELECT * FROM workbench_brand_templates WHERE project_id = ?').all(project.id) as Row[]).map(clean)
          : []
        const body = JSON.stringify({ format: SNAPSHOT_FORMAT, brand: clean(b), templates })
        const key = `brand:${project.id}`
        const h = sha(body)
        if (written.get(key) === h) continue
        const path = join(root.dirAbs, BRAND_FILE)
        atomicWrite(path, JSON.stringify({ ...JSON.parse(body), exportedAt: new Date().toISOString() }))
        written.set(key, h)
        n++
      }
    }
  } catch (err) {
    logger.warn({ err }, 'workbench-snapshot: could not write a brand snapshot')
  }
  lastChanges = changes
  lastSweep = { at: Date.now(), items: items.length, written: n, ms: Date.now() - t0 }
  return n
}

/** Called right before an item is permanently deleted: its snapshot becomes a tombstone (never revived). */
export function tombstoneSnapshot(item: WorkItemRow): void {
  try {
    const project = getProject(item.project_id)
    if (!project) return
    const path = snapshotPath(item, project, false)
    if (!path || !existsSync(path)) return
    atomicWrite(path, JSON.stringify({ format: SNAPSHOT_FORMAT, tombstone: true, id: item.id, at: new Date().toISOString() }))
    written.delete(item.id)
  } catch (err) {
    logger.warn({ err, item: item.id }, 'workbench-snapshot: could not write a tombstone')
  }
}

// ---------------------------------------------------------------------------
// Rebuild
// ---------------------------------------------------------------------------

export interface RestoreResult {
  scannedProjects: number
  restored: number
  projectsRebuilt: number
  alreadyThere: number
  tombstoned: number
  skipped: number
  adopted: number
  failed: number
}

const WALK_MAX_DEPTH = 10
const WALK_MAX_DIRS = 20_000

// #490: async, yielding between directories. The startup rebuild walks every project folder on the depot,
// and on the slow 9p mount (/mnt/f) the synchronous walk froze the WHOLE dashboard for ~45-55 s after every
// restart, i.e. after every deploy (measured 2026-10-09: 3163 dirs, 44 s).
async function walk(root: string, visit: (abs: string, name: string) => Promise<void>): Promise<void> {
  let dirs = 0
  const go = async (dir: string, depth: number): Promise<void> => {
    if (depth > WALK_MAX_DEPTH || dirs++ > WALK_MAX_DIRS) return
    let entries: import('node:fs').Dirent[]
    try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === '.git') continue
        if (e.name.startsWith('.') && e.name !== SNAPSHOT_FALLBACK_DIR) continue
        await go(join(dir, e.name), depth + 1)
      } else if (e.isFile()) await visit(join(dir, e.name), e.name)
    }
    await new Promise<void>((r) => setImmediate(r))
  }
  await go(root, 0)
}

async function readJsonAsync(path: string): Promise<Snapshot | null> {
  try { return JSON.parse(await readFile(path, 'utf8')) as Snapshot } catch { return null }
}

function insertRow(table: string, row: Row, existingCols: Set<string>): void {
  const cols = Object.keys(row).filter((c) => existingCols.has(c))
  if (!cols.length) return
  getDb().prepare(`INSERT OR IGNORE INTO ${q(table)} (${cols.map(q).join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
    .run(...cols.map((c) => { const v = row[c]; return v !== null && typeof v === 'object' ? JSON.stringify(v) : v }))
}

function colsOf(table: string): Set<string> {
  return new Set((getDb().prepare(`PRAGMA table_info(${q(table)})`).all() as { name: string }[]).map((c) => c.name))
}

function tableExists(name: string): boolean {
  return !!getDb().prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)
}

/** Rebuild one item from its snapshot. Never overwrites a row that exists. */
function restoreOne(snap: Snapshot, res: RestoreResult): void {
  const db = getDb()
  const item = snap.item as Row
  const id = String(item['id'])
  if (db.prepare('SELECT 1 FROM work_items WHERE id = ?').get(id)) { res.alreadyThere++; return }
  db.transaction(() => {
    const pid = String(item['project_id'])
    if (!getProject(pid)) {
      if (!snap.project) { res.skipped++; return }
      insertRow('projects', snap.project, colsOf('projects'))
      if (!getProject(pid)) { res.skipped++; return } // e.g. the slug is taken by another project
      res.projectsRebuilt++
    }
    for (const [t, sql] of Object.entries(snap.schema ?? {})) {
      if (!tableExists(t) && /^CREATE TABLE /i.test(sql)) db.exec(sql.replace(/^CREATE TABLE /i, 'CREATE TABLE IF NOT EXISTS '))
    }
    const row = { ...item }
    const seqTaken = row['seq'] != null && db.prepare('SELECT 1 FROM work_items WHERE seq = ?').get(row['seq'] as number)
    if (seqTaken || row['seq'] == null) row['seq'] = ((db.prepare('SELECT MAX(seq) AS m FROM work_items').get() as { m: number | null }).m ?? 0) + 1
    insertRow('work_items', row, colsOf('work_items'))
    for (const [t, rows] of Object.entries(snap.tables ?? {})) {
      if (!tableExists(t)) continue
      const cols = colsOf(t)
      for (const r of rows) insertRow(t, r, cols)
    }
    if (tableExists('wb_doc_sources')) {
      const cols = colsOf('wb_doc_sources')
      for (const r of snap.doc_sources ?? []) insertRow('wb_doc_sources', r, cols)
    }
    res.restored++
  })()
}

function restoreBrand(doc: (Snapshot & { brand?: Row; templates?: Row[] }) | null): void {
  if (!doc?.brand || !tableExists('workbench_brand')) return
  const pid = String(doc.brand['project_id'])
  if (!getProject(pid)) return
  insertRow('workbench_brand', doc.brand, colsOf('workbench_brand'))
  if (tableExists('workbench_brand_templates')) {
    const cols = colsOf('workbench_brand_templates')
    for (const t of doc.templates ?? []) insertRow('workbench_brand_templates', t, cols)
  }
}

/**
 * Rebuild the missing work items from the snapshot files in the project folders. `adoptOrphans` (the owner's
 * button only, never at startup) also takes .deck.json / .canvas.json files that no work item points to.
 */
export async function restoreFromFolders(opts: { adoptOrphans?: boolean; deep?: boolean } = {}): Promise<RestoreResult> {
  ensureWorkbenchTables()
  const res: RestoreResult = { scannedProjects: 0, restored: 0, projectsRebuilt: 0, alreadyThere: 0, tombstoned: 0, skipped: 0, adopted: 0, failed: 0 }
  const db = getDb()
  const roots = new Map<string, { abs: string; project: ProjectRow | null }>()
  for (const p of listProjects({ includeArchived: true })) {
    const t = projectFileTarget(p, '')
    if (t.ok) roots.set(t.dirAbs, { abs: t.dirAbs, project: p })
  }
  // An emptied database knows no project folders: then (or when asked, `deep`) the whole depot is searched for
  // snapshot files, and a snapshot rebuilds its own project row.
  const depot = explorerRoot()
  if (depot && (opts.deep || roots.size === 0)) roots.set(depot, { abs: depot, project: null })
  const orphanFiles: { abs: string; rel: string; project: ProjectRow }[] = []
  const seenFiles = new Set<string>()
  for (const { abs, project } of roots.values()) {
    res.scannedProjects++
    await walk(abs, async (file, name) => {
      if (seenFiles.has(file)) return
      seenFiles.add(file)
      try {
        if (name === SNAPSHOT_FILE || (name.endsWith('.json') && dirname(file).endsWith(SNAPSHOT_FALLBACK_DIR))) {
          let snap = await readJsonAsync(file)
          // The read above awaited, so the owner may have purged this item meanwhile (tombstone written, row gone
          // in one tick). A missing row -- rare, only after a data loss -- re-reads the file in the SAME tick as
          // the insert, so a purge during the walk is never revived.
          const sid = snap?.item?.['id']
          if (sid && !db.prepare('SELECT 1 FROM work_items WHERE id = ?').get(String(sid))) snap = readJson(file)
          if (!snap || snap.format !== SNAPSHOT_FORMAT) { res.skipped++; return }
          if (snap.tombstone) { res.tombstoned++; return }
          if (!snap.item || !snap.item['id']) { res.skipped++; return }
          restoreOne(snap, res)
        } else if (name === BRAND_FILE) {
          restoreBrand(await readJsonAsync(file))
        } else if (opts.adoptOrphans && project && (name.endsWith('.deck.json') || name.endsWith('.canvas.json'))) {
          orphanFiles.push({ abs: file, rel: file.slice(abs.length + 1).replace(/\\/g, '/'), project })
        }
      } catch (err) {
        res.failed++
        logger.warn({ err, file }, 'workbench-snapshot: could not rebuild from one file')
      }
    })
  }
  for (const o of orphanFiles) {
    try {
      const life = `${o.project.folder_path}/${o.rel}`
      const pointed = db.prepare('SELECT 1 FROM work_items WHERE source_path = ? UNION SELECT 1 FROM work_item_versions WHERE source_path = ?').get(life, life)
      if (pointed) continue
      const stem = o.rel.split('/').pop()!.replace(/\.(deck|canvas)\.json$/, '')
      const r = createWorkItem({ project_id: o.project.id, type: o.rel.endsWith('.deck.json') ? 'presentation' : 'graphic', title: stem.replace(/[-_]+/g, ' ').trim() || stem, source_path: life, created_by: 'snapshot-restore' })
      if (r.ok) res.adopted++
    } catch (err) {
      res.failed++
      logger.warn({ err, file: o.abs }, 'workbench-snapshot: could not adopt one file')
    }
  }
  if (res.restored || res.adopted) lastChanges = -1
  return res
}

// ---------------------------------------------------------------------------
// Lifecycle (one call from index.ts)
// ---------------------------------------------------------------------------

let timer: ReturnType<typeof setInterval> | null = null
let startTimer: ReturnType<typeof setTimeout> | null = null

export function startWorkbenchSnapshots(): void {
  if (timer) return
  // The depot may still be mounting right after boot: rebuild once after a short pause, then sweep.
  startTimer = setTimeout(async () => {
    try {
      const r = await restoreFromFolders()
      if (r.restored || r.projectsRebuilt) logger.info(r, 'workbench-snapshot: missing work items rebuilt from the project folders')
    } catch (err) { logger.warn({ err }, 'workbench-snapshot: startup rebuild failed') }
    try { sweepSnapshots({ force: true }) } catch (err) { logger.warn({ err }, 'workbench-snapshot: first sweep failed') }
  }, 20_000)
  startTimer.unref()
  timer = setInterval(() => {
    try { sweepSnapshots() } catch (err) { logger.warn({ err }, 'workbench-snapshot: sweep failed') }
  }, SWEEP_MS)
  timer.unref()
}

/** Stop the timers and take one last snapshot (the worst case loss is then the time since the last sweep only on a crash). */
export function stopWorkbenchSnapshots(): void {
  if (startTimer) { clearTimeout(startTimer); startTimer = null }
  if (timer) { clearInterval(timer); timer = null; try { sweepSnapshots() } catch { /* shutting down */ } }
}
