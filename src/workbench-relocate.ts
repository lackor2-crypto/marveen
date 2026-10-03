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
//   3. The file turns up in its home project AND in exactly one other project (a copy, which the owner
//      means as a move) -> the old home registration file is removed FIRST, then the item is re-homed. If
//      that removal fails nothing is re-homed (no bounce back). Two or more other projects -> ambiguous,
//      nothing is re-homed and the owner is asked to keep only one.
//
// A rename/move INSIDE one project is normally followed by the folder ids of workbench-assets.ts
// (reconcileFolderMarkers, .marveen-id). This reconciler additionally SELF-HEALS stale pointers that
// predate those ids (healHome): the physical place of marveen-item.json is the truth for the item's folder.
//
// The physical location is the source of truth: the folder that holds the file decides which project the
// item belongs to. The walk is async and yields between directories -- the depot can live on a slow mount
// (/mnt/f), and a synchronous walk here would freeze the whole dashboard (see life-tree-scan-must-be-async).

import { readFile, readdir, unlink, stat } from 'node:fs/promises'
import { basename, dirname, join, relative, sep } from 'node:path'
import { getDb } from './db.js'
import { logger } from './logger.js'
import { getProject, listProjects, type ProjectRow } from './projects.js'
import { projectFileTarget } from './project-files.js'
import { explorerRoot, resolveLifePath, toLifeRel } from './life-explorer.js'
import { rehomeWorkItem, reconcileFolderMarkers } from './workbench-assets.js'
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
let lastRun: { at: number; rehomed: number; healed: number; neutral: number; duplicates: number; ms: number } | null = null
export function relocateStatus(): typeof lastRun { return lastRun }

type Found = { file: string; itemId: string; effectiveDir: string }

async function rehome(item: WorkItemRow, dir: ProjDir, effectiveDir: string): Promise<boolean> {
  const projTarget = projectFileTarget(dir.project, '')
  if (!projTarget.ok) return false
  let folderRel: string | null = relative(projTarget.dirAbs, effectiveDir).split(sep).join('/')
  if (folderRel === '' || folderRel === '.') folderRel = null
  if (folderRel && folderRel.startsWith('..')) return false // defensive: never escape the project folder
  const fromProject = getProject(item.project_id)
  if (!fromProject) return false
  try {
    rehomeWorkItem(item, fromProject, dir.project, folderRel)
  } catch (err) {
    logger.warn({ err, item: item.id }, 'workbench-relocate: re-home failed, nothing changed')
    return false
  }
  logger.info({ item: item.id, from: item.project_id, to: dir.project.id, folder: folderRel }, 'workbench-relocate: re-homed work item to the project its file now sits in')
  await notifyChannel(ol(
    `Áthelyeztem a(z) ${itemLabel(item)} munkadarabot a(z) "${dir.project.name}" projekt alá: a nyilvántartó fájlját (marveen-item.json) oda tetted, így a munkadarab is odakerült.`,
    `Moved the work item ${itemLabel(item)} under the "${dir.project.name}" project: you put its registration file (marveen-item.json) there, so the work item followed.`,
  ))
  return true
}

/** True when a path exists on disk (any kind). */
async function exists(abs: string): Promise<boolean> {
  try { await stat(abs); return true } catch { return false }
}

/**
 * Self-heal for an item whose single registration file sits in its home project (#481). Two stale-pointer
 * classes, both DB-only fixes (no file is moved or deleted, nothing is written unless the target exists):
 *  1. The item's folder was renamed/moved inside the project before folder ids existed: the recorded
 *     work_items.folder no longer exists on disk but the file sits somewhere else -> follow it, with every
 *     registry path (same full rewrite as a cross-project move, project unchanged).
 *  2. A source_path (item or version) points at a missing file, and the item's real folder holds EXACTLY ONE
 *     file with that base name -> point there. Zero or several matches: left alone, never guessed.
 * Idempotent: when everything already matches the disk, nothing is written.
 */
async function healHome(item: WorkItemRow, dir: ProjDir, effectiveDir: string): Promise<number> {
  let changed = 0
  let cur = item
  const actual = relative(dir.abs, effectiveDir).split(sep).join('/')
  const actualRel: string | null = actual === '' || actual === '.' ? null : actual
  if (actualRel && actualRel.startsWith('..')) return 0
  if (cur.folder && cur.folder !== actualRel && actualRel && !(await exists(join(dir.abs, ...cur.folder.split('/'))))) {
    try {
      rehomeWorkItem(cur, dir.project, dir.project, actualRel)
      cur = getDb().prepare('SELECT * FROM work_items WHERE id = ?').get(item.id) as WorkItemRow
      logger.info({ item: item.id, to: actualRel }, 'workbench-relocate: followed a pre-id folder move inside the project')
      changed++
    } catch (err) { logger.warn({ err, item: item.id }, 'workbench-relocate: in-project folder follow failed, nothing changed') }
  }
  // 2) source_path self-heal. Candidates: direct children of the item's real folder.
  let names: string[] | null = null
  const candidate = async (src: string | null): Promise<string | null> => {
    if (!src) return null
    const abs = resolveLifePath(src)
    if (!abs || await exists(abs)) return null // resolves and exists (or unresolvable): nothing to heal
    const base = basename(src)
    if (names === null) {
      try { names = (await readdir(effectiveDir, { withFileTypes: true })).filter((e) => e.isFile()).map((e) => e.name) } catch { names = [] }
    }
    const same = names.filter((n) => n === base)
    if (same.length !== 1) return null
    const target = join(effectiveDir, same[0])
    const rel = toLifeRel(target)
    if (!rel || rel === src || !(await exists(target))) return null
    return rel
  }
  const db = getDb()
  const fixed = await candidate(cur.source_path ?? null)
  if (fixed) { db.prepare('UPDATE work_items SET source_path = ?, updated_at = ? WHERE id = ?').run(fixed, nowSec(), cur.id); changed++ }
  for (const v of db.prepare('SELECT id, source_path FROM work_item_versions WHERE work_item_id = ?').all(cur.id) as { id: string; source_path: string | null }[]) {
    const f = await candidate(v.source_path)
    if (f) { db.prepare('UPDATE work_item_versions SET source_path = ? WHERE id = ?').run(f, v.id); changed++ }
  }
  if (changed) logger.info({ item: item.id, changed }, 'workbench-relocate: healed stale pointers')
  return changed
}

async function warnNeutral(item: WorkItemRow, depot: string, neutralDir: string, home: ProjectRow | undefined): Promise<void> {
  const rel = relative(depot, neutralDir).split(sep).join('/') || neutralDir
  const homeName = home?.name ?? ol('a projektje', 'its project')
  await notifyChannel(ol(
    `Rossz helyre került egy munkadarab fájlja. A(z) ${itemLabel(item)} nyilvántartó fájlja (marveen-item.json) ide került: "${rel}" -- ez nem egy projekt mappája, így nem vittem át a munkadarabot sehová, a helyén maradt ("${homeName}"). Tedd vissza, vagy rakd egy projekt mappa alá, és akkor magától átkerül.`,
    `A work item's file landed in the wrong place. The registration file (marveen-item.json) of ${itemLabel(item)} is now in "${rel}" -- that is not a project folder, so I did not move the work item anywhere; it stayed in "${homeName}". Put it back, or drop it into a project folder and it will move on its own.`,
  ))
}

async function warnLost(project: ProjectRow, paths: string[]): Promise<void> {
  await notifyChannel(ol(
    `Nem találom ezeket a mappákat a(z) "${project.name}" projektben: ${paths.join(', ')}. Nem töröltem semmit a nyilvántartásból (lehet, hogy csak le van csatolva a tároló). Ha tényleg törölted őket, szólj, és kivezetem a nyilvántartásból.`,
    `I cannot find these folders in the "${project.name}" project: ${paths.join(', ')}. I deleted nothing from the registry (the storage may just be unmounted). If you really deleted them, tell me and I will drop them from the registry.`,
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
  let neutral = 0
  let healed = 0
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
      const others = placements.filter((p) => p.proj && p.proj.project.id !== item.project_id)
      const homes = placements.filter((p) => p.proj && p.proj.project.id === item.project_id)
      const otherIds = new Set(others.map((p) => p.proj!.project.id))

      if (otherIds.size > 1) {
        const places = others.map((p) => p.proj!.project.name)
        const key = `${itemId}@${[...otherIds].sort().join('|')}`
        seenDuplicate.add(key)
        if (!warnedDuplicate.has(key)) { await warnDuplicate(item, places); warnedDuplicate.add(key); duplicates++ }
        continue
      }

      if (otherIds.size === 1) {
        // A copy into one other project is a move: drop the old home registration file(s) first, so the
        // next pass cannot see two places; if that fails, do not re-home at all.
        let cleaned = true
        for (const h of homes) {
          try { await unlink(h.file) } catch (err) {
            if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') { cleaned = false; logger.warn({ err, file: h.file }, 'workbench-relocate: could not remove the old home registration file, not re-homing') }
          }
        }
        if (!cleaned) continue
        const target = others[0]
        if (await rehome(item, target.proj!, target.effectiveDir)) rehomed++
        continue
      }

      if (homes.length === 1 && placements.length === 1) {
        healed += await healHome(item, homes[0].proj!, homes[0].effectiveDir)
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
    // Folders with a known id that vanished from the disk: ask the owner, never forget them on our own.
    for (const p of listProjects({ includeArchived: false })) {
      let lost: string[] = []
      try { lost = reconcileFolderMarkers(p).lost } catch { continue }
      if (lost.length) await warnLost(p, lost)
    }
    lastRun = { at: Date.now(), rehomed, healed, neutral, duplicates, ms: Date.now() - t0 }
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
