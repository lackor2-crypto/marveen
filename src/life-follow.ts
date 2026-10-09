// A FOLDER WAS RENAMED: every registry that knows it by PATH follows it (#510).
//
// Boss, TG 2490: renaming a folder in the Intezo that has a link ("bekotes")
// in it was refused with "remove the link first". The reason was not the
// rename, it was that the registries are keyed by path and nobody moved them:
// only the paper record, the display name and the archived mark followed
// (life-explorer.ts). Left behind: the links (store/life-mounts.json), the
// backup rules (store/backup-rules.json), the projects' folder_path and the
// tree ledger -- so a link pointed at a place that was gone, a rule protected
// a folder that no longer existed, and a project lost its Files tab.
//
// This is the one place that moves them together. It never throws: a registry
// that could not follow is logged and counted as 0, the rename itself already
// happened on disk and must not be reported as failed.
import { lstatSync, mkdirSync, readdirSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { depotRoot } from './depot.js'
import { logger } from './logger.js'
import { listMounts, moveMountsPrefix, moveMountTargetsPrefix } from './life-mounts.js'
import { ensureMountLink, reconcileMountLinks, removeMountLink } from './life-mount-links.js'
import { moveBackupRulesPrefix } from './backup-rules.js'
import { moveProjectFoldersPrefix } from './project-folder-follow.js'
import { moveLifeLedgerPrefix } from './life-tree-ledger.js'
import { movePhysical } from './life-documents.js'
import { moveDisplayLabels } from './life-labels.js'
import { moveArchivedPrefix } from './life-archived.js'
import { safeLifeName } from './life-tree.js'

const norm = (rel: string): string => String(rel || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')

export interface FollowCounts { mounts: number; mountTargets: number; backupRules: number; projects: number; ledger: number }

/**
 * The registries `renameLife` does NOT move itself. Call it after a rename
 * that succeeded on disk.
 */
export function followFolderMove(fromRel: string, toRel: string): FollowCounts {
  const from = norm(fromRel)
  const to = norm(toRel)
  const out: FollowCounts = { mounts: 0, mountTargets: 0, backupRules: 0, projects: 0, ledger: 0 }
  if (!from || !to || from === to) return out
  const step = (name: keyof FollowCounts, fn: () => number): void => {
    try { out[name] = fn() } catch (err: any) {
      logger.warn({ from, to, registry: name, err: String(err?.message || err) }, '[intezo] a registry did not follow the rename')
    }
  }
  step('mounts', () => moveMountsPrefix(from, to))
  // The folder may also be what links POINT AT (a store under Rendszer/...).
  // A git link is a Windows junction holding the OLD absolute target: it must
  // come down while the registry still names that target (that is how we know
  // the junction is ours), then the registry is re-pointed, then the junction
  // is made again -- by the reconcile pass below.
  step('mountTargets', () => {
    for (const m of listMounts()) {
      if (m.kind === 'git' && (m.target === from || m.target.startsWith(from + '/'))) removeMountLink(m)
    }
    return moveMountTargetsPrefix(from, to)
  })
  step('backupRules', () => moveBackupRulesPrefix(from, to))
  step('projects', () => moveProjectFoldersPrefix(from, to))
  const root = depotRoot()
  if (root) step('ledger', () => moveLifeLedgerPrefix(root, from, to))
  // A git link is a Windows junction INSIDE the renamed folder: it moved with
  // it and still points at its (unmoved) target. This only repairs one that
  // is missing -- the same pass the dashboard runs on start.
  if (out.mounts || out.mountTargets) { try { reconcileMountLinks(listMounts()) } catch { /* the start-up pass catches up */ } }
  // The Drive backup pairs keep their local folder as a path too. Their store
  // lives in the Drive-sync route module (moveSyncPairsPrefix, #513/#510); it
  // is loaded lazily so this module does not pull the whole sync engine in,
  // and a build that does not have the export yet simply skips it.
  void import('./web/routes/drive-sync.js')
    .then((m) => {
      const move = (m as { moveSyncPairsPrefix?: (a: string, b: string) => number }).moveSyncPairsPrefix
      const n = typeof move === 'function' ? move(from, to) : 0
      if (n) logger.info({ from, to, pairs: n }, '[intezo] Drive backup pairs followed the rename')
    })
    .catch((err: any) => logger.warn({ from, to, err: String(err?.message || err) }, '[intezo] Drive backup pairs did not follow the rename'))
  if (out.mounts || out.mountTargets || out.backupRules || out.projects) logger.info({ from, to, ...out }, '[intezo] registries followed the rename')
  return out
}

export type MountPointRename =
  | { ok: true; rel: string; name: string }
  | { ok: false; code: 'not_mount' | 'no_depot' | 'bad_name' | 'same' | 'exists' | 'foreign_link' | 'not_empty' | 'no_target' | 'into_link' | 'failed'; detail?: string }

const lst = (p: string) => { try { return lstatSync(p) } catch { return null } }

/**
 * Put a link (mount point) at another place in the tree: the shared core of
 * renaming it and of moving it into another folder.
 *
 * `renameLife` / `moveLife` cannot do this: they resolve a linked path to the
 * link's TARGET, so they would rename or carry off the real store behind it (a
 * whole git repo, a Drive folder). Here only the place where it SHOWS changes;
 * the target is never touched. On disk that place is either an empty
 * placeholder folder, or -- for a git link under Windows -- a junction, which
 * is taken down and put back at the new place.
 */
function relocateMountPoint(from: string, to: string): MountPointRename {
  const mount = listMounts().find((m) => m.rel === from)
  if (!mount) return { ok: false, code: 'not_mount' }
  const root = depotRoot()
  if (!root) return { ok: false, code: 'no_depot' }
  const name = to.slice(to.lastIndexOf('/') + 1)
  if (to === from) return { ok: false, code: 'same' }
  const oldAbs = join(root, ...from.split('/'))
  const newAbs = join(root, ...to.split('/'))
  if (lst(newAbs)) return { ok: false, code: 'exists', detail: name }

  const here = lst(oldAbs)
  try {
    if (here && here.isSymbolicLink()) {
      // Our own junction: take it down, the new one is made below. A link
      // that is not ours is somebody else's -- we do not move it.
      if (removeMountLink(mount).outcome !== 'removed') return { ok: false, code: 'foreign_link' }
      mkdirSync(newAbs, { recursive: true })
    } else if (here && here.isDirectory()) {
      // A placeholder holds nothing of its own. If it does, moving it as a
      // link would hide those files behind the target -- say so instead.
      if (readdirSync(oldAbs).length) return { ok: false, code: 'not_empty' }
      renameSync(oldAbs, newAbs)
    } else if (!here) {
      mkdirSync(dirname(newAbs), { recursive: true })
      mkdirSync(newAbs)
    } else {
      return { ok: false, code: 'failed', detail: 'not a folder' }
    }
  } catch (err: any) {
    // Whatever happened, the link must show again where the registry says.
    try { reconcileMountLinks(listMounts()) } catch { /* start-up pass */ }
    return { ok: false, code: 'failed', detail: String(err?.code || err?.message || err) }
  }

  // The same registries `renameLife` moves, plus ours.
  movePhysical(from, to)
  moveDisplayLabels(from, to)
  moveArchivedPrefix(from, to)
  followFolderMove(from, to)
  const all = listMounts()
  const moved = all.find((m) => m.rel === to)
  if (moved) { try { ensureMountLink(moved, all) } catch { /* start-up pass */ } }
  logger.info({ from, to }, '[intezo] a link was moved in the tree, its target untouched')
  return { ok: true, rel: to, name }
}

/** Rename a folder that IS a link: same parent, new name. */
export function renameMountPoint(rel: string, newName: string): MountPointRename {
  const from = norm(rel)
  if (/[\\/]/.test(String(newName))) return { ok: false, code: 'bad_name' }
  const clean = safeLifeName(newName)
  if (!clean || clean === '_') return { ok: false, code: 'bad_name' }
  const parentRel = from.includes('/') ? from.slice(0, from.lastIndexOf('/')) : ''
  return relocateMountPoint(from, parentRel ? `${parentRel}/${clean}` : clean)
}

/**
 * Move a folder that IS a link into another folder of the tree, keeping its
 * name. The destination must be a real folder of the tree: a link put INSIDE
 * another link would be written into that link's store.
 */
export function moveMountPoint(rel: string, toDirRel: string): MountPointRename {
  const from = norm(rel)
  const toDir = norm(toDirRel)
  const root = depotRoot()
  if (!root) return { ok: false, code: 'no_depot' }
  if (toDir && (toDir === from || toDir.startsWith(from + '/'))) return { ok: false, code: 'no_target' }
  if (listMounts().some((m) => toDir === m.rel || toDir.startsWith(m.rel + '/'))) return { ok: false, code: 'into_link' }
  const dirAbs = toDir ? join(root, ...toDir.split('/')) : root
  const st = lst(dirAbs)
  if (!st || !st.isDirectory()) return { ok: false, code: 'no_target' }
  const name = from.slice(from.lastIndexOf('/') + 1)
  return relocateMountPoint(from, toDir ? `${toDir}/${name}` : name)
}
