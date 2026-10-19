// #716 (Boss TG 10015): "Mellékletet CSAK az Életfából csatolunk." A file that sits inside a work item's own folder
// (Uploads, Attachments, Finished materials, ...) has not been put in its place in the Life tree yet, so it cannot be
// attached as an annex: it must be moved first (the "move to the Life tree" list), and then it is LINKED by its
// document id -- an annex that points at a place inside a work item folder breaks the day the folder is tidied.
import { listWorkItems } from './workbench.js'
import type { ProjectRow } from './projects.js'

const norm = (p: string): string => String(p || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')

/** true when `projectPath` (relative to the project folder) lies inside the folder of one of the project's work items. */
export function annexNeedsLifeMove(project: Pick<ProjectRow, 'id'>, projectPath: string): boolean {
  const p = norm(projectPath)
  if (!p) return false
  for (const w of listWorkItems(project.id)) {
    const f = norm(w.folder || '')
    if (f && (p === f || p.startsWith(f + '/'))) return true
  }
  return false
}
