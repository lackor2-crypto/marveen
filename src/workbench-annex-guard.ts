// #716 (Boss TG 10015) once refused a file inside a work item's own folder (Uploads, Attachments, ...) as an annex:
// "Mellekletet CSAK az Eletfabol csatolunk." Boss, TG 3851, removed that restriction: a scanned form that sits in the
// work item's Attachments folder is attached from there, no move to the Life tree needed. The function stays (callers
// and the agent tool keep one place to ask) but nothing is refused any more.
import type { ProjectRow } from './projects.js'

/** Always false: any file of the project can be an annex, wherever it lies (Boss, TG 3851). */
export function annexNeedsLifeMove(_project: Pick<ProjectRow, 'id'>, _projectPath: string): boolean {
  return false
}
