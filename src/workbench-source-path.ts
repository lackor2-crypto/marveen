// #722 (Boss TG 3928): a work item's file path is kept relative to the Depot root -- that is what every reader
// (preview, Word read-in, finalizing) resolves. An item added over the API with a path relative to the PROJECT folder
// ('Munkadarabok/x.docx') was stored as given, and opening it said "the document's file cannot be read" although the
// file was right there. Such a path is now completed on the way in, and rows already stored that way are repaired.
import { existsSync } from 'node:fs'
import { getDb } from './db.js'
import { getProject, type ProjectRow } from './projects.js'
import { resolveLifePath } from './life-explorer.js'

function projectFolderRel(project: Pick<ProjectRow, 'folder_path'>): string {
  return String(project.folder_path || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
}

function existsInDepot(rel: string): boolean {
  const abs = resolveLifePath(rel)
  return !!abs && existsSync(abs)
}

/**
 * The Depot-root relative form of a work item's file path. A path that already resolves (or names the project folder)
 * is kept as it is; a project-relative one is prefixed with the project folder, but only when the file really lies
 * there. Anything else (not a string, empty, not found either way) is handed back unchanged.
 */
export function depotSourcePath<T>(project: Pick<ProjectRow, 'folder_path'>, raw: T): T | string {
  if (typeof raw !== 'string') return raw
  const rel = raw.replace(/\\/g, '/').replace(/^\/+/, '').trim()
  const pf = projectFolderRel(project)
  if (!rel || !pf || rel === pf || rel.startsWith(pf + '/')) return raw
  if (existsInDepot(rel)) return raw
  const full = `${pf}/${rel}`
  return existsInDepot(full) ? full : raw
}

/** Repairs the stored project-relative file paths of a project's items and versions. Returns how many rows changed. */
export function repairProjectRelativeSourcePaths(projectId: string): number {
  const project = getProject(projectId)
  if (!project) return 0
  const pf = projectFolderRel(project)
  if (!pf) return 0
  const db = getDb()
  let changed = 0
  const like = pf.replace(/[\\%_]/g, (c) => '\\' + c) + '/%'
  const items = db.prepare(`SELECT id, source_path FROM work_items WHERE project_id = ? AND source_path IS NOT NULL AND source_path NOT LIKE ? ESCAPE '\\'`)
    .all(project.id, like) as { id: string; source_path: string }[]
  for (const it of items) {
    const fixed = depotSourcePath(project, it.source_path)
    if (fixed !== it.source_path) { db.prepare('UPDATE work_items SET source_path = ? WHERE id = ?').run(fixed, it.id); changed++ }
  }
  const versions = db.prepare(`SELECT v.id, v.source_path FROM work_item_versions v JOIN work_items i ON i.id = v.work_item_id
    WHERE i.project_id = ? AND v.source_path IS NOT NULL AND v.source_path NOT LIKE ? ESCAPE '\\'`)
    .all(project.id, like) as { id: string; source_path: string }[]
  for (const v of versions) {
    const fixed = depotSourcePath(project, v.source_path)
    if (fixed !== v.source_path) { db.prepare('UPDATE work_item_versions SET source_path = ? WHERE id = ?').run(fixed, v.id); changed++ }
  }
  return changed
}
