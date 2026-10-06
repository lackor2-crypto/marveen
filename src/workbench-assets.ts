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
import { existsSync, readFileSync, readdirSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, sep } from 'node:path'
import { getDb } from './db.js'
import { APP_LANG } from './config.js'
import { getProject, listProjects, type ProjectRow } from './projects.js'
import { resolveLifePath, toLifeRel, trashLife, copyLife } from './life-explorer.js'
import { safeLifeName, lifeName } from './life-tree.js'
import { fileKind } from './file-kind.js'
import { isCanvasFile } from './workbench-graphic.js'
import { OFFICE_CONVERTIBLE } from './office-convert.js'
import { writeBlockReason } from './git-guard.js'
import { ol } from './owner-lang.js'
import { SNAPSHOT_FILE } from './workbench-snapshot.js'
import { projectFileTarget, makeProjectFolder, writeProjectFile, freeFileName, type FileErrorCode } from './project-files.js'
import { ensureWorkbenchTables, setWorkItemDeleted, getWorkItem, getWorkItemVersion, listWorkItemParts, TITLE_MAX, type WorkItemRow } from './workbench.js'
import { docKind, docReadSummary, startDocRead, type DocReadSummary } from './workbench-docread.js'

/** #479: the create form's "directly in the project folder" place (not a group of the work items box). Stored in container_folder. */
export const PROJECT_ROOT_PLACE = '@project'

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
  // #481: a stable hidden id per folder (the .marveen-id file inside it), so a folder renamed or moved outside
  // Marvin is found again by id and not only by path.
  db.exec('CREATE TABLE IF NOT EXISTS work_folder_ids (project_id TEXT NOT NULL, id TEXT NOT NULL, path TEXT NOT NULL, PRIMARY KEY (project_id, id))')
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
 * The project's "Munkadarabok" (Work items) folder: every work item's own
 * folder lives under it, so the project root keeps its few permanent folders.
 * An existing folder of either language name is taken over (unless it is a
 * work item's own folder); otherwise it is created.
 */
export function projectWorkItemsFolder(project: ProjectRow): SharedFolderOutcome {
  return projectNamedFolder(project, 'workItems')
}

/**
 * #491: the project's raw-material folder ("Tovabbi anyagok" / "More material", part of the project
 * skeleton). An upload lands here as a plain file: no work item, no folder named after the file. The
 * owner turns a file into a work item later and picks its folder then.
 */
export function projectMaterialsFolder(project: ProjectRow): SharedFolderOutcome {
  return projectNamedFolder(project, 'moreMaterial')
}

function projectNamedFolder(project: ProjectRow, key: 'workItems' | 'moreMaterial'): SharedFolderOutcome {
  ensureAssetTables()
  const root = projectFileTarget(project, '')
  if (!root.ok) return root
  const names = [lifeName(key), lifeName(key, APP_LANG === 'hu' ? 'en' : 'hu')]
  for (const n of names) {
    const abs = join(root.dirAbs, n)
    let isDir = false
    try { isDir = existsSync(abs) && statSync(abs).isDirectory() } catch { isDir = false }
    if (!isDir || folderIsItems(project.id, n)) continue
    const t = projectFileTarget(project, n)
    if (t.ok) return { ok: true, folder: n, dirAbs: t.dirAbs, dirRel: t.dirRel, created: false }
  }
  const name = freeFileName(root.dirAbs, names[0] as string)
  const r = makeProjectFolder(project, '', name)
  if (!r.ok) return r
  const t = projectFileTarget(project, r.sub)
  if (!t.ok) return t
  return { ok: true, folder: r.sub, dirAbs: t.dirAbs, dirRel: t.dirRel, created: r.created }
}

/**
 * A fresh work item folder under the project's "Munkadarabok" folder; a taken
 * name becomes `name (2)` -- an existing folder (maybe another item's, maybe
 * the user's own) is never taken over silently.
 */
export function makeFreshFolder(project: ProjectRow, wanted: string, parentFolder?: string | null): FolderOutcome {
  // #448: a sub work item's folder is created INSIDE its main item's folder.
  if (parentFolder) {
    const pt = projectFileTarget(project, parentFolder)
    if (!pt.ok) return pt
    const subName = freeFileName(pt.dirAbs, folderNameFromTitle(wanted))
    const sr = makeProjectFolder(project, parentFolder, subName)
    if (!sr.ok) return sr
    return { ok: true, folder: sr.sub, created: sr.created }
  }
  const box = projectWorkItemsFolder(project)
  if (!box.ok) return { ok: false, code: box.code === 'no_shared_folder' ? 'not_found' : box.code, ...(box.message ? { message: box.message } : {}) }
  const name = freeFileName(box.dirAbs, folderNameFromTitle(wanted))
  const r = makeProjectFolder(project, box.folder, name)
  if (!r.ok) return r
  return { ok: true, folder: r.sub, created: r.created }
}

// ---------------------------------------------------------------------------
// #454: folders instead of main / sub work items
// ---------------------------------------------------------------------------

/** The project's work items box WITHOUT creating it (null = none yet). */
export function findWorkItemsBox(project: ProjectRow): string | null {
  ensureAssetTables()
  const root = projectFileTarget(project, '')
  if (!root.ok) return null
  const names = [lifeName('workItems'), lifeName('workItems', APP_LANG === 'hu' ? 'en' : 'hu')]
  for (const n of names) {
    const abs = join(root.dirAbs, n)
    let isDir = false
    try { isDir = existsSync(abs) && statSync(abs).isDirectory() } catch { isDir = false }
    if (isDir && !folderIsItems(project.id, n)) return n
  }
  return null
}

/** A folder for a new work item may only be the box itself or a folder inside it. */
export type WorkFolderError = FileErrorCode | 'no_box'

export function workFolderTarget(project: ProjectRow, folder: unknown): { ok: true; folder: string } | { ok: false; code: WorkFolderError } {
  const box = findWorkItemsBox(project)
  if (!box) return { ok: false, code: 'no_box' }
  let raw = String(folder ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  // A loose file's `rel` is a path from the library root ('Family/Owner/Projects/X/Box/sub/file.pptx'), so the
  // folder the page derives from it carries the project's own path in front. Take that prefix off (TG 2480):
  // without it "make a work item from this file" answered "the sub-folder cannot be used" for a folder that exists.
  const own = String(project.folder_path ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  if (own && raw.startsWith(own + '/')) raw = raw.slice(own.length + 1)
  if (!raw) return { ok: true, folder: box }
  if (raw !== box && !raw.startsWith(box + '/')) return { ok: false, code: 'bad_folder' }
  const t = projectFileTarget(project, raw)
  if (!t.ok) return t
  return { ok: true, folder: raw }
}

export const WORK_FOLDER_MAX_DEPTH = 64
export const WORK_FOLDER_MAX = 600

/** A plain file lying in a work folder (not a work item): shown in the list with a preview link.
 *  `item`: the file lies directly in a live work item's own folder, so it belongs to that item (#492: copy only). */
export type WorkFolderFile = { name: string; size: number; rel: string; item?: true }
/** Same name as SNAPSHOT_FILE in workbench-snapshot.ts (not imported: that module imports this area). */
const ITEM_SNAPSHOT_NAME = 'marveen-item.json'
export const WORK_FOLDER_FILES_MAX = 200
export const WORK_FILES_TOTAL_MAX = 3000

/** The own folders (project-relative) of the project's live work items: a file directly in one belongs to that item. */
function liveItemFolders(project: ProjectRow): Set<string> {
  try {
    const rows = getDb().prepare("SELECT folder FROM work_items WHERE project_id = ? AND deleted_at IS NULL AND folder IS NOT NULL AND folder != ''").all(project.id) as { folder: string }[]
    return new Set(rows.map((r) => r.folder))
  } catch { return new Set() }
}

/** Every folder inside the work items box, project-relative, parents before children.
 *  `files` holds the plain files of the box and of each folder (key = folder path), so a folder
 *  that is full on disk does not look empty. A folder that also holds a work item lists its files too (#488);
 *  only the item's own snapshot (marveen-item.json) and dotfiles are never listed. */
export function listWorkFolders(project: ProjectRow): { box: string | null; folders: string[]; truncated: boolean; files: Record<string, WorkFolderFile[]> } {
  const box = findWorkItemsBox(project)
  if (!box) return { box: null, folders: [], truncated: false, files: {} }
  const t = projectFileTarget(project, box)
  if (!t.ok) return { box, folders: [], truncated: false, files: {} }
  const out: string[] = []
  const files: Record<string, WorkFolderFile[]> = {}
  const itemFolders = liveItemFolders(project)
  let fileTotal = 0
  let truncated = false
  const walk = (abs: string, rel: string, depth: number): void => {
    if (depth > WORK_FOLDER_MAX_DEPTH) return
    let entries: import('node:fs').Dirent[]
    try { entries = readdirSync(abs, { withFileTypes: true }) } catch { return }
    // #488: list the loose files in EVERY folder, even one that also holds a work item (its snapshot
    // sits directly in it after the #479 flatten). Only the snapshot file and dotfiles are kept out,
    // so a folder where Boss put pictures next to the presentation no longer looks empty (Boss TG
    // 2026-10-04 "a prezentacioba tette de nem latom ott").
    {
      const plain = entries.filter((d) => d.isFile() && !d.name.startsWith('.') && d.name !== ITEM_SNAPSHOT_NAME)
        .sort((a, b) => a.name.localeCompare(b.name, 'hu', { numeric: true }))
      for (const f of plain) {
        if (fileTotal >= WORK_FILES_TOTAL_MAX || (files[rel]?.length ?? 0) >= WORK_FOLDER_FILES_MAX) { truncated = true; break }
        let size = 0
        try { size = statSync(join(abs, f.name)).size } catch { /* gone meanwhile */ }
        const lifeRel = `${t.dirRel}${rel.slice(box.length)}/${f.name}`
        ;(files[rel] = files[rel] || []).push({ name: f.name, size, rel: lifeRel, ...(itemFolders.has(rel) ? { item: true as const } : {}) })
        fileTotal++
      }
    }
    const dirs = entries.filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules')
      .sort((a, b) => a.name.localeCompare(b.name, 'hu'))
    for (const d of dirs) {
      if (out.length >= WORK_FOLDER_MAX) { truncated = true; return }
      const childAbs = join(abs, d.name)
      if (existsSync(join(childAbs, '.git'))) continue
      const childRel = `${rel}/${d.name}`
      out.push(childRel)
      walk(childAbs, childRel, depth + 1)
    }
  }
  walk(t.dirAbs, box, 1)
  return { box, folders: out, truncated, files }
}

/** A new folder inside the work items box (parent '' = the box itself; the box is made if missing). */
export function makeWorkFolder(project: ProjectRow, parent: unknown, name: unknown): { ok: true; folder: string; created: boolean } | { ok: false; code: WorkFolderError | 'folder_name'; message?: string } {
  let parentRel: string
  const raw = String(parent ?? '').trim()
  if (!raw || findWorkItemsBox(project) === null) {
    const box = projectWorkItemsFolder(project)
    if (!box.ok) return { ok: false, code: box.code === 'no_shared_folder' || box.code === 'not_found' ? 'no_box' : box.code, ...(box.message ? { message: box.message } : {}) }
    parentRel = box.folder
  } else {
    const c = workFolderTarget(project, raw)
    if (c.ok) parentRel = c.folder
    else {
      // Boss (TG 2447): a picked parent that vanished from the disk (deleted outside Marvin) is made again, at any depth,
      // instead of "the given subfolder cannot be used".
      const box = findWorkItemsBox(project)
      const clean = raw.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
      if (c.code !== 'bad_folder' || !box || !clean.startsWith(box + '/') || clean.split('/').some((x) => x === '..' || x === '.')) return c
      const re = makeProjectFolder(project, box, clean.slice(box.length + 1))
      if (!re.ok) return re
      parentRel = re.sub
    }
  }
  const r = makeProjectFolder(project, parentRel, name)
  if (!r.ok) return r
  return { ok: true, folder: r.sub, created: r.created }
}

export type DeleteFolderResult =
  | { ok: true; folder: string; trashed?: { items: number; kuka: string } }
  | { ok: false; code: WorkFolderError | 'folder_is_box' | 'folder_not_empty' | 'folder_used_elsewhere' | 'write_failed'; items?: number; files?: number; folders?: number; users?: string[] }

/**
 * Deletes a folder inside the work items box. Without `trash` only an EMPTY one: nothing on disk (no file,
 * no subfolder) and no live work item filed under it. With `trash` (#492) a folder with content goes to the
 * Kuka with everything in it, but if a work item OUTSIDE the folder uses something in it (a deck elsewhere
 * showing a picture from here) it stops with `folder_used_elsewhere` and the item titles, until `force`
 * says the owner was told. The box itself always stays.
 */
export function deleteWorkFolder(project: ProjectRow, folder: unknown, opts: { trash?: boolean; force?: boolean } = {}): DeleteFolderResult {
  const c = workFolderTarget(project, folder)
  if (!c.ok) return c
  const box = findWorkItemsBox(project)
  if (!box || c.folder === box) return { ok: false, code: 'folder_is_box' }
  const t = projectFileTarget(project, c.folder)
  if (!t.ok) return t
  let entries: import('node:fs').Dirent[] = []
  try { entries = readdirSync(t.dirAbs, { withFileTypes: true }).filter((e) => e.name !== FOLDER_MARKER) } catch { return { ok: false, code: 'not_found' as FileErrorCode } }
  ensureAssetTables()
  const under = (v: string | null): boolean => !!v && (v === c.folder || v.startsWith(c.folder + '/'))
  const underIds = (getDb().prepare('SELECT id, container_folder AS cf, folder AS f, source_path AS sp FROM work_items WHERE project_id = ? AND deleted_at IS NULL').all(project.id) as { id: string; cf: string | null; f: string | null; sp: string | null }[])
    .filter((r) => under(r.cf) || under(r.f) || under(r.sp)).map((r) => r.id)
  const items = underIds.length
  if ((entries.length || items) && opts.trash) {
    // A picture of this folder shown by a deck elsewhere would turn into a dead link: say so first.
    if (!opts.force) {
      const users = itemsUsingFolder(project, t.dirRel, underIds)
      if (users.length) return { ok: false, code: 'folder_used_elsewhere', users }
    }
    // #492: a folder with content goes to the Kuka (restorable) with everything in it; its work items go to the
    // Workbench trash first, so none of them points at a folder that is gone. Undone if the move fails.
    for (const id of underIds) setWorkItemDeleted(id, true)
    const moved = trashLife(t.dirRel)
    if (!moved.ok) {
      for (const id of underIds) setWorkItemDeleted(id, false)
      return { ok: false, code: 'write_failed' }
    }
    getDb().prepare('DELETE FROM work_folder_ids WHERE project_id = ? AND (path = ? OR path LIKE ?)').run(project.id, c.folder, c.folder + '/%')
    return { ok: true, folder: c.folder, trashed: { items, kuka: moved.rel } }
  }
  if (entries.length || items) {
    const folders = entries.filter((e) => e.isDirectory()).length
    return { ok: false, code: 'folder_not_empty', items, files: entries.length - folders, folders }
  }
  try { unlinkSync(join(t.dirAbs, FOLDER_MARKER)) } catch { /* no marker, or already gone */ }
  try { rmdirSync(t.dirAbs) } catch { return { ok: false, code: 'write_failed' } }
  getDb().prepare('DELETE FROM work_folder_ids WHERE project_id = ? AND path = ?').run(project.id, c.folder)
  return { ok: true, folder: c.folder }
}

export type RenameFolderResult =
  | { ok: true; folder: string; renamed: boolean; item?: WorkItemRow }
  | { ok: false; code: WorkFolderError | 'folder_is_box' | 'folder_name' | 'folder_exists' | 'folder_has_canvas' | 'write_failed'; items?: number; message?: string }

/**
 * Renames a plain folder inside the work items box (same parent, new last
 * segment). Only a folder that no work item points into: a work item keeps its
 * own paths in the registry, and those are rewritten by renaming the ITEM (which
 * moves its folder). Loose files and subfolders on disk move along untouched.
 */
export function renameWorkFolder(project: ProjectRow, folder: unknown, newName: unknown): RenameFolderResult {
  const c = workFolderTarget(project, folder)
  if (!c.ok) return c
  const box = findWorkItemsBox(project)
  if (!box || c.folder === box) return { ok: false, code: 'folder_is_box' }
  const seg = String(newName ?? '').trim()
  const clean = safeLifeName(seg)
  if (!seg || seg.includes('/') || seg.includes('\\') || !clean || clean === '_' || clean.startsWith('.') || clean.length > 120 || clean !== seg) return { ok: false, code: 'folder_name' }
  const t = projectFileTarget(project, c.folder)
  if (!t.ok) return t
  const parentRel = c.folder.slice(0, c.folder.lastIndexOf('/'))
  const lastSeg = c.folder.slice(c.folder.lastIndexOf('/') + 1)
  if (clean === lastSeg) return { ok: true, folder: c.folder, renamed: false }
  const parentT = projectFileTarget(project, parentRel)
  if (!parentT.ok) return parentT
  const newAbs = join(parentT.dirAbs, clean)
  if (existsSync(newAbs)) return { ok: false, code: 'folder_exists' }
  const blocked = writeBlockReason(`${parentT.dirRel}/${clean}`)
  if (blocked) return { ok: false, code: 'write_failed', message: blocked }
  ensureAssetTables()
  const db = getDb()
  // #478: a folder is a named GROUP. Renaming it only renames the group: no work item changes its name, and
  // every path the registry keeps under the folder (items, versions, parts, materials, deck pictures) follows.
  // A drawing (.canvas.json) lives in its item's folder (Boss TG 2545): its picture paths are rewritten after the rename.
  const newFolder = parentRel ? `${parentRel}/${clean}` : clean
  try { renameSync(t.dirAbs, newAbs) } catch (e) { return { ok: false, code: 'write_failed', message: e instanceof Error ? e.message : String(e) } }
  const newPrefix = (toLifeRel(newAbs) || `${parentT.dirRel}/${clean}`) + '/'
  try {
    rewriteFolderRefs(project, c.folder, newFolder, t.dirRel + '/', newPrefix)
    rewriteCanvasFilesUnder(newAbs, t.dirRel + '/', newPrefix)
  } catch (e) {
    try { renameSync(newAbs, t.dirAbs) } catch { /* the error below goes on */ }
    return { ok: false, code: 'write_failed', message: e instanceof Error ? e.message : String(e) }
  }
  return { ok: true, folder: newFolder, renamed: true }
}

export type MoveFolderResult =
  | { ok: true; folder: string; moved: boolean }
  | { ok: false; code: WorkFolderError | 'folder_is_box' | 'folder_exists' | 'folder_into_itself' | 'write_failed'; message?: string }

/** Swaps a Depot-relative path prefix inside every drawing file under `abs` (best effort, depth-limited). */
function rewriteCanvasFilesUnder(abs: string, oldPrefix: string, newPrefix: string, depth = 0): void {
  if (depth > WORK_FOLDER_MAX_DEPTH) return
  let entries: import('node:fs').Dirent[]
  try { entries = readdirSync(abs, { withFileTypes: true }) } catch { return }
  for (const d of entries) {
    const full = join(abs, d.name)
    if (d.isDirectory()) { rewriteCanvasFilesUnder(full, oldPrefix, newPrefix, depth + 1); continue }
    if (!d.isFile() || !isCanvasFile(d.name)) continue
    try {
      const text = readFileSync(full, 'utf8')
      if (text.includes(oldPrefix)) writeFileSync(full, text.split(oldPrefix).join(newPrefix))
    } catch { /* an unreadable drawing file: the move itself already succeeded */ }
  }
}

/**
 * Moves a folder of the work items box, WITH everything in it, into another folder of the box (`parent`
 * '' = the box itself). Work items, files and subfolders move along; every path the registry keeps under
 * the folder follows in one transaction (same as a rename), and the drawing files inside get the same path
 * swap, so a drawing's pictures stay linked. Never overwrites: a name clash at the target refuses.
 */
export function moveWorkFolder(project: ProjectRow, folder: unknown, parent: unknown): MoveFolderResult {
  const c = workFolderTarget(project, folder)
  if (!c.ok) return c
  const box = findWorkItemsBox(project)
  if (!box || c.folder === box) return { ok: false, code: 'folder_is_box' }
  const p = workFolderTarget(project, parent)
  if (!p.ok) return p
  if (p.folder === c.folder || p.folder.startsWith(c.folder + '/')) return { ok: false, code: 'folder_into_itself' }
  const curParent = c.folder.slice(0, c.folder.lastIndexOf('/'))
  if (curParent === p.folder) return { ok: true, folder: c.folder, moved: false }
  const lastSeg = c.folder.slice(c.folder.lastIndexOf('/') + 1)
  const t = projectFileTarget(project, c.folder)
  if (!t.ok) return t
  const parentT = projectFileTarget(project, p.folder)
  if (!parentT.ok) return parentT
  const newAbs = join(parentT.dirAbs, lastSeg)
  if (existsSync(newAbs)) return { ok: false, code: 'folder_exists' }
  const blocked = writeBlockReason(`${parentT.dirRel}/${lastSeg}`)
  if (blocked) return { ok: false, code: 'write_failed', message: blocked }
  ensureAssetTables()
  const newFolder = `${p.folder}/${lastSeg}`
  try { renameSync(t.dirAbs, newAbs) } catch (e) { return { ok: false, code: 'write_failed', message: e instanceof Error ? e.message : String(e) } }
  const oldPrefix = t.dirRel + '/'
  const newPrefix = (toLifeRel(newAbs) || `${parentT.dirRel}/${lastSeg}`) + '/'
  try {
    rewriteFolderRefs(project, c.folder, newFolder, oldPrefix, newPrefix)
  } catch (e) {
    try { renameSync(newAbs, t.dirAbs) } catch { /* the error below goes on */ }
    return { ok: false, code: 'write_failed', message: e instanceof Error ? e.message : String(e) }
  }
  rewriteCanvasFilesUnder(newAbs, oldPrefix, newPrefix)
  return { ok: true, folder: newFolder, moved: true }
}

export type MoveFilesSkip = { name: string; reason: 'not_loose' | 'same_place' | 'name_taken' | 'in_use' | 'item_file' | 'failed' }

/**
 * #486: a loose file that a work item references -- typically a deck's slide picture, whose Depot-relative
 * path lives in the canvas object's `src` inside the draft JSON (and the saved version files) -- can be
 * moved too. Every reference to it is repointed from oldRel to newRel in one transaction, so nothing turns
 * into a dead link and the deck keeps working. Exact file path, project-wide (another item may cite the same
 * picture), covering the same places loosePathsInUse scans: the item/version/part/asset columns and the
 * deck/timeline JSON (working draft + undo steps), plus the saved version JSON files on disk (best effort).
 */
function repointMovedFileRefs(project: ProjectRow, oldRel: string, newRel: string): void {
  if (!oldRel || !newRel || oldRel === newRel) return
  const db = getDb()
  const ids = (db.prepare('SELECT id FROM work_items WHERE project_id = ?').all(project.id) as { id: string }[]).map((r) => r.id)
  const draftTables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB 'work_item_[a-z]*_drafts'").all() as { name: string }[])
    .filter((t) => /^work_item_[a-z]+_drafts$/.test(t.name))
  // In the JSON (deck/timeline draft, undo steps, saved version files) the path is a quoted string value,
  // so swap the QUOTED form. This way a longer path that merely ENDS with oldRel (e.g. "diak/s1.png.bak"
  // vs "diak/s1.png") is left untouched -- a raw substring replace would corrupt it (usalackor, #487).
  // JSON-encoded, not hand-quoted: a name with `"` or `\` is stored escaped, and the new path must not
  // break the JSON it is written into.
  const oldQ = JSON.stringify(oldRel), newQ = JSON.stringify(newRel)
  db.transaction(() => {
    db.prepare('UPDATE work_items SET source_path = ? WHERE project_id = ? AND source_path = ?').run(newRel, project.id, oldRel)
    for (const id of ids) {
      db.prepare('UPDATE work_item_versions SET source_path = ? WHERE work_item_id = ? AND source_path = ?').run(newRel, id, oldRel)
      db.prepare('UPDATE work_item_parts SET asset_path = ? WHERE work_item_id = ? AND asset_path = ?').run(newRel, id, oldRel)
      db.prepare('UPDATE work_item_assets SET path = ? WHERE work_item_id = ? AND path = ?').run(newRel, id, oldRel)
      for (const { name } of draftTables) {
        db.prepare(`UPDATE ${name} SET doc = replace(doc, ?, ?) WHERE work_item_id = ? AND instr(doc, ?) > 0`).run(oldQ, newQ, id, oldQ)
        const steps = name.replace(/_drafts$/, '_steps')
        if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(steps)) {
          db.prepare(`UPDATE ${steps} SET patch = replace(patch, ?, ?) WHERE work_item_id = ? AND instr(patch, ?) > 0`).run(oldQ, newQ, id, oldQ)
        }
      }
    }
  })()
  // The registry is repointed now, so nothing below may throw: a caller treats a throw as "nothing was
  // rewritten" and puts the file back, which would leave these new references pointing at an empty place.
  for (const id of ids) {
    let versions: { source_path: string | null }[] = []
    try { versions = db.prepare('SELECT source_path FROM work_item_versions WHERE work_item_id = ?').all(id) as { source_path: string | null }[] } catch { continue }
    for (const v of versions) {
      const rel = v.source_path
      if (!rel || !/\.json$/i.test(rel)) continue
      try {
        const abs = resolveLifePath(rel)
        if (!abs) continue
        const text = readFileSync(abs, 'utf8')
        if (text.includes(oldQ)) writeFileSync(abs, text.split(oldQ).join(newQ))
      } catch { /* unreadable or vanished version file: the move itself already succeeded */ }
    }
  }
}
export type MoveFilesResult =
  | { ok: true; moved: string[]; skipped: MoveFilesSkip[] }
  | { ok: false; code: WorkFolderError | 'no_files' }

/** True when the registry (an item, a version, a part, a material, a deck draft or a saved version file) names the file. */
function loosePathsInUse(project: ProjectRow, rels: string[]): Set<string> {
  const used = new Set<string>()
  const ids = (getDb().prepare('SELECT id FROM work_items WHERE project_id = ?').all(project.id) as { id: string }[]).map((r) => r.id)
  const { eq, hay } = itemRefSources(ids)
  for (const rel of rels) {
    // Inside JSON a name with `"` or `\` is stored escaped, so look for that form too.
    const enc = JSON.stringify(rel).slice(1, -1)
    if (eq.has(rel) || hay.some((h) => h.includes(rel) || (enc !== rel && h.includes(enc)))) used.add(rel)
  }
  return used
}

/** Every path these work items name: exact paths (`eq`: item/version/part/asset columns) and JSON texts to search (`hay`: drafts, saved version files). */
function itemRefSources(ids: string[]): { eq: Set<string>; hay: string[] } {
  const db = getDb()
  const hay: string[] = []
  const eq = new Set<string>()
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB 'work_item_[a-z]*_drafts'").all() as { name: string }[]
  for (const id of ids) {
    const it = db.prepare('SELECT source_path FROM work_items WHERE id = ?').get(id) as { source_path: string | null }
    if (it.source_path) eq.add(it.source_path)
    for (const v of db.prepare('SELECT source_path FROM work_item_versions WHERE work_item_id = ?').all(id) as { source_path: string | null }[]) {
      if (!v.source_path) continue
      eq.add(v.source_path)
      if (/\.json$/i.test(v.source_path)) {
        try { const abs = resolveLifePath(v.source_path); if (abs) hay.push(readFileSync(abs, 'utf8')) } catch { /* unreadable: nothing to scan */ }
      }
    }
    for (const r of db.prepare('SELECT asset_path FROM work_item_parts WHERE work_item_id = ?').all(id) as { asset_path: string | null }[]) if (r.asset_path) eq.add(r.asset_path)
    for (const r of db.prepare('SELECT path FROM work_item_assets WHERE work_item_id = ?').all(id) as { path: string }[]) eq.add(r.path)
    for (const { name } of tables) {
      if (!/^work_item_[a-z]+_drafts$/.test(name)) continue
      for (const r of db.prepare(`SELECT doc FROM ${name} WHERE work_item_id = ?`).all(id) as { doc: string | null }[]) if (r.doc) hay.push(r.doc)
    }
  }
  return { eq, hay }
}

/** #492: the titles of live work items OUTSIDE `skipIds` that name anything under the Depot-relative folder `dirRel`. */
function itemsUsingFolder(project: ProjectRow, dirRel: string, skipIds: string[]): string[] {
  const skip = new Set(skipIds)
  const prefix = dirRel.replace(/\/+$/, '') + '/'
  const enc = JSON.stringify(prefix).slice(1, -1)
  const rows = getDb().prepare('SELECT id, title FROM work_items WHERE project_id = ? AND deleted_at IS NULL').all(project.id) as { id: string; title: string }[]
  const out: string[] = []
  for (const r of rows) {
    if (skip.has(r.id)) continue
    const { eq, hay } = itemRefSources([r.id])
    if ([...eq].some((p) => p.startsWith(prefix)) || hay.some((h) => h.includes(prefix) || (enc !== prefix && h.includes(enc)))) out.push(r.title)
  }
  return out
}

/**
 * Move loose files (listed in the box, not work items) into another folder of the box: the Workbench
 * list's "move to folder" for ticked files. Never overwrites (a taken name is skipped). A file a work item
 * references (a deck's slide picture) moves too: its reference is repointed to the new path so the deck is
 * not broken (#486, Boss TG 2026-10-04 "a diákat a prezentáció mellé akartam rakni, nem engedte").
 * The target may be a folder that already holds a (flattened) work item: the files simply sit alongside it,
 * which is the whole point of seeing what belongs together in one folder.
 * A file lying in a work item's OWN folder is skipped as `item_file` (#492, Boss TG 7948): it belongs to the
 * item and is never taken away from it; copyLooseFiles makes an independent copy instead.
 */
export function moveLooseFiles(project: ProjectRow, rels: unknown, folder: unknown): MoveFilesResult {
  const want = Array.isArray(rels) ? [...new Set(rels.map((r) => String(r ?? '')).filter(Boolean))].slice(0, WORK_FILES_TOTAL_MAX) : []
  if (!want.length) return { ok: false, code: 'no_files' }
  const c = workFolderTarget(project, folder)
  if (!c.ok) return c
  const target = projectFileTarget(project, c.folder)
  if (!target.ok) return target
  const wf = listWorkFolders(project)
  const loose = new Map<string, string>()
  const itemFiles = new Set<string>()
  for (const k of Object.keys(wf.files)) for (const f of wf.files[k] ?? []) { loose.set(f.rel, k); if (f.item) itemFiles.add(f.rel) }
  const inUse = loosePathsInUse(project, want.filter((r) => loose.has(r)))
  const moved: string[] = []
  const skipped: MoveFilesSkip[] = []
  for (const rel of want) {
    const name = rel.slice(rel.lastIndexOf('/') + 1)
    const from = loose.get(rel)
    if (from === undefined) { skipped.push({ name, reason: 'not_loose' }); continue }
    if (from === c.folder) { skipped.push({ name, reason: 'same_place' }); continue }
    // #492: a file in a work item's own folder belongs to that item: it is never taken away, only copied.
    if (itemFiles.has(rel)) { skipped.push({ name, reason: 'item_file' }); continue }
    const src = resolveLifePath(rel)
    const newRel = `${target.dirRel}/${name}`
    const dst = join(target.dirAbs, name)
    const blocked = writeBlockReason(newRel)
    if (!src || blocked) { skipped.push({ name, reason: 'failed' }); continue }
    if (existsSync(dst)) { skipped.push({ name, reason: 'name_taken' }); continue }
    try { renameSync(src, dst) } catch { skipped.push({ name, reason: 'failed' }); continue }
    // #486: if a work item references this file, its reference follows to the new path (no dead link).
    // The registry repoint is one transaction, so a throw means nothing was rewritten: the file goes back to
    // where its references still point, and then 'failed' is the truth (as in renameLooseFile). Only if even
    // that is impossible does it stay -- it really is in the new place then, so it counts as moved (#487).
    if (inUse.has(rel)) {
      try { repointMovedFileRefs(project, rel, newRel) } catch {
        let back = false
        try { renameSync(dst, src); back = true } catch { /* it stays in the new place */ }
        if (back) { skipped.push({ name, reason: 'failed' }); continue }
      }
    }
    moved.push(name)
  }
  return { ok: true, moved, skipped }
}

export type CopyFilesResult =
  | { ok: true; copied: string[]; skipped: MoveFilesSkip[] }
  | { ok: false; code: WorkFolderError | 'no_files' }

/**
 * #492: copy listed files into a folder of the box. The original stays where it is (a work item's picture
 * stays with its item); the copy is an independent file nothing references. Never overwrites: a taken name
 * gets the next free `name (N)`, and `copied` holds the names the copies really got.
 */
export async function copyLooseFiles(project: ProjectRow, rels: unknown, folder: unknown, lang = APP_LANG): Promise<CopyFilesResult> {
  const want = Array.isArray(rels) ? [...new Set(rels.map((r) => String(r ?? '')).filter(Boolean))].slice(0, WORK_FILES_TOTAL_MAX) : []
  if (!want.length) return { ok: false, code: 'no_files' }
  const c = workFolderTarget(project, folder)
  if (!c.ok) return c
  const target = projectFileTarget(project, c.folder)
  if (!target.ok) return target
  const wf = listWorkFolders(project)
  const loose = new Map<string, string>()
  for (const k of Object.keys(wf.files)) for (const f of wf.files[k] ?? []) loose.set(f.rel, k)
  const copied: string[] = []
  const skipped: MoveFilesSkip[] = []
  for (const rel of want) {
    const name = rel.slice(rel.lastIndexOf('/') + 1)
    const from = loose.get(rel)
    if (from === undefined) { skipped.push({ name, reason: 'not_loose' }); continue }
    if (from === c.folder) { skipped.push({ name, reason: 'same_place' }); continue }
    if (writeBlockReason(`${target.dirRel}/${name}`)) { skipped.push({ name, reason: 'failed' }); continue }
    const r = await copyLife(rel, target.dirRel, lang, { keepBoth: true })
    if (r.ok) copied.push(r.rel.slice(r.rel.lastIndexOf('/') + 1))
    else skipped.push({ name, reason: 'failed' })
  }
  return { ok: true, copied, skipped }
}

/** After a file went to the Kuka: work items, versions, parts and materials stop pointing at the vanished path. */
function detachDeletedFileRefs(rel: string): void {
  const db = getDb()
  try {
    db.prepare('UPDATE work_items SET source_path = NULL WHERE source_path = ?').run(rel)
    db.prepare('UPDATE work_item_versions SET source_path = NULL WHERE source_path = ?').run(rel)
    db.prepare('UPDATE work_item_parts SET asset_path = NULL WHERE asset_path = ?').run(rel)
    db.prepare('DELETE FROM work_item_assets WHERE path = ?').run(rel)
  } catch { /* the file is already in the Kuka; a stale reference only shows as a missing picture */ }
}

/** The owner deleted an item's snapshot file: remember it, so the snapshot sweep never writes it back. */
function optOutSnapshot(project: ProjectRow, rel: string): void {
  const db = getDb()
  try {
    db.exec('CREATE TABLE IF NOT EXISTS work_item_snapshot_off (work_item_id TEXT PRIMARY KEY)')
    const dir = rel.slice(0, rel.lastIndexOf('/'))
    const rows = db.prepare("SELECT id, folder FROM work_items WHERE project_id = ? AND folder IS NOT NULL AND folder != ''").all(project.id) as { id: string; folder: string }[]
    for (const r of rows) {
      const t = projectFileTarget(project, r.folder)
      if (t.ok && t.dirRel.replace(/\/+$/, '') === dir) db.prepare('INSERT OR IGNORE INTO work_item_snapshot_off (work_item_id) VALUES (?)').run(r.id)
    }
  } catch { /* worst case the snapshot is written again: never a failed delete */ }
}

export type DeleteFilesResult =
  | { ok: true; deleted: string[]; skipped: MoveFilesSkip[] }
  | { ok: false; code: 'no_files' | 'no_box' }

/**
 * #483: delete ticked loose files (the Workbench list's "Delete" for files, always behind a confirmation in the UI).
 * Only a file that really is loose in the box is deleted; a file the registry names (a deck picture, a version file,
 * a material) is deleted too, and the work items forget it (no limits; the Kuka keeps a copy).
 */
export function deleteLooseFiles(project: ProjectRow, rels: unknown): DeleteFilesResult {
  const want = Array.isArray(rels) ? [...new Set(rels.map((r) => String(r ?? '')).filter(Boolean))].slice(0, WORK_FILES_TOTAL_MAX) : []
  if (!want.length) return { ok: false, code: 'no_files' }
  if (!findWorkItemsBox(project)) return { ok: false, code: 'no_box' }
  const wf = listWorkFolders(project)
  const loose = new Set<string>()
  for (const k of Object.keys(wf.files)) for (const f of wf.files[k] ?? []) loose.add(f.rel)
  // A work item's own snapshot file (marveen-item.json) is deletable too, and it is NOT written back (Boss 2511).
  const boxT = wf.box ? projectFileTarget(project, wf.box) : null
  const boxRel = boxT && boxT.ok ? boxT.dirRel.replace(/\/+$/, '') + '/' : null
  const snapshots = new Set<string>()
  for (const r of want) {
    if (loose.has(r) || !boxRel || !r.startsWith(boxRel) || r.slice(r.lastIndexOf('/') + 1) !== ITEM_SNAPSHOT_NAME) continue
    const a = resolveLifePath(r)
    if (a && existsSync(a)) { loose.add(r); snapshots.add(r) }
  }
  const inUse = loosePathsInUse(project, want.filter((r) => loose.has(r) && !snapshots.has(r)))
  const deleted: string[] = []
  const skipped: MoveFilesSkip[] = []
  for (const rel of want) {
    const name = rel.slice(rel.lastIndexOf('/') + 1)
    if (!loose.has(rel)) { skipped.push({ name, reason: 'not_loose' }); continue }
    const src = resolveLifePath(rel)
    if (!src || writeBlockReason(rel)) { skipped.push({ name, reason: 'failed' }); continue }
    // #492: a loose file goes to the Kuka (restorable), never straight to oblivion.
    const t = trashLife(rel)
    if (t.ok) {
      deleted.push(name)
      // A file a work item names is deletable too: the item simply forgets it, so nothing is "missing" later.
      if (inUse.has(rel)) detachDeletedFileRefs(rel)
      if (snapshots.has(rel)) optOutSnapshot(project, rel)
    }
    else skipped.push({ name, reason: 'failed' })
  }
  return { ok: true, deleted, skipped }
}

export type RenameFileResult =
  | { ok: true; name: string; renamed: boolean }
  | { ok: false; code: 'file_name' | 'file_not_loose' | 'file_name_taken' | 'write_failed' | 'no_box'; message?: string }

/**
 * #483: rename a loose file in place (same folder, never overwrites). A file a work item references (a deck
 * picture) is renamed too and every reference follows the new path, exactly like a move (#487); if the
 * references cannot be rewritten the rename is undone, so no link is left dead.
 */
export function renameLooseFile(project: ProjectRow, rel: unknown, newName: unknown): RenameFileResult {
  if (!findWorkItemsBox(project)) return { ok: false, code: 'no_box' }
  const from = String(rel ?? '')
  const seg = String(newName ?? '').trim()
  const clean = safeLifeName(seg)
  if (!seg || seg.includes('/') || seg.includes('\\') || !clean || clean === '_' || clean.startsWith('.') || clean.length > 120 || clean !== seg) return { ok: false, code: 'file_name' }
  const wf = listWorkFolders(project)
  let folder: string | null = null
  for (const k of Object.keys(wf.files)) if ((wf.files[k] ?? []).some((f) => f.rel === from)) { folder = k; break }
  if (folder === null) return { ok: false, code: 'file_not_loose' }
  const oldName = from.slice(from.lastIndexOf('/') + 1)
  if (clean === oldName) return { ok: true, name: clean, renamed: false }
  const src = resolveLifePath(from)
  const newRel = `${from.slice(0, from.lastIndexOf('/'))}/${clean}`
  const dst = resolveLifePath(newRel)
  const blocked = writeBlockReason(newRel)
  if (!src || !dst || blocked) return { ok: false, code: 'write_failed', message: blocked ?? undefined }
  // A case-only rename ("a.png" -> "A.png") names the same file on a case-insensitive disk: not a clash.
  if (clean.toLowerCase() !== oldName.toLowerCase() && existsSync(dst)) return { ok: false, code: 'file_name_taken' }
  const used = loosePathsInUse(project, [from]).has(from)
  try { renameSync(src, dst) } catch (e) { return { ok: false, code: 'write_failed', message: e instanceof Error ? e.message : String(e) } }
  if (used) {
    try { repointMovedFileRefs(project, from, newRel) } catch (e) {
      try { renameSync(dst, src) } catch { /* the error below goes on */ }
      return { ok: false, code: 'write_failed', message: e instanceof Error ? e.message : String(e) }
    }
  }
  return { ok: true, name: clean, renamed: true }
}

/** True when a drawing file lies anywhere inside the folder (depth-limited walk). */
function folderHasCanvas(abs: string, depth = 0): boolean {
  if (depth > WORK_FOLDER_MAX_DEPTH) return false
  let entries: import('node:fs').Dirent[]
  try { entries = readdirSync(abs, { withFileTypes: true }) } catch { return false }
  for (const d of entries) {
    if (d.isFile() && isCanvasFile(d.name)) return true
    if (d.isDirectory() && folderHasCanvas(join(abs, d.name), depth + 1)) return true
  }
  return false
}

/**
 * After a folder moved on disk: every path the registry keeps under it follows, in one transaction.
 * `oldRel`/`newRel` are project-relative folder paths (work_items.folder / container_folder),
 * `oldPrefix`/`newPrefix` Depot-relative with a trailing slash (everything else).
 */
function rewriteFolderRefs(project: ProjectRow, oldRel: string, newRel: string, oldPrefix: string, newPrefix: string): void {
  const db = getDb()
  const swapRel = (p: string | null): string | null => (p === oldRel ? newRel : p && p.startsWith(oldRel + '/') ? newRel + p.slice(oldRel.length) : p)
  const swap = (p: string | null): string | null => (p && p.startsWith(oldPrefix) ? newPrefix + p.slice(oldPrefix.length) : p)
  const ids: string[] = []
  db.transaction(() => {
    const items = db.prepare('SELECT id, folder, container_folder, source_path FROM work_items WHERE project_id = ?').all(project.id) as { id: string; folder: string | null; container_folder: string | null; source_path: string | null }[]
    for (const it of items) {
      const f = swapRel(it.folder), cf = swapRel(it.container_folder), sp = swap(it.source_path)
      if (f !== it.folder || cf !== it.container_folder || sp !== it.source_path) db.prepare('UPDATE work_items SET folder = ?, container_folder = ?, source_path = ? WHERE id = ?').run(f, cf, sp, it.id)
      ids.push(it.id)
    }
    for (const id of ids) {
      for (const v of db.prepare('SELECT id, source_path FROM work_item_versions WHERE work_item_id = ?').all(id) as { id: string; source_path: string | null }[]) {
        if (v.source_path && v.source_path.startsWith(oldPrefix)) db.prepare('UPDATE work_item_versions SET source_path = ? WHERE id = ?').run(swap(v.source_path), v.id)
      }
      for (const r of db.prepare('SELECT id, asset_path FROM work_item_parts WHERE work_item_id = ?').all(id) as { id: string; asset_path: string | null }[]) {
        if (r.asset_path && r.asset_path.startsWith(oldPrefix)) db.prepare('UPDATE work_item_parts SET asset_path = ? WHERE id = ?').run(swap(r.asset_path), r.id)
      }
      for (const a of db.prepare('SELECT id, path FROM work_item_assets WHERE work_item_id = ?').all(id) as { id: string; path: string }[]) {
        if (a.path.startsWith(oldPrefix)) db.prepare('UPDATE work_item_assets SET path = ? WHERE id = ?').run(swap(a.path), a.id)
      }
      moveDocModelPaths(getWorkItem(id) as WorkItemRow, project.id, `${oldRel}/`, `${newRel}/`, swap)
      moveDraftDocPaths(id, oldPrefix, newPrefix)
    }
  })()
  for (const id of ids) moveVersionFilePaths(id, oldPrefix, newPrefix)
}

/**
 * #481: a work item's folder now physically sits in ANOTHER project (the owner moved it in the file
 * manager). Re-homes the item: project_id + folder + container_folder, and EVERY path the registry keeps for
 * it (source_path, versions, parts, assets, doc model, drafts) moves from the old project's depot prefix to
 * the new one in one transaction -- the file links must not break. `newFolder` is project-relative in the
 * NEW project, or null when the file sits in that project's root. Only this item's records are touched.
 */
export function rehomeWorkItem(item: WorkItemRow, from: ProjectRow, to: ProjectRow, newFolder: string | null, prefixes?: { old: string; new: string }): void {
  if (!prefixes && (!from.folder_path || !to.folder_path)) return
  const db = getDb()
  const oldRel = item.folder ?? ''
  const base = (p: ProjectRow): string => (p.folder_path ?? '').replace(/\/+$/, '')
  const oldPrefix = prefixes?.old ?? (oldRel ? `${base(from)}/${oldRel}` : base(from)) + '/'
  const newPrefix = prefixes?.new ?? (newFolder ? `${base(to)}/${newFolder}` : base(to)) + '/'
  const swap = (p: string | null): string | null => (p && p.startsWith(oldPrefix) ? newPrefix + p.slice(oldPrefix.length) : p)
  const container = newFolder ? (newFolder.includes('/') ? newFolder.slice(0, newFolder.lastIndexOf('/')) : null) : PROJECT_ROOT_PLACE
  db.transaction(() => {
    // Doc model rows are looked up through the item's project, so they go first, while it is still the old one.
    moveDocModelPaths(item, from.id, `${oldRel}/`, `${newFolder ?? ''}/`, swap)
    moveDraftDocPaths(item.id, oldPrefix, newPrefix)
    for (const v of db.prepare('SELECT id, source_path FROM work_item_versions WHERE work_item_id = ?').all(item.id) as { id: string; source_path: string | null }[]) {
      if (v.source_path && v.source_path.startsWith(oldPrefix)) db.prepare('UPDATE work_item_versions SET source_path = ? WHERE id = ?').run(swap(v.source_path), v.id)
    }
    for (const r of db.prepare('SELECT id, asset_path FROM work_item_parts WHERE work_item_id = ?').all(item.id) as { id: string; asset_path: string | null }[]) {
      if (r.asset_path && r.asset_path.startsWith(oldPrefix)) db.prepare('UPDATE work_item_parts SET asset_path = ? WHERE id = ?').run(swap(r.asset_path), r.id)
    }
    for (const a of db.prepare('SELECT id, path FROM work_item_assets WHERE work_item_id = ?').all(item.id) as { id: string; path: string }[]) {
      if (a.path.startsWith(oldPrefix)) db.prepare('UPDATE work_item_assets SET path = ? WHERE id = ?').run(swap(a.path), a.id)
    }
    db.prepare('UPDATE work_items SET project_id = ?, folder = ?, container_folder = ?, source_path = ?, updated_at = ? WHERE id = ?')
      .run(to.id, newFolder, container, swap(item.source_path ?? null), Math.floor(Date.now() / 1000), item.id)
  })()
  moveVersionFilePaths(item.id, oldPrefix, newPrefix)
}

/**
 * #454 (Boss: "fő munkadarab és almunkadarab nem lesz többé"): converts every old
 * main/sub link into folders. A sub item keeps its folder (already inside the
 * main item's folder) and just loses the link. A main item that has no own
 * content (no materials, no parts) IS the folder now, so it goes to the trash
 * (restorable, nothing on disk is touched); one with own content stays as a
 * plain work item in that same folder. Idempotent; returns how many subs moved.
 */
export function migrateSubItemsToFolders(): number {
  ensureAssetTables()
  const db = getDb()
  const subs = db.prepare('SELECT id, parent_item_id FROM work_items WHERE parent_item_id IS NOT NULL').all() as { id: string; parent_item_id: string }[]
  if (!subs.length) return 0
  const mains = new Set<string>()
  for (const s of subs) {
    const main = getWorkItem(s.parent_item_id)
    if (main) {
      mains.add(main.id)
      const pf = ensureWorkItemFolder(main)
      if (pf.ok) db.prepare('UPDATE work_items SET container_folder = ? WHERE id = ?').run(pf.folder, s.id)
    }
    db.prepare('UPDATE work_items SET parent_item_id = NULL WHERE id = ?').run(s.id)
  }
  for (const id of mains) {
    const main = getWorkItem(id)
    if (!main || main.deleted_at != null) continue
    const own = (db.prepare('SELECT COUNT(*) AS n FROM work_item_assets WHERE work_item_id = ?').get(id) as { n: number }).n
    if (own === 0 && listWorkItemParts(id).length === 0) {
      db.prepare('UPDATE work_items SET deleted_at = ? WHERE id = ?').run(Date.now(), id)
    }
  }
  return subs.length
}

export interface FolderMigration { moved: number; skipped: number; container: string | null }

/** Every project with a folder gets its "Munkadarabok" folder and the old item folders move under it. */
export function migrateAllWorkItemFolders(): { projects: number; moved: number; skipped: number } {
  let projects = 0, moved = 0, skipped = 0
  for (const p of listProjects({ includeArchived: true })) {
    if (!p.folder_path) continue
    const r = migrateWorkItemFolders(p)
    if (r.container) projects++
    moved += r.moved
    skipped += r.skipped
  }
  return { projects, moved, skipped }
}

/**
 * Makes sure the project has its "Munkadarabok" folder and moves the work item
 * folders that still sit elsewhere under it (registry paths follow). Items
 * whose folder is shared with another item or holds a drawing stay where they
 * are (relocateWorkItemFolder says why). Idempotent.
 */
export function migrateWorkItemFolders(project: ProjectRow): FolderMigration {
  ensureAssetTables()
  const box = projectWorkItemsFolder(project)
  if (!box.ok) return { moved: 0, skipped: 0, container: null }
  let moved = 0
  let skipped = 0
  const items = getDb().prepare("SELECT id FROM work_items WHERE project_id = ? AND folder IS NOT NULL AND folder != '' AND COALESCE(container_folder, '') != ?").all(project.id, PROJECT_ROOT_PLACE) as { id: string }[]
  for (const { id } of items) {
    const item = getWorkItem(id)
    const folder = item ? workItemFolder(id) : null
    if (!item || !folder || folder === box.folder || folder.startsWith(box.folder + '/')) continue
    const seg = folder.includes('/') ? folder.slice(folder.lastIndexOf('/') + 1) : folder
    const r = relocateWorkItemFolder(item, seg, box.folder)
    if (r.ok && r.renamed) moved++
    else skipped++
  }
  return { moved, skipped, container: box.folder }
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
  // #454: the folder the owner picked in the new-item form (must still exist
  // inside the work items box); otherwise the default box.
  let parentFolder: string | null = null
  if (item.container_folder === PROJECT_ROOT_PLACE) {
    // #479: made directly in the project folder, not in the work items box.
    const root = projectFileTarget(project, '')
    if (!root.ok) return root
    const rr = makeProjectFolder(project, '', freeFileName(root.dirAbs, folderNameFromTitle(item.title)))
    if (!rr.ok) return rr
    setItemFolder(item.id, rr.sub)
    return { ok: true, folder: rr.sub, created: rr.created }
  }
  if (item.container_folder) {
    const c = workFolderTarget(project, item.container_folder)
    if (c.ok) parentFolder = c.folder
  }
  const r = makeFreshFolder(project, item.title, parentFolder)
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

export type DeleteAssetFileOutcome =
  | { ok: true }
  | { ok: false; code: 'asset_not_found' | 'asset_in_use' | 'asset_outside' | 'delete_failed'; users?: string[] }

/**
 * LEVETEL + VEGLEGES TORLES A MAPPABOL (Boss, 2026-09-29, 1884: "szemetet nem
 * kellene hagyni a rendszerben"). A fajl a lemezrol is torlodik, az anyag-sor
 * is megy. NEM torol, ha a fajlt mas is hasznalja -- egy masik munkadarab
 * anyaga, egy munkadarab fo fajlja, egy verzio vagy egy resz --, mert az
 * eltorne (`asset_in_use`, a hasznalok cimevel). A projekt mappajan kivuli
 * fajlhoz nem nyul (`asset_outside`).
 */
export function deleteAssetFile(itemId: string, assetId: string): DeleteAssetFileOutcome {
  ensureAssetTables()
  const db = getDb()
  const row = db.prepare('SELECT * FROM work_item_assets WHERE id = ? AND work_item_id = ? AND removed_at IS NULL')
    .get(assetId, itemId) as WorkItemAssetRow | undefined
  if (!row) return { ok: false, code: 'asset_not_found' }
  const item = getWorkItem(itemId)
  const project = item ? getProject(item.project_id) : undefined
  if (!item || !project) return { ok: false, code: 'asset_not_found' }
  const users = new Set<string>()
  const title = (id: string): string => (getWorkItem(id)?.title ?? id)
  for (const r of db.prepare('SELECT work_item_id FROM work_item_assets WHERE path = ? AND id <> ? AND removed_at IS NULL').all(row.path, row.id) as { work_item_id: string }[]) users.add(title(r.work_item_id))
  for (const r of db.prepare('SELECT id FROM work_items WHERE source_path = ?').all(row.path) as { id: string }[]) users.add(title(r.id))
  for (const r of db.prepare('SELECT work_item_id FROM work_item_versions WHERE source_path = ? OR manifest_path = ? OR preview_path = ?').all(row.path, row.path, row.path) as { work_item_id: string }[]) users.add(title(r.work_item_id))
  for (const r of db.prepare('SELECT work_item_id FROM work_item_parts WHERE asset_path = ?').all(row.path) as { work_item_id: string }[]) users.add(title(r.work_item_id))
  if (users.size) return { ok: false, code: 'asset_in_use', users: [...users] }
  const base = projectFileTarget(project, '')
  const abs = resolveLifePath(row.path)
  if (!base.ok || !abs || !abs.startsWith(base.dirAbs + sep)) return { ok: false, code: 'asset_outside' }
  try {
    if (existsSync(abs)) unlinkSync(abs)
  } catch { return { ok: false, code: 'delete_failed' } }
  db.prepare('DELETE FROM work_item_assets WHERE id = ?').run(row.id)
  return { ok: true }
}

export type WorkbenchPlace = 'assets' | 'shared' | 'versions' | 'asset'
export type PlaceOutcome =
  | { ok: true; abs: string; dirRel: string; select: string | null }
  | { ok: false; code: 'no_item_folder' | 'no_shared_folder' | 'asset_not_found' | 'not_found' | 'bad_place' }

/**
 * WHERE a Workbench list keeps its files, for the "open the folder" buttons
 * (#443, Boss 2026-09-29): the materials of a work item (its own folder), the
 * shared materials of the project, the versions (the folder of the current
 * version's file), or one material row (its folder, the file selected).
 * Everything stays inside the project folder -- a path outside it is
 * `not_found`, never opened.
 */
export function workbenchPlace(project: ProjectRow, item: WorkItemRow | null, place: unknown, assetId: unknown = null): PlaceOutcome {
  const root = projectFileTarget(project, '')
  if (!root.ok) return { ok: false, code: 'not_found' }
  const inside = (abs: string | null): abs is string => !!abs && (abs === root.dirAbs || abs.startsWith(root.dirAbs + sep)) && existsSync(abs)
  const out = (abs: string, select: string | null): PlaceOutcome => {
    const dir = select ? dirname(abs) : abs
    return { ok: true, abs, dirRel: toLifeRel(dir), select }
  }
  if (place === 'shared') {
    const sh = projectSharedFolder(project)
    if (!sh.ok) return { ok: false, code: 'no_shared_folder' }
    return out(sh.dirAbs, null)
  }
  // #476: no item picked -> the project's work items box, else the project folder itself (never a dead end).
  if (place === 'box') {
    const box = findWorkItemsBox(project)
    const t = box ? projectFileTarget(project, box) : root
    return out(t.ok && inside(t.dirAbs) ? t.dirAbs : root.dirAbs, null)
  }
  if (!item || item.project_id !== project.id) return { ok: false, code: 'not_found' }
  // The item's own folder, else the folder it is filed in (Boss #455: an item
  // that has no files yet still sits in a real folder; "no folder" was a lie).
  const itemDir = (): string | null => {
    for (const f of [workItemFolder(item.id), item.container_folder]) {
      if (!f || f === PROJECT_ROOT_PLACE) continue
      const t = projectFileTarget(project, f)
      if (t.ok && inside(t.dirAbs)) return t.dirAbs
    }
    return null
  }
  if (place === 'assets') {
    const d = itemDir()
    return d ? out(d, null) : { ok: false, code: 'no_item_folder' }
  }
  if (place === 'versions') {
    const cur = item.current_version_id ? getWorkItemVersion(item.current_version_id) : undefined
    for (const rel of [cur?.source_path, item.source_path]) {
      const abs = rel ? resolveLifePath(rel) : null
      if (inside(abs)) return out(dirname(abs), null)
    }
    const d = itemDir()
    return d ? out(d, null) : { ok: false, code: 'no_item_folder' }
  }
  if (place === 'asset') {
    ensureAssetTables()
    const row = getDb().prepare('SELECT path, name FROM work_item_assets WHERE id = ? AND work_item_id = ? AND removed_at IS NULL')
      .get(String(assetId ?? ''), item.id) as { path: string; name: string } | undefined
    if (!row) return { ok: false, code: 'asset_not_found' }
    const abs = resolveLifePath(row.path)
    if (!inside(abs)) return { ok: false, code: 'asset_not_found' }
    return out(abs, abs.slice(abs.lastIndexOf(sep) + 1))
  }
  return { ok: false, code: 'bad_place' }
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
// Atnevezes: #478 -- a munkadarab neve FUGGETLEN a mappa nevetol

export type RenameItemOutcome =
  | { ok: true; item: WorkItemRow; folder: FolderRenameOutcome }
  | { ok: false; code: 'title_required' | 'title_too_long' }

/**
 * #478 (Boss, grouping model): the work item's name is its own. Renaming it never touches a folder,
 * and renaming a folder (a named group) never touches a work item's name. The `folder` field is kept
 * in the answer so older callers keep working; it always says "independent".
 */
export function renameWorkItem(item: WorkItemRow, rawTitle: unknown): RenameItemOutcome {
  ensureAssetTables()
  const title = String(rawTitle ?? '').trim()
  if (!title) return { ok: false, code: 'title_required' }
  if (title.length > TITLE_MAX) return { ok: false, code: 'title_too_long' }
  getDb().prepare('UPDATE work_items SET title = ?, updated_at = ? WHERE id = ?').run(title, Math.floor(Date.now() / 1000), item.id)
  return { ok: true, item: getWorkItem(item.id) as WorkItemRow, folder: { ok: true, renamed: false, reason: 'independent' } }
}
// ---------------------------------------------------------------------------

export type FolderRenameOutcome =
  | { ok: true; renamed: false; reason: 'no_folder' | 'same_name' | 'missing' | 'shared' | 'canvas' | 'independent' }
  | { ok: true; renamed: true; from: string; to: string }
  | { ok: false; code: 'move_failed'; message: string }

/**
 * A munkadarab mappajat a megadott nevre nevezi at, es MINDEN hivatkozas
 * (a munkadarab, a verzioi, a reszei, az anyagai) az uj helyre mutat.
 * Nem nevezzuk at (es megmondjuk, miert), ha:
 *   - nincs sajat mappa / a mappa nincs meg,
 *   - egy MASIK munkadarab is hivatkozik a mappa valamelyik fajljara,
 *   - rajz (.canvas.json) van benne: a rajz a kepeit utvonallal hivja, azt
 *     nem irjuk at vakon -- a mappa ilyenkor a regi neven marad.
 * #478: a munkadarab atnevezese (felulet + Agent) mar NEM hivja; a nevek fuggetlenek.
 */
export function renameWorkItemFolder(item: WorkItemRow, newTitle: string): FolderRenameOutcome {
  return relocateWorkItemFolder(item, folderNameFromTitle(newTitle), null)
}

/**
 * The one mover behind both the rename and the move into the project's
 * "Munkadarabok" folder: the folder gets the name `wanted` under `newParentRel`
 * (project-relative; null = stay under the current parent), and every path the
 * registry keeps follows in one transaction.
 */
function relocateWorkItemFolder(item: WorkItemRow, wanted: string, newParentRel: string | null): FolderRenameOutcome {
  ensureAssetTables()
  const folder = workItemFolder(item.id)
  if (!folder) return { ok: true, renamed: false, reason: 'no_folder' }
  const project = getProject(item.project_id)
  if (!project) return { ok: true, renamed: false, reason: 'missing' }
  const cur = projectFileTarget(project, folder)
  if (!cur.ok) return { ok: true, renamed: false, reason: 'missing' }
  const curParentRel = folder.includes('/') ? folder.slice(0, folder.lastIndexOf('/')) : ''
  const parentRel = newParentRel ?? curParentRel
  const lastSeg = folder.includes('/') ? folder.slice(folder.lastIndexOf('/') + 1) : folder
  if (wanted === lastSeg && parentRel === curParentRel) return { ok: true, renamed: false, reason: 'same_name' }
  const oldPrefix = cur.dirRel + '/'
  const db = getDb()
  const like = oldPrefix.replace(/[\\%_]/g, (c) => '\\' + c) + '%'
  const shared = db.prepare(`SELECT 1 FROM work_items WHERE id != ? AND source_path LIKE ? ESCAPE '\\'
    UNION SELECT 1 FROM work_item_versions WHERE work_item_id != ? AND source_path LIKE ? ESCAPE '\\'
    UNION SELECT 1 FROM work_item_parts WHERE work_item_id != ? AND asset_path LIKE ? ESCAPE '\\'
    UNION SELECT 1 FROM work_item_assets WHERE work_item_id != ? AND path LIKE ? ESCAPE '\\' AND removed_at IS NULL LIMIT 1`)
    .get(item.id, like, item.id, like, item.id, like, item.id, like)
  if (shared) return { ok: true, renamed: false, reason: 'shared' }
  // A drawing's saved versions now live in this folder too (Boss TG 2545): they move with it, and the paths
  // inside them follow (moveVersionFilePaths), so a drawing no longer blocks the move.
  try { readdirSync(cur.dirAbs) } catch { return { ok: true, renamed: false, reason: 'missing' } }
  const parentT = projectFileTarget(project, parentRel)
  if (!parentT.ok) return { ok: true, renamed: false, reason: 'missing' }
  const parentAbs = parentT.dirAbs
  if (parentAbs === cur.dirAbs || parentAbs.startsWith(cur.dirAbs + sep)) return { ok: true, renamed: false, reason: 'missing' }
  const blocked = writeBlockReason(parentT.dirRel)
  if (blocked) return { ok: false, code: 'move_failed', message: blocked }
  const newSeg = freeFileName(parentAbs, wanted)
  const newAbs = join(parentAbs, newSeg)
  const newFolder = parentRel ? `${parentRel}/${newSeg}` : newSeg
  try { renameSync(cur.dirAbs, newAbs) } catch (e) {
    return { ok: false, code: 'move_failed', message: e instanceof Error ? e.message : String(e) }
  }
  const newPrefix = (toLifeRel(newAbs) || `${parentT.dirRel}/${newSeg}`) + '/'
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
      moveDocModelPaths(item, project.id, `${folder}/`, `${newFolder}/`, swap)
      moveDraftDocPaths(item.id, oldPrefix, newPrefix)
    })()
    moveVersionFilePaths(item.id, oldPrefix, newPrefix)
  } catch (e) {
    try { renameSync(newAbs, cur.dirAbs) } catch { /* a hibauzenet megy tovabb */ }
    return { ok: false, code: 'move_failed', message: e instanceof Error ? e.message : String(e) }
  }
  return { ok: true, renamed: true, from: folder, to: newFolder }
}

/**
 * An existing item whose own folder sits inside a group: make the GROUP its folder. The files of the own
 * sub-folder move up into the group (nothing is ever overwritten: a name clash aborts before anything
 * moves), the emptied sub-folder goes away, and every registry path follows (rehomeWorkItem, project
 * unchanged). Refused (no change) when another item uses either folder, a drawing refers to the folder by
 * path, or another item's paths point into it.
 */
function flattenIntoGroup(item: WorkItemRow, project: ProjectRow, own: string, group: string): MoveItemOutcome {
  const db = getDb()
  const others = db.prepare("SELECT 1 FROM work_items WHERE id != ? AND (folder = ? OR folder = ? OR folder LIKE ? ESCAPE '\\') LIMIT 1")
    .get(item.id, group, own, own.replace(/[\\%_]/g, (ch) => '\\' + ch) + '/%')
  if (others) return { ok: true, moved: false, folder: own, reason: 'shared' }
  const cur = projectFileTarget(project, own)
  const grp = projectFileTarget(project, group)
  if (!cur.ok || !grp.ok) return { ok: true, moved: false, folder: own, reason: 'missing' }
  const oldPrefix = cur.dirRel + '/'
  const newPrefix = grp.dirRel + '/'
  const like = oldPrefix.replace(/[\\%_]/g, (ch) => '\\' + ch) + '%'
  const shared = db.prepare(`SELECT 1 FROM work_items WHERE id != ? AND source_path LIKE ? ESCAPE '\\'
    UNION SELECT 1 FROM work_item_versions WHERE work_item_id != ? AND source_path LIKE ? ESCAPE '\\'
    UNION SELECT 1 FROM work_item_parts WHERE work_item_id != ? AND asset_path LIKE ? ESCAPE '\\'
    UNION SELECT 1 FROM work_item_assets WHERE work_item_id != ? AND path LIKE ? ESCAPE '\\' AND removed_at IS NULL LIMIT 1`)
    .get(item.id, like, item.id, like, item.id, like, item.id, like)
  if (shared) return { ok: true, moved: false, folder: own, reason: 'shared' }
  let names: string[]
  try { names = readdirSync(cur.dirAbs) } catch { return { ok: true, moved: false, folder: own, reason: 'missing' } }
  const blocked = writeBlockReason(grp.dirRel)
  if (blocked) return { ok: false, code: 'move_failed', message: blocked }
  const moving = names.filter((n) => n !== FOLDER_MARKER)
  // The group may hold a leftover registration file of an item that was deleted for good (a tombstone), or an
  // earlier copy of THIS item's own: that is bookkeeping, not owner content, so it is no name clash. It is
  // replaced by this item's own file moving up (the snapshot sweep never writes next to a tombstone).
  let staleSnapshot: string | null = null
  const groupSnap = join(grp.dirAbs, SNAPSHOT_FILE)
  if (moving.includes(SNAPSHOT_FILE) && existsSync(groupSnap)) {
    try {
      const text = readFileSync(groupSnap, 'utf8')
      const j = JSON.parse(text) as { tombstone?: boolean; id?: unknown }
      if (j.tombstone === true || String(j.id ?? '') === item.id) staleSnapshot = text
    } catch { /* unreadable: treated as a real clash below */ }
  }
  const clash = moving.find((n) => existsSync(join(grp.dirAbs, n)) && !(n === SNAPSHOT_FILE && staleSnapshot !== null))
  if (clash) {
    return { ok: false, code: 'move_failed', message: ol(
      `A(z) "${clash}" már van a csoportban, ezért nem tettem át semmit (nem írok felül fájlt). Nevezd át az egyiket, és próbáld újra.`,
      `"${clash}" already exists in the group, so nothing was moved (I never overwrite a file). Rename one of them and try again.`) }
  }
  const done: string[] = []
  const undo = (): void => {
    for (const n of done.reverse()) { try { renameSync(join(grp.dirAbs, n), join(cur.dirAbs, n)) } catch { /* best effort */ } }
    if (staleSnapshot !== null) { try { writeFileSync(groupSnap, staleSnapshot) } catch { /* best effort */ } }
  }
  try {
    if (staleSnapshot !== null) unlinkSync(groupSnap)
    for (const n of moving) { renameSync(join(cur.dirAbs, n), join(grp.dirAbs, n)); done.push(n) }
    rehomeWorkItem(item, project, project, group, { old: oldPrefix, new: newPrefix })
  } catch (e) {
    undo()
    return { ok: false, code: 'move_failed', message: e instanceof Error ? e.message : String(e) }
  }
  // The emptied sub-folder (and its auto-managed id file) goes away; the owner's own content never does.
  try { unlinkSync(join(cur.dirAbs, FOLDER_MARKER)) } catch { /* no marker */ }
  try { rmdirSync(cur.dirAbs) } catch { /* not empty after all (a file appeared meanwhile): it stays */ }
  db.prepare('DELETE FROM work_folder_ids WHERE project_id = ? AND path = ?').run(project.id, own)
  return { ok: true, moved: true, folder: group }
}

export type MoveItemOutcome =
  | { ok: true; moved: boolean; folder: string | null; reason?: 'same_place' | 'own_folder' | 'shared' | 'canvas' | 'missing' }
  | { ok: false; code: WorkFolderError | 'move_failed'; message?: string }

/**
 * Files an EXISTING work item into a folder of the work items box ('' = the box
 * itself): its own folder (if it has one) is moved inside the target, every
 * path follows; an item with no folder of its own yet just gets the new
 * container and makes its folder there. Nothing is ever overwritten.
 */
export function moveWorkItemToFolder(item: WorkItemRow, folder: unknown): MoveItemOutcome {
  ensureAssetTables()
  const project = getProject(item.project_id)
  if (!project) return { ok: false, code: 'not_found' as WorkFolderError }
  const c = workFolderTarget(project, folder)
  if (!c.ok) return c
  const own = workItemFolder(item.id)
  if (!own) {
    // Boss TG 2516: moving never makes a folder. The item has none of its own, so it only gets its new place.
    getDb().prepare('UPDATE work_items SET container_folder = ?, updated_at = ? WHERE id = ?').run(c.folder, Math.floor(Date.now() / 1000), item.id)
    return { ok: true, moved: true, folder: c.folder }
  }
  const curParent = own.includes('/') ? own.slice(0, own.lastIndexOf('/')) : ''
  // The target is the PARENT of the item's own folder: the owner wants the item directly in that group
  // (a folder is a named group, an own sub-folder is not mandatory) -> flatten. Only the work items box
  // itself is no group: there the item is simply where it belongs.
  if (curParent === c.folder) {
    if (curParent === (findWorkItemsBox(project) ?? '')) return { ok: true, moved: false, folder: own, reason: 'same_place' }
    return flattenIntoGroup(item, project, own, c.folder)
  }
  // The target is the item's own folder (or inside it): it already lives there.
  if (c.folder === own || c.folder.startsWith(own + '/')) return { ok: true, moved: false, folder: own, reason: 'own_folder' }
  const seg = own.includes('/') ? own.slice(own.lastIndexOf('/') + 1) : own
  const r = relocateWorkItemFolder(item, seg, c.folder)
  if (!r.ok) return { ok: false, code: 'move_failed', message: r.message }
  if (!r.renamed) return { ok: true, moved: false, folder: own, reason: r.reason === 'same_name' ? 'same_place' : r.reason === 'no_folder' || r.reason === 'independent' ? 'missing' : r.reason }
  getDb().prepare('UPDATE work_items SET container_folder = ?, updated_at = ? WHERE id = ?').run(c.folder, Math.floor(Date.now() / 1000), item.id)
  // #491 (Boss: "ne csinaljon mappat maganak!"): dropped on a group that holds no other work item, the item
  // goes DIRECTLY into the group; the title-named sub-folder the relocation just made would be pure nesting.
  // The flatten refuses (and the item then simply stays in its own sub-folder, nothing lost) on a name clash,
  // a drawing, or shared paths. A group that already holds other items keeps one sub-folder per item.
  if (c.folder !== (findWorkItemsBox(project) ?? '') && !groupHoldsOtherItem(item.id, c.folder)) {
    const fresh = getWorkItem(item.id) as WorkItemRow
    const flat = flattenIntoGroup(fresh, project, r.to, c.folder)
    if (flat.ok && flat.moved) return flat
  }
  return { ok: true, moved: true, folder: r.to }
}

/** True when a work item other than `itemId` lives in the group folder or anywhere below it. */
function groupHoldsOtherItem(itemId: string, group: string): boolean {
  const like = group.replace(/[\\%_]/g, (ch) => '\\' + ch) + '/%'
  return !!getDb().prepare("SELECT 1 FROM work_items WHERE id != ? AND (folder = ? OR folder LIKE ? ESCAPE '\\') LIMIT 1").get(itemId, group, like)
}

/**
 * A dokumentummodell utjai a mappaval egyutt (1/A): az irat-forrasok es a
 * mellekletek projekt-relativ utja (a projekt BARMELY munkadarabjaban, mert egy
 * masik dokumentum is idezhet ebbol a mappabol), es a vegleges PDF helye a
 * verzio adataiban. Nelkule egy atnevezes utan a forras "nem talalhato" lenne,
 * a melleklet "eltunt fajl", a vegleges PDF linkje pedig halott. A tablak csak
 * akkor leteznek, ha a dokumentummodellt mar hasznaltak -- ezert nezzuk meg elobb.
 */
/**
 * #471: a deck (or timeline) keeps its pictures as Depot-relative paths inside its JSON: in the working
 * draft and its undo steps (database), and in every saved version (a JSON file, in or outside the item's folder).
 * When the folder moves, those strings follow, otherwise every slide picture would be a dead link.
 */
function moveDraftDocPaths(itemId: string, oldPrefix: string, newPrefix: string): void {
  const db = getDb()
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB 'work_item_[a-z]*_drafts'").all() as { name: string }[]
  for (const { name } of tables) {
    if (!/^work_item_[a-z]+_drafts$/.test(name)) continue
    db.prepare(`UPDATE ${name} SET doc = replace(doc, ?, ?) WHERE work_item_id = ? AND instr(doc, ?) > 0`).run(oldPrefix, newPrefix, itemId, oldPrefix)
    const steps = name.replace(/_drafts$/, '_steps')
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(steps)) {
      db.prepare(`UPDATE ${steps} SET patch = replace(patch, ?, ?) WHERE work_item_id = ? AND instr(patch, ?) > 0`).run(oldPrefix, newPrefix, itemId, oldPrefix)
    }
  }
}

/**
 * The saved versions' JSON files get the same path swap. Best effort per file. Wherever the file sits: a
 * deck's moved with the folder, but a drawing (.canvas.json) is saved in the project folder while its
 * pictures live in the item's folder (#491) -- skipping it left every saved version with a dead picture.
 */
function moveVersionFilePaths(itemId: string, oldPrefix: string, newPrefix: string): void {
  const db = getDb()
  const seen = new Set<string>()
  for (const v of db.prepare('SELECT source_path FROM work_item_versions WHERE work_item_id = ?').all(itemId) as { source_path?: string | null }[]) {
    const rel = v.source_path
    if (!rel || seen.has(rel) || !/\.json$/i.test(rel)) continue
    seen.add(rel)
    try {
      const abs = resolveLifePath(rel)
      if (!abs) continue
      const text = readFileSync(abs, 'utf8')
      if (text.includes(oldPrefix)) writeFileSync(abs, text.split(oldPrefix).join(newPrefix))
    } catch { /* an unreadable or vanished version file: the rename itself already succeeded */ }
  }
}

function moveDocModelPaths(item: WorkItemRow, projectId: string, oldProj: string, newProj: string, swapDepot: (p: string | null) => string | null): void {
  const db = getDb()
  const has = (t: string): boolean => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t)
  const swap = (p: string): string => (p.startsWith(oldProj) ? newProj + p.slice(oldProj.length) : p)
  if (has('wb_doc_sources') && has('wb_doc_claims')) {
    const rows = db.prepare(`SELECT s.id, s.path FROM wb_doc_sources s JOIN wb_doc_claims c ON c.id = s.claim_id
      JOIN work_items w ON w.id = c.work_item_id WHERE w.project_id = ? AND s.path IS NOT NULL`).all(projectId) as { id: string; path: string }[]
    for (const r of rows) if (r.path.startsWith(oldProj)) db.prepare('UPDATE wb_doc_sources SET path = ? WHERE id = ?').run(swap(r.path), r.id)
  }
  if (has('wb_doc_annexes')) {
    const rows = db.prepare(`SELECT a.id, a.path FROM wb_doc_annexes a JOIN work_items w ON w.id = a.work_item_id WHERE w.project_id = ?`).all(projectId) as { id: string; path: string }[]
    for (const r of rows) if (r.path.startsWith(oldProj)) db.prepare('UPDATE wb_doc_annexes SET path = ? WHERE id = ?').run(swap(r.path), r.id)
  }
  for (const v of db.prepare("SELECT id, metadata_json FROM work_item_versions WHERE work_item_id = ? AND metadata_json LIKE '%\"pdf_path\"%'").all(item.id) as { id: string; metadata_json: string }[]) {
    try {
      const m = JSON.parse(v.metadata_json) as Record<string, unknown>
      if (typeof m['pdf_path'] !== 'string') continue
      const moved = swapDepot(m['pdf_path'])
      const files = Array.isArray(m['files'])
        ? (m['files'] as Record<string, unknown>[]).map((f) => (f && typeof f['path'] === 'string' ? { ...f, path: swapDepot(f['path']) } : f))
        : m['files']
      if (moved !== m['pdf_path'] || JSON.stringify(files) !== JSON.stringify(m['files'])) {
        db.prepare('UPDATE work_item_versions SET metadata_json = ? WHERE id = ?').run(JSON.stringify({ ...m, pdf_path: moved, ...(files !== undefined ? { files } : {}) }), v.id)
      }
    } catch { /* rossz JSON: nincs mit athelyezni */ }
  }
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


// ---------------------------------------------------------------------------
// #481: folders renamed or moved OUTSIDE Marvin (Explorer, a sync client) are found again by a hidden id
// ---------------------------------------------------------------------------

/** The hidden file inside every folder of the work items box that holds the folder's stable id. */
export const FOLDER_MARKER = '.marveen-id'
const MARKER_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export interface FolderReconcile {
  /** Folders found again under a new place: the registry paths already follow. */
  moved: { from: string; to: string }[]
  /** Folders with a known id that could not be found anywhere under the work items box any more. */
  lost: string[]
}

const reconciledAt = new Map<string, number>()
const lostReported = new Set<string>()
/** At most one disk walk per project in this many ms (the list endpoint calls this on every load). */
export const RECONCILE_MIN_GAP_MS = 4000

/**
 * Pairs the folders of the work items box with the ids the registry knows (by the .marveen-id file, not by
 * path): a folder renamed or moved outside Marvin gets every registry path rewritten to follow it; a folder
 * without an id gets one; a copy of a folder (same id twice) keeps the id on the original and gets a fresh one.
 * A folder that cannot be found any more is reported once per process (`lost`) but its row is KEPT (the disk may be unmounted); forgetLostFolder() drops it after the owner confirms. Never deletes or moves anything on disk.
 */
export function reconcileFolderMarkers(project: ProjectRow, opts: { force?: boolean } = {}): FolderReconcile {
  const out: FolderReconcile = { moved: [], lost: [] }
  ensureAssetTables()
  const box = findWorkItemsBox(project)
  if (!box) return out
  const t = projectFileTarget(project, box)
  if (!t.ok) return out
  const last = reconciledAt.get(project.id) ?? 0
  if (!opts.force && Date.now() - last < RECONCILE_MIN_GAP_MS) return out
  reconciledAt.set(project.id, Date.now())

  type Dir = { rel: string; abs: string; id: string | null }
  const dirs: Dir[] = []
  const walk = (abs: string, rel: string, depth: number): void => {
    if (depth > WORK_FOLDER_MAX_DEPTH || dirs.length >= WORK_FOLDER_MAX) return
    let entries: import('node:fs').Dirent[]
    try { entries = readdirSync(abs, { withFileTypes: true }) } catch { return }
    for (const d of entries) {
      if (!d.isDirectory() || d.name.startsWith('.') || d.name === 'node_modules') continue
      const cAbs = join(abs, d.name)
      if (existsSync(join(cAbs, '.git'))) continue
      let id: string | null = null
      try { const v = readFileSync(join(cAbs, FOLDER_MARKER), 'utf8').trim(); if (MARKER_RE.test(v)) id = v } catch { /* no marker yet */ }
      const cRel = `${rel}/${d.name}`
      dirs.push({ rel: cRel, abs: cAbs, id })
      walk(cAbs, cRel, depth + 1)
    }
  }
  walk(t.dirAbs, box, 1)

  const db = getDb()
  const lifeRel = (rel: string): string => `${t.dirRel}${rel.slice(box.length)}`
  const byId = new Map<string, Dir[]>()
  for (const d of dirs) if (d.id) byId.set(d.id, [...(byId.get(d.id) ?? []), d])
  const stamp = (d: Dir, id: string): boolean => {
    try { writeFileSync(join(d.abs, FOLDER_MARKER), id + '\n', 'utf8'); d.id = id; return true } catch { return false }
  }
  const rows = db.prepare('SELECT id, path FROM work_folder_ids WHERE project_id = ?').all(project.id) as { id: string; path: string }[]
  const setPath = db.prepare('UPDATE work_folder_ids SET path = ? WHERE project_id = ? AND id = ?')
  for (const r of rows) {
    const cands = byId.get(r.id) ?? []
    if (cands.some((d) => d.rel === r.path)) { lostReported.delete(`${project.id}:${r.id}`); continue }
    if (cands.length === 1) {
      lostReported.delete(`${project.id}:${r.id}`)
      const to = cands[0].rel
      try { rewriteFolderRefs(project, r.path, to, lifeRel(r.path) + '/', lifeRel(to) + '/') } catch { continue }
      setPath.run(to, project.id, r.id)
      out.moved.push({ from: r.path, to })
    } else if (cands.length === 0) {
      const here = dirs.find((d) => d.rel === r.path)
      if (here && !here.id) { stamp(here, r.id); continue } // the marker was deleted, the folder is still there
      if (here) continue
      // Boss (TG 2450): a folder he deleted must simply be gone from the registry, no questions asked.
      // The box itself was reached above (`t.ok`), so the disk is mounted and a missing folder is a deleted one;
      // forgetLostFolder() still refuses when the folder is on disk after all (e.g. beyond the walk cap).
      forgetLostFolder(project, r.path)
    }
    // more than one candidate and none at the known path: ambiguous, left for the next look
  }
  const known = new Map((db.prepare('SELECT id, path FROM work_folder_ids WHERE project_id = ?').all(project.id) as { id: string; path: string }[]).map((r) => [r.id, r.path]))
  const put = db.prepare('INSERT OR REPLACE INTO work_folder_ids (project_id, id, path) VALUES (?, ?, ?)')
  for (const d of dirs) {
    const dup = d.id !== null && known.has(d.id) && known.get(d.id) !== d.rel
    if (d.id && !dup) {
      if (!known.has(d.id)) put.run(project.id, d.id, d.rel)
      continue
    }
    const fresh = randomUUID()
    if (stamp(d, fresh)) put.run(project.id, fresh, d.rel)
  }
  return out
}

/** Test hook: forget the throttle. */
export function resetFolderReconcileThrottleForTests(): void { reconciledAt.clear() }

/**
 * The owner confirmed that a lost folder is really gone: drop its id row. Refuses (false) when the folder is
 * there after all, so a confirmation given for an unmounted disk can never forget a live folder.
 */
export function forgetLostFolder(project: ProjectRow, path: string): boolean {
  ensureAssetTables()
  const box = findWorkItemsBox(project)
  const t = box ? projectFileTarget(project, box) : null
  if (!box || !t || !t.ok) return false // the box itself is unreachable: that is "not looked", not "gone"
  const rel = path.startsWith(box + '/') ? path.slice(box.length + 1) : null
  if (rel === null || rel.includes('..')) return false
  if (existsSync(join(t.dirAbs, ...rel.split('/')))) return false
  const r = getDb().prepare('DELETE FROM work_folder_ids WHERE project_id = ? AND path = ?').run(project.id, path)
  return r.changes > 0
}
