// A FOLDER RENAMED OUTSIDE MARVEEN IS FOUND AGAIN BY A HIDDEN ID (#510).
//
// Boss, TG 2490: "a letrehozott mappak kapjanak stabil azonositot, es a
// rendszer azt figyelje". A rename done IN the Intezo is followed by
// life-follow.ts. A rename done in the Windows Explorer (or by a sync client)
// is invisible to us: every registry keeps the old path, and the link, the
// backup rule and the project's Files tab point at nothing.
//
// So every folder that a registry knows by path -- an ANCHORED folder -- gets
// the same hidden `.marveen-id` file the Workbench already uses (#481). When
// the registered path is gone, the folder carrying that id is looked for, and
// the registries follow it there.
//
// What this deliberately does NOT do:
//   - it does not stamp every folder of the tree, only anchored ones (the tree
//     must not fill up with marker files);
//   - it writes nothing into a git repository or through a link;
//   - it never deletes or moves anything in the tree except its own marker;
//   - a folder that cannot be found is REPORTED and its record kept: the disk
//     may be unmounted, and "not found" is not "deleted".
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { STORE_DIR } from './config.js'
import { depotRoot } from './depot.js'
import { logger } from './logger.js'
import { listMounts, resolveMount } from './life-mounts.js'
import { loadBackupRules } from './backup-rules.js'
import { writeBlockReason } from './git-guard.js'
import { trashRelPath, legacyTrashRelPath } from './life-tree.js'
import { followFolderMove } from './life-follow.js'
import { movePhysical } from './life-documents.js'
import { moveDisplayLabels } from './life-labels.js'
import { moveArchivedPrefix } from './life-archived.js'

/** Same file name and format as the Workbench folder ids (workbench-assets.ts). */
export const LIFE_FOLDER_MARKER = '.marveen-id'
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const WALK_MAX_DEPTH = 10
const WALK_MAX_DIRS = 30_000
export const LIFE_FOLDER_IDS_MS = 600_000 // every 10 minutes: outside renames are rare

/** `own`: WE wrote the marker. An id adopted from a marker that was already there (a Workbench folder id) is not ours to remove. */
interface Rec { id: string; rel: string; own?: boolean }
type Store = { folders: Rec[] }

let fileOverride: string | null = null
/** Test-only: where the id registry lives. */
export function setLifeFolderIdsFileForTests(p: string | null): void { fileOverride = p }
const storePath = (): string => fileOverride ?? join(STORE_DIR, 'life-folder-ids.json')

const norm = (rel: string): string => String(rel || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')

/** `null` = the file is there but unreadable: do nothing rather than forget every id. */
function load(): Store | null {
  try {
    if (!existsSync(storePath())) return { folders: [] }
    const raw = JSON.parse(readFileSync(storePath(), 'utf8'))
    if (!raw || !Array.isArray(raw.folders)) return null
    return { folders: raw.folders.filter((r: any) => r && ID_RE.test(String(r.id)) && typeof r.rel === 'string').map((r: any) => ({ id: String(r.id), rel: norm(r.rel), ...(r.own ? { own: true } : {}) })) }
  } catch { return null }
}

function save(store: Store): void {
  const f = storePath()
  mkdirSync(join(f, '..'), { recursive: true })
  const tmp = f + '.tmp'
  const sorted = [...store.folders].sort((a, b) => a.rel.localeCompare(b.rel))
  writeFileSync(tmp, JSON.stringify({ version: 1, folders: sorted }, null, 2) + '\n', 'utf8')
  renameSync(tmp, f)
}

/** The registered folders with their ids (for the UI and for other modules). */
export function listLifeFolderIds(): Rec[] {
  return (load()?.folders ?? []).map((r) => ({ ...r }))
}

/**
 * The folders some registry knows BY PATH: a backup rule, a project's folder,
 * a Drive backup pair, the target of a link. Left out: the depot root, a place
 * that shows through a link, and anything inside a git repository (a marker
 * there would be an untracked file in somebody's working tree).
 */
export async function anchoredFolders(): Promise<string[]> {
  const out = new Set<string>()
  const add = (rel: unknown): void => {
    const r = norm(String(rel ?? ''))
    if (!r) return
    if (resolveMount(r)) return
    try { if (writeBlockReason(r)) return } catch { return }
    out.add(r)
  }
  for (const r of loadBackupRules().rules) add(r.path)
  for (const m of listMounts()) add(m.target)
  try {
    const { listProjects } = await import('./projects.js')
    for (const p of listProjects({ includeArchived: true })) add(p.folder_path)
  } catch { /* no database (a bare tool run): the other registries still count */ }
  try {
    const { loadSyncConfig } = await import('./web/routes/drive-sync.js')
    for (const p of loadSyncConfig().pairs) if (p.backup) add(p.localPath)
  } catch { /* the sync module could not be loaded: skip its pairs this round */ }
  return [...out]
}

async function isDir(abs: string): Promise<boolean> {
  try { return (await stat(abs)).isDirectory() } catch { return false }
}

async function readMarker(dirAbs: string): Promise<string | null> {
  try {
    const v = (await readFile(join(dirAbs, LIFE_FOLDER_MARKER), 'utf8')).trim()
    return ID_RE.test(v) ? v : null
  } catch { return null }
}

async function stamp(dirAbs: string, id: string): Promise<boolean> {
  try { await writeFile(join(dirAbs, LIFE_FOLDER_MARKER), id + '\n', 'utf8'); return true } catch { return false }
}

/**
 * Look for folders by their marker. One async walk for all wanted ids, with a
 * yield between directories: the depot can sit on a slow mount, and a
 * synchronous walk would freeze the dashboard (see life-tree-scan-must-be-async).
 * Not entered: hidden folders, node_modules, git repositories, the Trash, and
 * places that are links.
 */
async function findByMarker(root: string, wanted: Set<string>, startRels: string[]): Promise<Map<string, string[]>> {
  const found = new Map<string, string[]>()
  const skip = new Set<string>([norm(trashRelPath()), norm(legacyTrashRelPath())])
  for (const m of listMounts()) skip.add(m.rel)
  const seen = new Set<string>()
  let dirs = 0
  const walk = async (rel: string, depth: number): Promise<void> => {
    if (depth > WALK_MAX_DEPTH || dirs >= WALK_MAX_DIRS || seen.has(rel)) return
    seen.add(rel)
    let entries: import('node:fs').Dirent[]
    try { entries = await readdir(rel ? join(root, ...rel.split('/')) : root, { withFileTypes: true }) } catch { return }
    if (++dirs % 64 === 0) await new Promise<void>((r) => setImmediate(r))
    if (entries.some((e) => e.name === '.git')) return
    if (rel && entries.some((e) => e.name === LIFE_FOLDER_MARKER)) {
      const id = await readMarker(join(root, ...rel.split('/')))
      if (id && wanted.has(id) && !(found.get(id) ?? []).includes(rel)) found.set(id, [...(found.get(id) ?? []), rel])
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue
      const child = rel ? `${rel}/${e.name}` : e.name
      if (skip.has(child)) continue
      await walk(child, depth + 1)
    }
  }
  // Nearest first: an outside rename almost always keeps the folder beside
  // where it was, so the parent is read before the whole tree.
  for (const s of startRels) await walk(s, WALK_MAX_DEPTH - 1)
  if ([...wanted].some((id) => !found.has(id))) { seen.clear(); await walk('', 0) }
  return found
}

export interface LifeFolderIdResult {
  /** Why nothing was done: `no_depot` (not set up), `unreachable` (the disk is not there now), `corrupt` (the id registry cannot be read). */
  skipped?: 'no_depot' | 'unreachable' | 'corrupt'
  stamped: number
  moved: { from: string; to: string }[]
  /** Registered folders that are neither at their path nor anywhere else in the tree. Kept, not forgotten. */
  lost: string[]
  /** More than one folder carries the id (a copy): nothing is followed, the owner has to keep one. */
  ambiguous: string[]
}

let running = false

/**
 * One pass: give every anchored folder an id, and let the registries follow a
 * folder that was renamed or moved outside Marveen.
 */
export async function reconcileLifeFolderIds(): Promise<LifeFolderIdResult> {
  const out: LifeFolderIdResult = { stamped: 0, moved: [], lost: [], ambiguous: [] }
  if (running) return out
  running = true
  try {
    const root = depotRoot()
    if (!root) return { ...out, skipped: 'no_depot' }
    // An unmounted disk makes EVERY folder look gone. That is not a rename.
    if (!(await isDir(root))) return { ...out, skipped: 'unreachable' }
    const store = load()
    if (!store) return { ...out, skipped: 'corrupt' }
    const abs = (rel: string): string => join(root, ...rel.split('/'))
    let dirty = false

    // 1. Folders that are no longer at their registered path.
    const missing: Rec[] = []
    for (const r of store.folders) {
      if (!(await isDir(abs(r.rel)))) { missing.push(r); continue }
      const here = await readMarker(abs(r.rel))
      if (here === r.id) continue
      if (!here) { if (await stamp(abs(r.rel), r.id)) out.stamped++; continue } // the marker was deleted, the folder is still there
      // Another folder was put at this path (it carries its own id): the one we knew is elsewhere.
      missing.push(r)
    }
    if (missing.length) {
      const wanted = new Set(missing.map((r) => r.id))
      const parents = [...new Set(missing.map((r) => (r.rel.includes('/') ? r.rel.slice(0, r.rel.lastIndexOf('/')) : '')))]
      const found = await findByMarker(root, wanted, parents)
      // Outermost first: when a folder and a folder under it both moved, following the parent already carries the child.
      for (const r of [...missing].sort((a, b) => a.rel.length - b.rel.length)) {
        if (await isDir(abs(r.rel)) && (await readMarker(abs(r.rel))) === r.id) continue
        const at = (found.get(r.id) ?? []).filter((x) => x !== r.rel)
        if (at.length === 0) { out.lost.push(r.rel); continue }
        if (at.length > 1) { out.ambiguous.push(r.rel); continue }
        const from = r.rel
        const to = at[0]
        movePhysical(from, to)
        moveDisplayLabels(from, to)
        moveArchivedPrefix(from, to)
        followFolderMove(from, to)
        for (const o of store.folders) {
          if (o.rel === from) o.rel = to
          else if (o.rel.startsWith(from + '/')) o.rel = to + o.rel.slice(from.length)
        }
        dirty = true
        out.moved.push({ from, to })
        logger.info({ from, to }, '[eletfa] a folder renamed outside Marveen was found by its id; the registries follow')
      }
    }

    // 2. Anchors come and go: stamp the new ones, let go of the ones nothing refers to any more.
    const anchors = new Set(await anchoredFolders())
    const lostNow = new Set(out.lost.concat(out.ambiguous))
    const keep: Rec[] = []
    for (const r of store.folders) {
      if (anchors.has(r.rel) || lostNow.has(r.rel)) { keep.push(r); continue }
      // Our own marker, and only if it still says our id.
      if (r.own && (await readMarker(abs(r.rel))) === r.id) { try { await unlink(join(abs(r.rel), LIFE_FOLDER_MARKER)) } catch { /* stays, harmless */ } }
      dirty = true
    }
    const known = new Set(keep.map((r) => r.rel))
    const usedIds = new Set(keep.map((r) => r.id))
    for (const rel of anchors) {
      if (known.has(rel) || !(await isDir(abs(rel)))) continue
      // The root of a git repository: a marker there would be an untracked file in the working tree.
      if (await isDir(join(abs(rel), '.git'))) continue
      let id = await readMarker(abs(rel))
      let own = false
      if (!id || usedIds.has(id)) {
        id = randomUUID()
        if (!(await stamp(abs(rel), id))) continue // a read-only place: try again next round
        out.stamped++
        own = true
      }
      keep.push(own ? { id, rel, own } : { id, rel })
      usedIds.add(id)
      dirty = true
    }
    if (dirty) save({ folders: keep })
    return out
  } catch (err: any) {
    logger.warn({ err: String(err?.message || err) }, '[eletfa] the folder id pass failed, nothing was changed by it')
    return out
  } finally {
    running = false
  }
}

let timer: ReturnType<typeof setInterval> | null = null
let startTimer: ReturnType<typeof setTimeout> | null = null

export function startLifeFolderIds(): void {
  if (timer) return
  startTimer = setTimeout(() => { void reconcileLifeFolderIds() }, 60_000)
  startTimer.unref()
  timer = setInterval(() => { void reconcileLifeFolderIds() }, LIFE_FOLDER_IDS_MS)
  timer.unref()
}

export function stopLifeFolderIds(): void {
  if (startTimer) { clearTimeout(startTimer); startTimer = null }
  if (timer) { clearInterval(timer); timer = null }
}
