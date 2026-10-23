// #709 (Boss TG 9894, 10243): the FIRST work item of a folder (the "anchor") and its folder carry the same name, and
// so do its files (context, to-do, the timeline / deck / drawing JSON). Rename the anchor, or the folder, and the whole
// set follows. Every later work item of the folder keeps its own name: nothing it does renames the folder, and
// renaming the folder never renames it. The folder itself moves as one piece (moveWorkFolder), so a move needs
// nothing here.
//
// Why a wrapper and not renameWorkItem itself: the plain renameWorkItem (#478, "a folder is a named group") stays
// the pure title change; the folder and the file names follow here and in the context sweep (followItemJsonNames).
import { getDb } from './db.js'
import { getProject } from './projects.js'
import { getWorkItem, type WorkItemRow } from './workbench.js'
import { folderNameFromTitle, renameWorkFolder, renameWorkItem, type RenameFolderResult, type RenameItemOutcome } from './workbench-assets.js'
import { reconcileItemContext, rememberItemStem } from './workbench-item-context.js'
import { logger } from './logger.js'

/** The first (oldest) work item that has `folder` as its own folder; null when none does. */
export function anchorOfFolder(projectId: string, folder: string): WorkItemRow | null {
  const f = String(folder || '').replace(/^\/+|\/+$/g, '')
  if (!f) return null
  const row = getDb().prepare('SELECT id FROM work_items WHERE project_id = ? AND folder = ? ORDER BY created_at ASC, rowid ASC LIMIT 1').get(projectId, f) as { id: string } | undefined
  return row ? (getWorkItem(row.id) ?? null) : null
}

function settle(itemId: string): void {
  try {
    const it = getWorkItem(itemId)
    const project = it ? getProject(it.project_id) : null
    if (it && project) reconcileItemContext(it, project)
  } catch (err: any) {
    logger.warn({ item: itemId, err: String(err?.message || err) }, '[rename-together] the file names will follow on the next sweep')
  }
}

/**
 * Renames a work item. When it is the anchor of its own folder, the folder takes the new name too (every registered
 * path follows), and the file names follow through the context pass. A later item of the folder only changes its title.
 */
export function renameItemTogether(item: WorkItemRow, rawTitle: unknown): RenameItemOutcome {
  const before = getWorkItem(item.id) ?? item
  try { rememberItemStem(before) } catch { /* the sweep then falls back to the file's own name */ }
  const r = renameWorkItem(before, rawTitle)
  if (!r.ok) return r
  const own = String(r.item.folder ?? '').trim()
  const project = getProject(r.item.project_id)
  if (!own || !project) { settle(item.id); return r }
  const anchor = anchorOfFolder(project.id, own)
  if (!anchor || anchor.id !== item.id) { settle(item.id); return { ...r, folder: { ok: true, renamed: false, reason: 'not_first' } } }
  const wanted = folderNameFromTitle(r.item.title)
  const lastSeg = own.slice(own.lastIndexOf('/') + 1)
  if (wanted === lastSeg) { settle(item.id); return { ...r, folder: { ok: true, renamed: false, reason: 'same_name' } } }
  const fr = renameWorkFolder(project, own, wanted)
  if (!fr.ok) {
    // A taken name or a protected folder never blocks the title change: the item is renamed, the folder keeps its name.
    settle(item.id)
    return { ...r, folder: fr.code === 'folder_exists' ? { ok: true, renamed: false, reason: 'name_taken' } : { ok: false, code: 'move_failed', message: fr.message || fr.code } }
  }
  settle(item.id)
  return { ok: true, item: getWorkItem(item.id) as WorkItemRow, folder: fr.renamed ? { ok: true, renamed: true, from: own, to: fr.folder } : { ok: true, renamed: false, reason: 'same_name' } }
}

/**
 * Renames a folder of the work items box. The anchor (first item) of that folder takes the new name as its title, and
 * its files follow through the context pass; later items are not touched.
 */
export function renameFolderTogether(project: Parameters<typeof renameWorkFolder>[0], folder: unknown, newName: unknown): RenameFolderResult {
  const r = renameWorkFolder(project, folder, newName)
  if (!r.ok || !r.renamed) return r
  const anchor = anchorOfFolder(project.id, r.folder)
  if (!anchor) return r
  const seg = r.folder.slice(r.folder.lastIndexOf('/') + 1)
  if (anchor.title === seg) { settle(anchor.id); return { ...r, item: getWorkItem(anchor.id) ?? anchor } }
  try { rememberItemStem(anchor) } catch { /* the sweep then falls back to the file's own name */ }
  const t = renameWorkItem(anchor, seg)
  settle(anchor.id)
  return t.ok ? { ...r, item: getWorkItem(anchor.id) ?? t.item } : r
}
