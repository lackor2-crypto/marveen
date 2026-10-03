// #481: a work item's registration file (marveen-item.json) is the one thing that travels with its
// folder when the owner moves it in the file manager (Windows Explorer over the WSL mount, or the
// Intezo). This reconciler reads WHERE each registration file physically sits and reacts, so the owner
// never has to open a terminal or ask an agent to "fix" a move:
//
//   1. The file now sits in a DIFFERENT project's folder  -> the work item is re-homed to that project
//      automatically (project_id + folder updated), and a short Telegram note tells the owner it happened.
//   2. The file was dropped into a NON-project (neutral) folder, e.g. "Korpas Laszlo media/Fotok" -> the
//      work item is LEFT where it is in the database (never silently moved into a non-project place), and
//      a Telegram message asks the owner to put the file back or into a project folder.
//   3. The same file turns up in two different project folders (a copy, not a move) -> ambiguous, so
//      nothing is re-homed and the owner is asked to keep only one.
//
// The physical location is the source of truth: the folder that holds the file decides which project the
// item belongs to. The walk is async and yields between directories -- the depot can live on a slow mount
// (/mnt/f), and a synchronous walk here would freeze the whole dashboard (see life-tree-scan-must-be-async).

import { readFile, readdir } from 'node:fs/promises'
import { basename, dirname, join, relative, sep } from 'node:path'
import { getDb } from './db.js'
import { logger } from './logger.js'
import { listProjects, type ProjectRow } from './projects.js'
import { projectFileTarget } from './project-files.js'
import { explorerRoot } from './life-explorer.js'
import { ensureWorkbenchTables, type WorkItemRow } from './workbench.js'
import { SNAPSHOT_FALLBACK_DIR, SNAPSHOT_FILE, SNAPSHOT_FORMAT } from './workbench-snapshot.js'
import { notifyChannel } from './notify.js'
import { ol } from './owner-lang.js'

const WALK_MAX_DEPTH = 12
const WALK_MAX_DIRS = 20_000
export const RELOCATE_MS = 300_000 // every 5 minutes: moves are rare and owner-initiated

const nowSec = (): number => Math.floor(Date.now() / 1000)

/** Owner-visible work item number, e.g. "28M" (M = munkadarab), as the Workbench shows it. */
function itemLabel(item: WorkItemRow): string {
  return item.seq != null ? `#${item.seq}M "${item.title}"` : `"${item.title}"`
}

interface ProjDir { project: ProjectRow; abs: string }

/** Every project's absolute folder, longest path first so the most specific (nested) project wins. */
function projectDirs(): ProjDir[] {
  const out: ProjDir[] = []
  for (const p of listProjects({ includeArchived: true })) {
    const t = projectFileTarget(p, '')
    if (t.ok) out.push({ project: p, abs: t.dirAbs })
  }
  out.sort((a, b) => b.abs.length - a.abs.length)
  return out
}

/** The project whose folder physically contains `dirAbs`, or null when it sits outside every project. */
function matchProject(dirAbs: string, dirs: ProjDir[]): ProjDir | null {
  for (const d of dirs) if (dirAbs === d.abs || dirAbs.startsWith(d.abs + sep)) return d
  return null
}

/** Async depot walk that yields between directories; returns every registration-file path found. */
async function findSnapshotFiles(root: string): Promise<string[]> {
  const found: string[] = []
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
      } else if (e.isFile()) {
        if (e.name === SNAPSHOT_FILE || (e.name.endsWith('.json') && basename(dir) === SNAPSHOT_FALLBACK_DIR)) {
          found.push(join(dir, e.name))
        }
      }
    }
    await new Promise<void>((r) => setImmediate(r))
  }
  await go(root, 0)
  return found
}

// A warning is sent once per (item, place) for the life of the process; it is dropped again the moment
// the misplacement is gone, so a still-unresolved one is raised afresh after a restart but never spammed.
const warnedNeutral = new Set<string>()
const warnedDuplicate = new Set<string>()

let running = false
let lastRun: { at: number; rehomed: number; renamed: number; neutral: number; duplicates: number; ms: number } | null = null
export function relocateStatus(): typeof lastRun { return lastRun }

type Found = { file: string; itemId: string; effectiveDir: string }

/** The item's own folder, project-relative with forward slashes, or null when the file sits in the project root. */
function folderRelOf(projDirAbs: string, effectiveDir: string): string | null {
  const rel = relative(projDirAbs, effectiveDir).split(sep).join('/')
  return rel === '' || rel === '.' ? null : rel
}

async function rehome(item: WorkItemRow, dir: ProjDir, effectiveDir: string): Promise<void> {
  const projTarget = projectFileTarget(dir.project, '')
  if (!projTarget.ok) return
  let folderRel: string | null = relative(projTarget.dirAbs, effectiveDir).split(sep).join('/')
  if (folderRel === '' || folderRel === '.') folderRel = null
  if (folderRel && folderRel.startsWith('..')) return // defensive: never escape the project folder
  const from = item.project_id
  getDb().prepare('UPDATE work_items SET project_id = ?, folder = ?, updated_at = ? WHERE id = ?')
    .run(dir.project.id, folderRel, nowSec(), item.id)
  logger.info({ item: item.id, from, to: dir.project.id, folder: folderRel }, 'workbench-relocate: re-homed work item to the project its file now sits in')
  await notifyChannel(ol(
    `Áthelyeztem a(z) ${itemLabel(item)} munkadarabot a(z) "${dir.project.name}" projekt alá: a nyilvántartó fájlját (marveen-item.json) oda tetted, így a munkadarab is odakerült.`,
    `Moved the work item ${itemLabel(item)} under the "${dir.project.name}" project: you put its registration file (marveen-item.json) there, so the work item followed.`,
  ))
}

async function warnNeutral(item: WorkItemRow, depot: string, neutralDir: string, home: ProjectRow | undefined): Promise<void> {
  const rel = relative(depot, neutralDir).split(sep).join('/') || neutralDir
  const homeName = home?.name ?? ol('a projektje', 'its project')
  await notifyChannel(ol(
    `Rossz helyre került egy munkadarab fájlja. A(z) ${itemLabel(item)} nyilvántartó fájlja (marveen-item.json) ide került: "${rel}" -- ez nem egy projekt mappája, így nem vittem át a munkadarabot sehová, a helyén maradt ("${homeName}"). Tedd vissza, vagy rakd egy projekt mappa alá, és akkor magától átkerül.`,
    `A work item's file landed in the wrong place. The registration file (marveen-item.json) of ${itemLabel(item)} is now in "${rel}" -- that is not a project folder, so I did not move the work item anywhere; it stayed in "${homeName}". Put it back, or drop it into a project folder and it will move on its own.`,
  ))
}

async function warnDuplicate(item: WorkItemRow, places: string[]): Promise<void> {
  await notifyChannel(ol(
    `Ugyanannak a munkadarabnak a fájlja több projekt mappájában is megjelent: ${itemLabel(item)}. Helyek: ${places.join(', ')}. Nem vittem át egyiket sem (nem lehet tudni, melyik az igazi). Hagyj meg csak egyet.`,
    `The same work item's file turned up in more than one project folder: ${itemLabel(item)}. Places: ${places.join(', ')}. I moved nothing (there is no telling which is the real one). Please keep only one.`,
  ))
}

/** One pass: read where every registration file sits and re-home / warn as needed. Safe to call often. */
export async function reconcileItemLocations(): Promise<void> {
  if (running) return
  const depot = explorerRoot()
  if (!depot) return
  running = true
  const t0 = Date.now()
  let rehomed = 0
  let renamed = 0
  let neutral = 0
  let duplicates = 0
  try {
    ensureWorkbenchTables()
    const dirs = projectDirs()
    if (!dirs.length) return // no project folders yet -> nothing to compare a file's place against
    const files = await findSnapshotFiles(depot)
    const founds: Found[] = []
    for (const file of files) {
      let snap: { format?: number; tombstone?: boolean; id?: unknown; item?: { id?: unknown } } | null = null
      try { snap = JSON.parse(await readFile(file, 'utf8')) } catch { continue }
      if (!snap || snap.format !== SNAPSHOT_FORMAT || snap.tombstone) continue
      const itemId = snap.id ?? snap.item?.id
      if (!itemId) continue
      const d = dirname(file)
      const effectiveDir = basename(d) === SNAPSHOT_FALLBACK_DIR ? dirname(d) : d
      founds.push({ file, itemId: String(itemId), effectiveDir })
    }
    const byId = new Map<string, Found[]>()
    for (const f of founds) (byId.get(f.itemId) ?? byId.set(f.itemId, []).get(f.itemId)!).push(f)

    const db = getDb()
    const seenNeutral = new Set<string>()
    const seenDuplicate = new Set<string>()
    for (const [itemId, group] of byId) {
      const item = db.prepare('SELECT * FROM work_items WHERE id = ?').get(itemId) as WorkItemRow | undefined
      if (!item || item.deleted_at) continue // missing -> restoreFromFolders rebuilds; trashed -> leave it
      const placements = group.map((g) => ({ ...g, proj: matchProject(g.effectiveDir, dirs) }))
      const projectIds = new Set(placements.filter((p) => p.proj).map((p) => p.proj!.project.id))

      if (projectIds.size > 1) {
        const places = placements.filter((p) => p.proj).map((p) => p.proj!.project.name)
        const key = `${itemId}@${[...projectIds].sort().join('|')}`
        seenDuplicate.add(key)
        if (!warnedDuplicate.has(key)) { await warnDuplicate(item, places); warnedDuplicate.add(key); duplicates++ }
        continue
      }

      const inProject = placements.find((p) => p.proj)
      if (inProject && inProject.proj!.project.id !== item.project_id) {
        await rehome(item, inProject.proj!, inProject.effectiveDir)
        rehomed++
        continue
      }

      // Same project, single file: the owner renamed/moved the item's folder from outside -- follow the
      // folder silently (no Telegram; it never left its project). Only with one file, so a stray second
      // copy never makes us guess the wrong folder.
      if (inProject && placements.length === 1 && inProject.proj!.project.id === item.project_id) {
        const newFolder = folderRelOf(inProject.proj!.abs, inProject.effectiveDir)
        const cur = item.folder ?? null
        if (newFolder !== cur && !(newFolder && newFolder.startsWith('..'))) {
          getDb().prepare('UPDATE work_items SET folder = ?, updated_at = ? WHERE id = ?').run(newFolder, nowSec(), item.id)
          logger.info({ item: item.id, from: cur, to: newFolder }, 'workbench-relocate: followed an external folder rename within the same project')
          renamed++
        }
        continue
      }

      for (const n of placements) {
        if (n.proj) continue // this copy is in a project folder (its home) -> fine
        const key = `${itemId}@${n.effectiveDir}`
        seenNeutral.add(key)
        if (!warnedNeutral.has(key)) {
          await warnNeutral(item, depot, n.effectiveDir, dirs.find((d) => d.project.id === item.project_id)?.project)
          warnedNeutral.add(key)
          neutral++
        }
      }
    }
    // Forget warnings whose misplacement is gone, so a recurrence is raised again (but never every pass).
    for (const k of [...warnedNeutral]) if (!seenNeutral.has(k)) warnedNeutral.delete(k)
    for (const k of [...warnedDuplicate]) if (!seenDuplicate.has(k)) warnedDuplicate.delete(k)
    lastRun = { at: Date.now(), rehomed, renamed, neutral, duplicates, ms: Date.now() - t0 }
  } catch (err) {
    logger.warn({ err }, 'workbench-relocate: reconcile failed')
  } finally {
    running = false
  }
}

// ---------------------------------------------------------------------------
// Lifecycle (one call from index.ts)
// ---------------------------------------------------------------------------

let timer: ReturnType<typeof setInterval> | null = null
let startTimer: ReturnType<typeof setTimeout> | null = null

export function startWorkbenchRelocate(): void {
  if (timer) return
  // After the snapshot startup rebuild (20s) has had a moment, run once, then on the slow cadence.
  startTimer = setTimeout(() => { void reconcileItemLocations() }, 45_000)
  startTimer.unref()
  timer = setInterval(() => { void reconcileItemLocations() }, RELOCATE_MS)
  timer.unref()
}

export function stopWorkbenchRelocate(): void {
  if (startTimer) { clearTimeout(startTimer); startTimer = null }
  if (timer) { clearInterval(timer); timer = null }
}
