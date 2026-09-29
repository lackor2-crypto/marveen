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
import { existsSync, readFileSync, readdirSync, renameSync, statSync } from 'node:fs'
import { extname, join, sep } from 'node:path'
import { getDb } from './db.js'
import { getProject, type ProjectRow } from './projects.js'
import { resolveLifePath, toLifeRel } from './life-explorer.js'
import { safeLifeName } from './life-tree.js'
import { fileKind } from './file-kind.js'
import { isCanvasFile } from './workbench-graphic.js'
import { OFFICE_CONVERTIBLE } from './office-convert.js'
import { projectFileTarget, makeProjectFolder, writeProjectFile, freeFileName, type FileErrorCode } from './project-files.js'
import { ensureWorkbenchTables, getWorkItem, TITLE_MAX, type WorkItemRow } from './workbench.js'
import { docKind, docReadSummary, startDocRead, type DocReadSummary } from './workbench-docread.js'

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
  // Levett anyag (a fajl a mappaban marad): a sor megmarad `removed_at`-tel,
  // kulonben a mappa-szinkron a kovetkezo listazasnal visszavenne a listara.
  const aCols = new Set((db.prepare('PRAGMA table_info(work_item_assets)').all() as { name: string }[]).map((c) => c.name))
  if (!aCols.has('removed_at')) db.exec('ALTER TABLE work_item_assets ADD COLUMN removed_at INTEGER')
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
  // 1/A (K-1.1): a PDF, az irodai fajl es az e-mail oldalankent olvashato
  // (szovegreteg, szukseg eseten szovegfelismeres -- workbench-docread.ts).
  if (k === 'pdf' || ext === 'eml' || OFFICE_CONVERTIBLE[ext]) return 'readable'
  if (k === 'image' || k === 'video') return 'usable'
  if (k === 'audio') return 'needs_processor'
  if (['wav', 'mp3', 'm4a', 'ogg', 'oga', 'flac', 'aac', 'opus'].includes(ext)) return 'needs_processor'
  if (['heic', 'heif', 'tif', 'tiff', 'bmp', 'svg'].includes(ext)) return 'usable'
  if (ext === 'msg') return 'needs_processor'
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
  /** A projekt kozos taraban all (K-0.19): hivatkozas, nem a munkadarab sajat fajlja. */
  shared: boolean
}

/** Egy iratkent olvashato anyag (PDF, irodai fajl, fotozott irat, e-mail) olvasasi allapota (1/A). */
export interface WorkItemAssetDocView extends WorkItemAssetView {
  doc: DocReadSummary | null
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
  const rows = getDb().prepare('SELECT * FROM work_item_assets WHERE work_item_id = ? AND removed_at IS NULL ORDER BY created_at, rowid').all(itemId) as WorkItemAssetRow[]
  const item = getWorkItem(itemId)
  const project = item ? getProject(item.project_id) : undefined
  const sf = project && rows.length ? projectSharedFolder(project) : null
  const sharedPrefix = sf && sf.ok ? sf.dirRel + '/' : null
  return rows.map((r) => {
    const abs = resolveLifePath(r.path)
    let present = false
    try { present = !!abs && existsSync(abs) && statSync(abs).isFile() } catch { present = false }
    const shared = !!sharedPrefix && r.path.startsWith(sharedPrefix) && !r.path.slice(sharedPrefix.length).includes('/')
    // A tamogatasi allapot a fajl nevebol jon: egy regebben felvett sor is a mai tudast mutatja.
    return { ...r, support: assetSupport(r.name), project_path: project ? projectRelative(project, r.path) : '', present, shared }
  })
}

export function findAssetByHash(itemId: string, sha: string): WorkItemAssetRow | undefined {
  ensureAssetTables()
  return getDb().prepare('SELECT * FROM work_item_assets WHERE work_item_id = ? AND sha256 = ? AND removed_at IS NULL ORDER BY created_at LIMIT 1')
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
  const count = (getDb().prepare('SELECT COUNT(*) AS n FROM work_item_assets WHERE work_item_id = ? AND removed_at IS NULL').get(item.id) as { n: number }).n
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
  // Egy korabban levett, ugyanitt allo fajl ujra felveve: a regi sor el ujra.
  const gone = getDb().prepare('SELECT id FROM work_item_assets WHERE work_item_id = ? AND path = ? AND removed_at IS NOT NULL LIMIT 1').get(itemId, depotRel) as { id: string } | undefined
  if (gone) {
    getDb().prepare('UPDATE work_item_assets SET name = ?, support = ?, sha256 = ?, bytes = ?, created_at = ?, created_by = ?, removed_at = NULL WHERE id = ?')
      .run(name, assetSupport(name), sha, bytes, Math.floor(Date.now() / 1000), createdBy, gone.id)
    const back = listWorkItemAssets(itemId).find((a) => a.id === gone.id)
    if (!back) throw new Error('asset was restored but could not be read back')
    return back
  }
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
  return getDb().prepare('UPDATE work_item_assets SET removed_at = ? WHERE id = ? AND work_item_id = ? AND removed_at IS NULL')
    .run(Math.floor(Date.now() / 1000), assetId, itemId).changes > 0
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

// ---------------------------------------------------------------------------
// A mappa es a lista osszhangja (#441, 0/b)
// ---------------------------------------------------------------------------

/** Egyszerre ennyi, a mappaban talalt, meg nem nyilvantartott fajlt veszunk fel. */
export const FOLDER_SYNC_MAX = 100

const hiddenName = (n: string): boolean => n.startsWith('.') || /^(desktop\.ini|thumbs\.db)$/i.test(n) || n.startsWith('~$')

/**
 * A munkadarab mappajaban allo, de az anyagok kozott meg nem szereplo fajlok
 * felvetele (Boss 2026-09-29: a kezzel a mappaba tett v2/v3/v4 nem latszott
 * az Anyagok kozott). Csak a mappa FELSO szintje, csak fajl; a futtathato
 * fajl kimarad. Olcso, ha nincs uj fajl (utvonal szerinti osszevetes).
 */
export function syncFolderAssets(itemId: string): number {
  ensureAssetTables()
  const item = getWorkItem(itemId)
  if (!item || !item.folder) return 0
  const project = getProject(item.project_id)
  if (!project) return 0
  const t = projectFileTarget(project, item.folder)
  if (!t.ok) return 0
  let names: string[]
  try {
    names = readdirSync(t.dirAbs, { withFileTypes: true }).filter((d) => d.isFile() && !hiddenName(d.name)).map((d) => d.name)
  } catch { return 0 }
  const known = new Set((getDb().prepare('SELECT path FROM work_item_assets WHERE work_item_id = ?').all(itemId) as { path: string }[]).map((r) => r.path))
  let added = 0
  for (const n of names.sort((a, b) => a.localeCompare(b, 'hu'))) {
    if (added >= FOLDER_SYNC_MAX) break
    const rel = `${t.dirRel}/${n}`
    if (known.has(rel) || assetSupport(n) === 'unsupported') continue
    let data: Buffer
    try { data = readFileSync(join(t.dirAbs, n)) } catch { continue }
    registerAsset(itemId, rel, n, sha256Of(data), data.length, null)
    added++
  }
  return added
}

/** A lista a mappa friss allapotaval (a felulet es az agent ezt kerdezi). */
export function listWorkItemAssetsSynced(itemId: string): WorkItemAssetView[] {
  try { syncFolderAssets(itemId) } catch { /* a lista akkor is jojjon */ }
  return listWorkItemAssets(itemId)
}

// ---------------------------------------------------------------------------
// Atnevezes: a mappa is megy (K-0.11)

export type RenameItemOutcome =
  | { ok: true; item: WorkItemRow; folder: FolderRenameOutcome }
  | { ok: false; code: 'title_required' | 'title_too_long' }

/** A munkadarab uj neve + a mappaja (a felulet "Atnevezes" gombja es az agent is ezt hasznalja). */
export function renameWorkItem(item: WorkItemRow, rawTitle: unknown): RenameItemOutcome {
  ensureAssetTables()
  const title = String(rawTitle ?? '').trim()
  if (!title) return { ok: false, code: 'title_required' }
  if (title.length > TITLE_MAX) return { ok: false, code: 'title_too_long' }
  getDb().prepare('UPDATE work_items SET title = ?, updated_at = ? WHERE id = ?').run(title, Math.floor(Date.now() / 1000), item.id)
  const folder = title !== item.title ? renameWorkItemFolder(item, title) : { ok: true as const, renamed: false as const, reason: 'same_name' as const }
  return { ok: true, item: getWorkItem(item.id) as WorkItemRow, folder }
}
// ---------------------------------------------------------------------------

export type FolderRenameOutcome =
  | { ok: true; renamed: false; reason: 'no_folder' | 'same_name' | 'missing' | 'shared' | 'canvas' }
  | { ok: true; renamed: true; from: string; to: string }
  | { ok: false; code: 'move_failed'; message: string }

/**
 * A munkadarab uj neve utan a mappaja is atnevezodik, es MINDEN hivatkozas
 * (a munkadarab, a verzioi, a reszei, az anyagai) az uj helyre mutat.
 * Nem nevezzuk at (es megmondjuk, miert), ha:
 *   - nincs sajat mappa / a mappa nincs meg,
 *   - egy MASIK munkadarab is hivatkozik a mappa valamelyik fajljara,
 *   - rajz (.canvas.json) van benne: a rajz a kepeit utvonallal hivja, azt
 *     nem irjuk at vakon -- a mappa ilyenkor a regi neven marad.
 */
export function renameWorkItemFolder(item: WorkItemRow, newTitle: string): FolderRenameOutcome {
  ensureAssetTables()
  const folder = workItemFolder(item.id)
  if (!folder) return { ok: true, renamed: false, reason: 'no_folder' }
  const project = getProject(item.project_id)
  if (!project) return { ok: true, renamed: false, reason: 'missing' }
  const cur = projectFileTarget(project, folder)
  if (!cur.ok) return { ok: true, renamed: false, reason: 'missing' }
  const wanted = folderNameFromTitle(newTitle)
  const parentRel = folder.includes('/') ? folder.slice(0, folder.lastIndexOf('/')) : ''
  const lastSeg = folder.includes('/') ? folder.slice(folder.lastIndexOf('/') + 1) : folder
  if (wanted === lastSeg) return { ok: true, renamed: false, reason: 'same_name' }
  const oldPrefix = cur.dirRel + '/'
  const db = getDb()
  const like = oldPrefix.replace(/[\\%_]/g, (c) => '\\' + c) + '%'
  const shared = db.prepare(`SELECT 1 FROM work_items WHERE id != ? AND source_path LIKE ? ESCAPE '\\'
    UNION SELECT 1 FROM work_item_versions WHERE work_item_id != ? AND source_path LIKE ? ESCAPE '\\'
    UNION SELECT 1 FROM work_item_parts WHERE work_item_id != ? AND asset_path LIKE ? ESCAPE '\\'
    UNION SELECT 1 FROM work_item_assets WHERE work_item_id != ? AND path LIKE ? ESCAPE '\\' AND removed_at IS NULL LIMIT 1`)
    .get(item.id, like, item.id, like, item.id, like, item.id, like)
  if (shared) return { ok: true, renamed: false, reason: 'shared' }
  let hasCanvas = false
  try { hasCanvas = readdirSync(cur.dirAbs).some((n) => isCanvasFile(n)) } catch { return { ok: true, renamed: false, reason: 'missing' } }
  if (hasCanvas) return { ok: true, renamed: false, reason: 'canvas' }
  const parentAbs = cur.dirAbs.slice(0, cur.dirAbs.length - lastSeg.length - 1)
  const newSeg = freeFileName(parentAbs, wanted)
  const newAbs = join(parentAbs, newSeg)
  const newFolder = parentRel ? `${parentRel}/${newSeg}` : newSeg
  try { renameSync(cur.dirAbs, newAbs) } catch (e) {
    return { ok: false, code: 'move_failed', message: e instanceof Error ? e.message : String(e) }
  }
  const newPrefix = (toLifeRel(newAbs) || `${cur.dirRel.slice(0, cur.dirRel.length - lastSeg.length)}${newSeg}`) + '/'
  const swap = (p: string | null): string | null => (p && p.startsWith(oldPrefix) ? newPrefix + p.slice(oldPrefix.length) : p)
  try {
    db.transaction(() => {
      db.prepare('UPDATE work_items SET folder = ?, source_path = ? WHERE id = ?').run(newFolder, swap(item.source_path), item.id)
      for (const v of db.prepare('SELECT id, source_path FROM work_item_versions WHERE work_item_id = ?').all(item.id) as { id: string; source_path: string | null }[]) {
        if (v.source_path && v.source_path.startsWith(oldPrefix)) db.prepare('UPDATE work_item_versions SET source_path = ? WHERE id = ?').run(swap(v.source_path), v.id)
      }
      for (const r of db.prepare('SELECT id, asset_path FROM work_item_parts WHERE work_item_id = ?').all(item.id) as { id: string; asset_path: string | null }[]) {
        if (r.asset_path && r.asset_path.startsWith(oldPrefix)) db.prepare('UPDATE work_item_parts SET asset_path = ? WHERE id = ?').run(swap(r.asset_path), r.id)
      }
      for (const a of db.prepare('SELECT id, path FROM work_item_assets WHERE work_item_id = ?').all(item.id) as { id: string; path: string }[]) {
        if (a.path.startsWith(oldPrefix)) db.prepare('UPDATE work_item_assets SET path = ? WHERE id = ?').run(swap(a.path), a.id)
      }
    })()
  } catch (e) {
    try { renameSync(newAbs, cur.dirAbs) } catch { /* a hibauzenet megy tovabb */ }
    return { ok: false, code: 'move_failed', message: e instanceof Error ? e.message : String(e) }
  }
  return { ok: true, renamed: true, from: folder, to: newFolder }
}

// ---------------------------------------------------------------------------
// A projekt KOZOS TARA (K-0.19)
// ---------------------------------------------------------------------------
//
// Egy logo vagy markaelem projektszinten EGYSZER van meg (a projekt mappajaban
// egy "Kozos anyagok" almappa), es a munkadarabhoz csak HIVATKOZASKENT kerul:
// az anyag-sor a kozos tarban allo fajlra mutat, masolat nem keszul. A
// levetel a munkadarabrol a fajlt nem erinti. Ez a 4. fazis (Brand Kit)
// elokeszitese.

/** A kozos tar mappaneve (a felulet nyelve szerint; egy mar letezot mindket neven felismerunk). */
export const SHARED_FOLDER_NAMES = { hu: 'Közös anyagok', en: 'Shared materials' } as const
/** Egyszerre ennyi fajlt listazunk a kozos tarbol. */
export const SHARED_LIST_MAX = 300

function ensureSharedTable(): void {
  ensureAssetTables()
  getDb().exec('CREATE TABLE IF NOT EXISTS workbench_shared_folders (project_id TEXT PRIMARY KEY, folder TEXT NOT NULL)')
}

const folderIsItems = (projectId: string, folder: string): boolean =>
  !!getDb().prepare('SELECT 1 FROM work_items WHERE project_id = ? AND folder = ?').get(projectId, folder)

export type SharedFolderOutcome =
  | { ok: true; folder: string; dirAbs: string; dirRel: string; created: boolean }
  | { ok: false; code: FileErrorCode | 'folder_name' | 'not_found' | 'no_shared_folder'; message?: string }

/**
 * A projekt kozos taranak mappaja. A megjegyzett mappa, ha meg megvan; kulonben
 * egy mar letezo "Kozos anyagok" / "Shared materials" mappa (ha nem egy
 * munkadarabe); kulonben -- csak `create`-tel -- egy uj, szabad nevu mappa.
 */
export function projectSharedFolder(project: ProjectRow, opts: { create?: boolean; lang?: 'hu' | 'en' } = {}): SharedFolderOutcome {
  ensureSharedTable()
  const db = getDb()
  const known = db.prepare('SELECT folder FROM workbench_shared_folders WHERE project_id = ?').get(project.id) as { folder: string } | undefined
  if (known) {
    const t = projectFileTarget(project, known.folder)
    if (t.ok && existsSync(t.dirAbs)) return { ok: true, folder: known.folder, dirAbs: t.dirAbs, dirRel: t.dirRel, created: false }
  }
  const root = projectFileTarget(project, '')
  if (!root.ok) return root
  const remember = (folder: string): void => {
    db.prepare('INSERT INTO workbench_shared_folders (project_id, folder) VALUES (?, ?) ON CONFLICT(project_id) DO UPDATE SET folder = excluded.folder')
      .run(project.id, folder)
  }
  const order = opts.lang === 'en' ? [SHARED_FOLDER_NAMES.en, SHARED_FOLDER_NAMES.hu] : [SHARED_FOLDER_NAMES.hu, SHARED_FOLDER_NAMES.en]
  for (const n of order) {
    const abs = join(root.dirAbs, n)
    let isDir = false
    try { isDir = existsSync(abs) && statSync(abs).isDirectory() } catch { isDir = false }
    if (!isDir || folderIsItems(project.id, n)) continue
    const t = projectFileTarget(project, n)
    if (!t.ok) continue
    remember(n)
    return { ok: true, folder: n, dirAbs: t.dirAbs, dirRel: t.dirRel, created: false }
  }
  if (!opts.create) return { ok: false, code: 'no_shared_folder' }
  const name = freeFileName(root.dirAbs, order[0] as string)
  const r = makeProjectFolder(project, '', name)
  if (!r.ok) return r
  const t = projectFileTarget(project, r.sub)
  if (!t.ok) return t
  remember(r.sub)
  return { ok: true, folder: r.sub, dirAbs: t.dirAbs, dirRel: t.dirRel, created: r.created }
}

export interface SharedFileView {
  /** Raktar-relativ ut (ez kerul az anyag-sorba). */
  path: string
  /** A projekt mappajahoz kepesti ut (az agent `file.read`-je ezt varja). */
  project_path: string
  name: string
  support: AssetSupport
  bytes: number
  /** Ennyi munkadarab hivatkozik ra. */
  used_by: number
}

/** A kozos tar fajljai (csak a felso szint, rejtett es futtathato fajl nelkul). */
export function listSharedFiles(project: ProjectRow): { folder: string | null; files: SharedFileView[] } {
  const f = projectSharedFolder(project)
  if (!f.ok) return { folder: null, files: [] }
  let names: string[]
  try {
    names = readdirSync(f.dirAbs, { withFileTypes: true }).filter((d) => d.isFile() && !hiddenName(d.name)).map((d) => d.name)
  } catch { return { folder: f.folder, files: [] } }
  const use = getDb().prepare(`SELECT COUNT(DISTINCT a.work_item_id) AS n FROM work_item_assets a
    JOIN work_items w ON w.id = a.work_item_id WHERE a.path = ? AND w.project_id = ? AND a.removed_at IS NULL`)
  const files: SharedFileView[] = []
  for (const n of names.sort((a, b) => a.localeCompare(b, 'hu')).slice(0, SHARED_LIST_MAX)) {
    if (assetSupport(n) === 'unsupported') continue
    let bytes = 0
    try { bytes = statSync(join(f.dirAbs, n)).size } catch { continue }
    const path = `${f.dirRel}/${n}`
    files.push({ path, project_path: projectRelative(project, path), name: n, support: assetSupport(n), bytes, used_by: (use.get(path, project.id) as { n: number }).n })
  }
  return { folder: f.folder, files }
}

/** A munkadarab egy anyaga a kozos tarbol valo-e (hivatkozas, nem sajat fajl). */
export function isSharedPath(project: ProjectRow, depotRel: string): boolean {
  const f = projectSharedFolder(project)
  return f.ok && depotRel.startsWith(f.dirRel + '/') && !depotRel.slice(f.dirRel.length + 1).includes('/')
}

export type SharedUploadOutcome =
  | { ok: true; file: SharedFileView; renamed: boolean; folder: string }
  | { ok: false; code: 'shared_duplicate'; existing: SharedFileView }
  | { ok: false; code: 'asset_unsupported' | FileErrorCode | 'folder_name' | 'not_found' | 'no_shared_folder'; message?: string }

/** Egy fajl a projekt kozos taraba. Ugyanaz a tartalom masodszorra csak `force`-szal. */
export function uploadSharedFile(project: ProjectRow, name: string, data: Buffer, opts: { force?: boolean; lang?: 'hu' | 'en' } = {}): SharedUploadOutcome {
  if (assetSupport(name) === 'unsupported') return { ok: false, code: 'asset_unsupported' }
  const f = projectSharedFolder(project, { create: true, lang: opts.lang })
  if (!f.ok) return f
  if (!opts.force) {
    const sha = sha256Of(data)
    for (const s of listSharedFiles(project).files) {
      if (s.bytes !== data.length) continue
      try {
        if (sha256Of(readFileSync(join(f.dirAbs, s.name))) === sha) return { ok: false, code: 'shared_duplicate', existing: s }
      } catch { /* olvashatatlan fajl: nem duplikatum */ }
    }
  }
  const out = writeProjectFile(project, f.folder, name, data)
  if (!out.ok) return out
  const file = listSharedFiles(project).files.find((s) => s.path === out.rel)
  if (!file) return { ok: false, code: 'not_found' }
  return { ok: true, file, renamed: out.renamed, folder: f.folder }
}

export type LinkSharedOutcome =
  | { ok: true; asset: WorkItemAssetView; already: boolean }
  | { ok: false; code: 'not_found' | 'no_shared_folder' | 'not_shared' | 'asset_unsupported' | 'asset_limit' }

/**
 * Egy kozos tarban allo fajl HIVATKOZASKENT a munkadarab anyagai koze
 * (masolat nem keszul). `path` lehet Raktar-relativ, projekt-relativ vagy
 * csak a fajlnev. Ha mar a listan van, azt adja vissza.
 */
export function linkSharedAsset(item: WorkItemRow, rawPath: unknown, createdBy: string | null = null): LinkSharedOutcome {
  ensureAssetTables()
  const project = getProject(item.project_id)
  if (!project) return { ok: false, code: 'not_found' }
  const f = projectSharedFolder(project)
  if (!f.ok) return { ok: false, code: 'no_shared_folder' }
  const raw = String(rawPath ?? '').trim().replace(/\\/g, '/')
  const name = raw.split('/').pop() || ''
  const candidates = [raw, project.folder_path ? `${project.folder_path.replace(/\/+$/, '')}/${raw}` : '', `${f.dirRel}/${raw}`]
  const path = candidates.find((c) => c && c === `${f.dirRel}/${name}`)
  if (!name || !path || hiddenName(name)) return { ok: false, code: 'not_shared' }
  if (assetSupport(name) === 'unsupported') return { ok: false, code: 'asset_unsupported' }
  const abs = join(f.dirAbs, name)
  try { if (!statSync(abs).isFile()) return { ok: false, code: 'not_found' } } catch { return { ok: false, code: 'not_found' } }
  const has = getDb().prepare('SELECT id FROM work_item_assets WHERE work_item_id = ? AND path = ? AND removed_at IS NULL').get(item.id, path) as { id: string } | undefined
  if (has) {
    const view = listWorkItemAssets(item.id).find((a) => a.id === has.id)
    if (view) return { ok: true, asset: view, already: true }
  }
  const count = (getDb().prepare('SELECT COUNT(*) AS n FROM work_item_assets WHERE work_item_id = ? AND removed_at IS NULL').get(item.id) as { n: number }).n
  if (count >= ASSETS_MAX_PER_ITEM) return { ok: false, code: 'asset_limit' }
  let data: Buffer
  try { data = readFileSync(abs) } catch { return { ok: false, code: 'not_found' } }
  return { ok: true, asset: registerAsset(item.id, path, name, sha256Of(data), data.length, createdBy), already: false }
}

// ---------------------------------------------------------------------------
// Iratok olvasasa (1/A, K-1.1 ... K-1.3)
// ---------------------------------------------------------------------------

/** Az anyagok az iratolvasas allapotaval (a felulet ezt mutatja a fajl mellett). */
export function withDocState(assets: WorkItemAssetView[]): WorkItemAssetDocView[] {
  return assets.map((a) => {
    const k = docKind(a.name)
    if (!k) return { ...a, doc: null }
    const d = docReadSummary(a.sha256)
    // Egy kep (logo, fotó) csak kerésre irat: amig senki nem olvasta, nincs allapota.
    return { ...a, doc: k === 'image' && d.status === 'none' ? null : d }
  })
}

/**
 * A meg nem olvasott (vagy felbeszakadt) iratok feldolgozasanak inditasa a
 * hatterben. Nem var; a kovetkezo lista-lekeres mar az allapotot mutatja.
 */
export function startPendingDocReads(assets: WorkItemAssetView[]): number {
  let n = 0
  for (const a of assets) {
    const k = docKind(a.name)
    // A kep nem indul magatol (egy logo nem irat); kerésre a document.pages olvassa.
    if (!a.present || !k || k === 'image') continue
    const st = docReadSummary(a.sha256).status
    if (st !== 'none' && st !== 'stale') continue
    const abs = resolveLifePath(a.path)
    if (!abs) continue
    try {
      const r = startDocRead(abs, a.name, { sha: a.sha256, force: st === 'stale' })
      if (r.ok && r.started) { n++; r.done.catch(() => undefined) }
    } catch { /* egy olvashatatlan fajl nem allithatja meg a listat */ }
  }
  return n
}
