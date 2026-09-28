/**
 * MUNKADARAB SAJAT MAPPAJA ES ANYAGAI (kanban #441, v4 spec 0. fazis,
 * K-0.9 ... K-0.18).
 *
 * Boss (2026-09-28): "hogy lehet azt az MD-fajt feltoltenem ebbe az
 * implementacios tervbe, hogy itt olvasd. Szoval, hogy ne egy masik
 * munkadarabot nyisson." Es: "irodan belul letre kellett volna hozni egy
 * mappat hogy xy munkadarab ... es az ala tenni." Eddig minden feltoltott
 * fajlbol UJ munkadarab lett, a fajl pedig omlesztve a projekt mappajaba ment.
 *
 * Harom dolog all itt, egy helyen (a felulet vegpontja ES az agent toolja is
 * ezt hasznalja -- ket ut nem csuszhat szet):
 *
 *   1. SAJAT MAPPA. Minden munkadarab kaphat egy almappat a projekt mappajaban,
 *      a neve a munkadarab neve (`work_items.folder`, projekt-relativ). Foglalt
 *      nevnel `nev (2)` lesz -- egy MASIK munkadarab mappajaba nem irunk.
 *   2. ANYAGOK. Egy MEGLEVO munkadarabhoz barmennyi fajl csatolhato
 *      (`work_item_assets`): a fajl a munkadarab mappajaba kerul, a sor
 *      megjegyzi a tartalom ujjlenyomatat (sha256), a meretet es a TAMOGATASI
 *      ALLAPOTOT (K-0.15): olvashato / felhasznalhato / feldolgozo kell /
 *      nem tamogatott -- hogy az agent ne higgye, minden fajlt el tud olvasni.
 *   3. RENDRAKAS (K-0.12). A regi, a projekt fomappajaban omlesztve allo
 *      forrasfajl atkerulhet a munkadarab mappajaba; a munkadarab ES a
 *      verzioi utvonala egy tranzakcioban frissul, igy a kapcsolat nem szakad.
 *      Mas munkadarab altal is hasznalt fajlhoz nem nyulunk.
 *
 * A regi fajl SOSE VESZ EL: a Marveen tovabbra sem ir felul semmit
 * (`writeProjectFile` szabad nevet keres), es az athelyezes is szabad nevre megy.
 */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, renameSync, statSync } from 'node:fs'
import { extname, join, sep } from 'node:path'
import { getDb } from './db.js'
import { getProject, type ProjectRow } from './projects.js'
import { resolveLifePath, toLifeRel } from './life-explorer.js'
import { safeLifeName } from './life-tree.js'
import { fileKind } from './file-kind.js'
import { isCanvasFile } from './workbench-graphic.js'
import { OFFICE_CONVERTIBLE } from './office-convert.js'
import { projectFileTarget, makeProjectFolder, writeProjectFile, freeFileName, type FileErrorCode } from './project-files.js'
import { ensureWorkbenchTables, getWorkItem, type WorkItemRow } from './workbench.js'

/** Egy mappanev hossza (a Windows teljes-ut korlatja miatt rovidebb, mint a fajlnev). */
export const FOLDER_NAME_MAX = 80
/** Egy munkadarab legfeljebb ennyi anyagot tarthat (egy vegtelen lista nem anyag, hanem hiba). */
export const ASSETS_MAX_PER_ITEM = 500

// ---------------------------------------------------------------------------
// Tablak
// ---------------------------------------------------------------------------

let tablesDb: unknown = null

/** A `work_items.folder` oszlop es a `work_item_assets` tabla. Idempotens. */
export function ensureAssetTables(): void {
  ensureWorkbenchTables()
  const db = getDb()
  if (tablesDb === db) return
  const iCols = new Set((db.prepare('PRAGMA table_info(work_items)').all() as { name: string }[]).map((c) => c.name))
  if (!iCols.has('folder')) db.exec('ALTER TABLE work_items ADD COLUMN folder TEXT')
  db.exec(`
    CREATE TABLE IF NOT EXISTS work_item_assets (
      id TEXT PRIMARY KEY,
      work_item_id TEXT NOT NULL,
      path TEXT NOT NULL,
      name TEXT NOT NULL,
      support TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      created_by TEXT
    )
  `)
  db.exec('CREATE INDEX IF NOT EXISTS idx_work_item_assets_item ON work_item_assets(work_item_id, created_at)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_work_item_assets_sha ON work_item_assets(work_item_id, sha256)')
  tablesDb = db
}

// ---------------------------------------------------------------------------
// Tamogatasi allapot (K-0.15)
// ---------------------------------------------------------------------------

/**
 *  - `readable`         az agent el tudja olvasni a tartalmat (szoveg, jegyzet)
 *  - `usable`           a tartalmat nem olvassa, de felhasznalhato (kep a vasznon,
 *                       video a lejatszoban, PDF/office az elonezetben)
 *  - `needs_processor`  feltoltheto, de a tartalom ertelmezesehez kulon
 *                       feldolgozo kell, ami meg nincs (hang, beszedfelismeres)
 *  - `unsupported`      nem toltjuk fel (futtathato fajl)
 */
export type AssetSupport = 'readable' | 'usable' | 'needs_processor' | 'unsupported'
export const ASSET_SUPPORTS: AssetSupport[] = ['readable', 'usable', 'needs_processor', 'unsupported']

/** Futtathato / telepito fajlok: egy munkadarab anyaga nem lehet program. */
const BLOCKED_EXT = new Set(['exe', 'msi', 'bat', 'cmd', 'com', 'scr', 'ps1', 'vbs', 'jar', 'dll', 'sys', 'lnk', 'reg', 'app', 'dmg', 'apk'])

export function assetSupport(name: string): AssetSupport {
  const ext = extname(String(name || '')).slice(1).toLowerCase()
  if (BLOCKED_EXT.has(ext)) return 'unsupported'
  if (isCanvasFile(name)) return 'usable'
  const k = fileKind(name).kind
  if (k === 'text') return 'readable'
  if (k === 'image' || k === 'video' || k === 'pdf') return 'usable'
  if (k === 'audio') return 'needs_processor'
  if (OFFICE_CONVERTIBLE[ext]) return 'usable'
  if (['wav', 'mp3', 'm4a', 'ogg', 'oga', 'flac', 'aac', 'opus'].includes(ext)) return 'needs_processor'
  if (['heic', 'heif', 'tif', 'tiff', 'bmp', 'svg'].includes(ext)) return 'usable'
  if (['eml', 'msg'].includes(ext)) return 'needs_processor'
  return 'usable'
}

// ---------------------------------------------------------------------------
// Sajat mappa (K-0.9, K-0.10, K-0.16)
// ---------------------------------------------------------------------------

/** A munkadarab nevebol biztonsagos mappanev (Windows-tiltott jelek nelkul). */
export function folderNameFromTitle(title: string): string {
  let n = safeLifeName(String(title || '')).slice(0, FOLDER_NAME_MAX).trim()
  // Windowson a ponttal vagy szokozzel vegzodo mappa nem nyithato meg.
  n = n.replace(/[. ]+$/, '')
  if (!n || n === '_' || n.startsWith('.')) n = 'Munkadarab'
  return n
}

export type FolderOutcome =
  | { ok: true; folder: string; created: boolean }
  | { ok: false; code: FileErrorCode | 'folder_name' | 'folder_taken' | 'not_found'; message?: string }

function setItemFolder(itemId: string, folder: string): void {
  getDb().prepare('UPDATE work_items SET folder = ?, updated_at = ? WHERE id = ?')
    .run(folder, Math.floor(Date.now() / 1000), itemId)
}

/** A munkadarab mappaja (projekt-relativ). NULL = meg nincs. */
export function workItemFolder(itemId: string): string | null {
  ensureAssetTables()
  const row = getDb().prepare('SELECT folder FROM work_items WHERE id = ?').get(itemId) as { folder: string | null } | undefined
  return row?.folder || null
}

/**
 * Egy UJ mappa a projekt fomappajaban a megadott nevvel; foglalt nevnel
 * `nev (2)`, `nev (3)`... -- egy mar letezo mappat (ami lehet egy masik
 * munkadarabe, vagy a felhasznalo sajatja) NEM veszunk at csendben.
 */
export function makeFreshFolder(project: ProjectRow, wanted: string): FolderOutcome {
  const root = projectFileTarget(project, '')
  if (!root.ok) return root
  const name = freeFileName(root.dirAbs, folderNameFromTitle(wanted))
  const r = makeProjectFolder(project, '', name)
  if (!r.ok) return r
  return { ok: true, folder: r.sub, created: r.created }
}

/**
 * A munkadarab mappaja; ha meg nincs (vagy a nyilvantartott mappa eltunt),
 * letrehozza a munkadarab nevevel es megjegyzi.
 */
export function ensureWorkItemFolder(item: WorkItemRow): FolderOutcome {
  ensureAssetTables()
  const project = getProject(item.project_id)
  if (!project) return { ok: false, code: 'not_found' }
  const known = workItemFolder(item.id)
  if (known) {
    const t = projectFileTarget(project, known)
    if (t.ok) return { ok: true, folder: known, created: false }
    // A mappa eltunt / at lett nevezve: uj mappat adunk, a regi utat nem talalgatjuk.
  }
  const r = makeFreshFolder(project, item.title)
  if (!r.ok) return r
  setItemFolder(item.id, r.folder)
  return r
}

/**
 * Egy MAR LETEZO almappa kijelolese a munkadarab mappajanak (pl. a
 * tulajdonos kezzel mar csinalt egyet). Egy MASIK munkadarab mappaja nem
 * veheto at -- ket munkadarab nem osztozhat egy mappan.
 */
export function adoptExistingFolder(item: WorkItemRow, project: ProjectRow, folder: unknown): FolderOutcome {
  const t = projectFileTarget(project, folder)
  if (!t.ok) return t
  const rel = projectRelative(project, t.dirRel)
  if (!rel) return { ok: false, code: 'bad_folder' }
  const taken = getDb().prepare('SELECT 1 FROM work_items WHERE project_id = ? AND folder = ? AND id != ?').get(item.project_id, rel, item.id)
  if (taken) return { ok: false, code: 'folder_taken' }
  setItemFolder(item.id, rel)
  return { ok: true, folder: rel, created: false }
}

/** Egy friss munkadarabhoz a mar letrehozott mappa megjegyzese (feltoltesbol szuletett munkadarab). */
export function assignWorkItemFolder(itemId: string, folder: string): void {
  ensureAssetTables()
  setItemFolder(itemId, folder)
}

// ---------------------------------------------------------------------------
// Anyagok (K-0.14 ... K-0.18)
// ---------------------------------------------------------------------------

export interface WorkItemAssetRow {
  id: string
  work_item_id: string
  /** A Raktar-relativ ut (ugyanaz a forma, mint a `work_items.source_path`). */
  path: string
  name: string
  support: AssetSupport
  sha256: string
  bytes: number
  created_at: number
  created_by: string | null
}

export interface WorkItemAssetView extends WorkItemAssetRow {
  /** A projekt mappajahoz kepesti ut -- ezt kapja az agent `file.read`-hez. */
  project_path: string
  /** A fajl ott van-e meg, ahol a sor szerint lennie kell. */
  present: boolean
}

export function sha256Of(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

/** Raktar-relativ ut -> a projekt mappajahoz kepest ('' ha kivul esik). */
export function projectRelative(project: ProjectRow, depotRel: string): string {
  const base = project.folder_path ? project.folder_path.replace(/\/+$/, '') : ''
  if (!base) return ''
  if (depotRel === base) return ''
  return depotRel.startsWith(base + '/') ? depotRel.slice(base.length + 1) : ''
}

export function listWorkItemAssets(itemId: string): WorkItemAssetView[] {
  ensureAssetTables()
  const rows = getDb().prepare('SELECT * FROM work_item_assets WHERE work_item_id = ? ORDER BY created_at, rowid').all(itemId) as WorkItemAssetRow[]
  const item = getWorkItem(itemId)
  const project = item ? getProject(item.project_id) : undefined
  return rows.map((r) => {
    const abs = resolveLifePath(r.path)
    let present = false
    try { present = !!abs && existsSync(abs) && statSync(abs).isFile() } catch { present = false }
    return { ...r, project_path: project ? projectRelative(project, r.path) : '', present }
  })
}

export function findAssetByHash(itemId: string, sha: string): WorkItemAssetRow | undefined {
  ensureAssetTables()
  return getDb().prepare('SELECT * FROM work_item_assets WHERE work_item_id = ? AND sha256 = ? ORDER BY created_at LIMIT 1')
    .get(itemId, sha) as WorkItemAssetRow | undefined
}

export type AttachOutcome =
  | { ok: true; asset: WorkItemAssetView; renamed: boolean; folder: string; folderCreated: boolean }
  | { ok: false; code: 'asset_duplicate'; existing: WorkItemAssetRow }
  | { ok: false; code: 'asset_unsupported' | 'asset_limit' | 'not_found' | 'folder_name' | 'folder_taken' | FileErrorCode; message?: string }

/**
 * Egy fajl csatolasa egy MEGLEVO munkadarabhoz: a munkadarab mappajaba kerul,
 * es bekerul az anyagai koze. Ugyanaz a tartalom masodszorra csak `force`-szal
 * (K-0.18) -- a felulet ilyenkor megkerdezi a felhasznalot.
 */
export function attachAsset(
  item: WorkItemRow, name: string, data: Buffer,
  opts: { force?: boolean; createdBy?: string | null } = {},
): AttachOutcome {
  ensureAssetTables()
  if (assetSupport(name) === 'unsupported') return { ok: false, code: 'asset_unsupported' }
  const count = (getDb().prepare('SELECT COUNT(*) AS n FROM work_item_assets WHERE work_item_id = ?').get(item.id) as { n: number }).n
  if (count >= ASSETS_MAX_PER_ITEM) return { ok: false, code: 'asset_limit' }
  const sha = sha256Of(data)
  if (!opts.force) {
    const dup = findAssetByHash(item.id, sha)
    if (dup) return { ok: false, code: 'asset_duplicate', existing: dup }
  }
  const project = getProject(item.project_id)
  if (!project) return { ok: false, code: 'not_found' }
  const f = ensureWorkItemFolder(item)
  if (!f.ok) return f
  const out = writeProjectFile(project, f.folder, name, data)
  if (!out.ok) return out
  const row = registerAsset(item.id, out.rel, out.name, sha, out.bytes, opts.createdBy ?? null)
  return { ok: true, asset: row, renamed: out.renamed, folder: f.folder, folderCreated: f.created }
}

/** Egy MAR a helyen levo fajl felvetele az anyagok koze (a feltoltesbol szuletett munkadarab forrasa). */
export function registerAsset(itemId: string, depotRel: string, name: string, sha: string, bytes: number, createdBy: string | null): WorkItemAssetView {
  ensureAssetTables()
  const id = randomUUID().slice(0, 12)
  getDb().prepare(`INSERT INTO work_item_assets (id, work_item_id, path, name, support, sha256, bytes, created_at, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, itemId, depotRel, name, assetSupport(name), sha, bytes, Math.floor(Date.now() / 1000), createdBy)
  const view = listWorkItemAssets(itemId).find((a) => a.id === id)
  if (!view) throw new Error('asset was registered but could not be read back')
  return view
}

/** Egy anyag levetele a listarol. A FAJL a mappaban marad (a Raktarbol nem torlunk). */
export function unlinkAsset(itemId: string, assetId: string): boolean {
  ensureAssetTables()
  return getDb().prepare('DELETE FROM work_item_assets WHERE id = ? AND work_item_id = ?').run(assetId, itemId).changes > 0
}

// ---------------------------------------------------------------------------
// Rendrakas: az omlesztett forrasfajl a sajat mappaba (K-0.12)
// ---------------------------------------------------------------------------

export type TidyOutcome =
  | { ok: true; folder: string; moved: { from: string; to: string }[]; skipped: { path: string; reason: 'shared' | 'missing' | 'outside' | 'already' }[] }
  | { ok: false; code: 'not_found' | 'folder_name' | 'folder_taken' | 'move_failed' | FileErrorCode; message?: string }

/**
 * A munkadarab forrasfajlja(i) -- a jelenlegi es a verziokban hivatkozottak --
 * atkerulnek a munkadarab sajat mappajaba. A munkadarab es MINDEN verzio
 * utvonala ugyanabban a lepesben frissul. Kimarad (es megmondjuk, miert):
 *   - amit egy MASIK munkadarab is hasznal (`shared`),
 *   - ami mar nincs meg (`missing`),
 *   - ami a projekt mappajan kivul van (`outside`),
 *   - ami mar a mappaban van (`already`).
 */
export function tidyWorkItemIntoFolder(item: WorkItemRow, opts: { folder?: unknown } = {}): TidyOutcome {
  ensureAssetTables()
  const project = getProject(item.project_id)
  if (!project) return { ok: false, code: 'not_found' }
  const f = opts.folder === undefined || opts.folder === null || String(opts.folder).trim() === ''
    ? ensureWorkItemFolder(item)
    : adoptExistingFolder(item, project, opts.folder)
  if (!f.ok) return f
  const target = projectFileTarget(project, f.folder)
  if (!target.ok) return target
  const db = getDb()
  const paths = new Set<string>()
  if (item.source_path) paths.add(item.source_path)
  for (const r of db.prepare('SELECT DISTINCT source_path FROM work_item_versions WHERE work_item_id = ? AND source_path IS NOT NULL').all(item.id) as { source_path: string }[]) {
    paths.add(r.source_path)
  }
  const moved: { from: string; to: string }[] = []
  const skipped: { path: string; reason: 'shared' | 'missing' | 'outside' | 'already' }[] = []
  const folderRel = target.dirRel
  for (const p of paths) {
    if (p === folderRel || p.startsWith(folderRel + '/')) { skipped.push({ path: p, reason: 'already' }); continue }
    if (!projectRelative(project, p)) { skipped.push({ path: p, reason: 'outside' }); continue }
    const other = db.prepare(`SELECT 1 FROM work_items WHERE source_path = ? AND id != ?
      UNION SELECT 1 FROM work_item_versions WHERE source_path = ? AND work_item_id != ? LIMIT 1`).get(p, item.id, p, item.id)
    if (other) { skipped.push({ path: p, reason: 'shared' }); continue }
    const abs = resolveLifePath(p)
    if (!abs || !existsSync(abs)) { skipped.push({ path: p, reason: 'missing' }); continue }
    const fileName = abs.split(sep).pop() || 'file'
    const destName = freeFileName(target.dirAbs, fileName)
    const destAbs = join(target.dirAbs, destName)
    try {
      renameSync(abs, destAbs)
    } catch (e) {
      return { ok: false, code: 'move_failed', message: e instanceof Error ? e.message : String(e) }
    }
    const to = toLifeRel(destAbs) || `${folderRel}/${destName}`
    try {
      db.transaction(() => {
        db.prepare('UPDATE work_items SET source_path = ? WHERE id = ? AND source_path = ?').run(to, item.id, p)
        db.prepare('UPDATE work_item_versions SET source_path = ? WHERE work_item_id = ? AND source_path = ?').run(to, item.id, p)
        db.prepare('UPDATE work_item_parts SET asset_path = ? WHERE work_item_id = ? AND asset_path = ?').run(to, item.id, p)
        db.prepare('UPDATE work_item_assets SET path = ? WHERE work_item_id = ? AND path = ?').run(to, item.id, p)
      })()
    } catch (e) {
      // Az adatbazis nem frissult: a fajlt visszatesszuk, hogy a kapcsolat ne szakadjon.
      try { renameSync(destAbs, abs) } catch { /* a hibauzenet alabb megy tovabb */ }
      return { ok: false, code: 'move_failed', message: e instanceof Error ? e.message : String(e) }
    }
    moved.push({ from: p, to })
  }
  // A forrasfajl is anyag: ha meg nincs a listan, felvesszuk (a tartalom-ujjlenyomattal).
  const fresh = getWorkItem(item.id)
  if (fresh?.source_path) ensureSourceListed(fresh, fresh.source_path)
  return { ok: true, folder: f.folder, moved, skipped }
}

/** A forrasfajl felvetele az anyagok koze, ha meg nincs ott (utvonal szerint). */
export function ensureSourceListed(item: WorkItemRow, depotRel: string): void {
  ensureAssetTables()
  const has = getDb().prepare('SELECT 1 FROM work_item_assets WHERE work_item_id = ? AND path = ?').get(item.id, depotRel)
  if (has) return
  const abs = resolveLifePath(depotRel)
  if (!abs || !existsSync(abs)) return
  let data: Buffer
  try { data = readFileSync(abs) } catch { return }
  registerAsset(item.id, depotRel, abs.split(sep).pop() || depotRel, sha256Of(data), data.length, null)
}
