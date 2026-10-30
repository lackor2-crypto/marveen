/**
 * #794 (Boss TG 3665/3670): the "Kiváltó irat" / "Trigger document" folder of a work item holds a LINK to the document that
 * triggered the work item (an authority's decision, a request for missing documents, a letter to be answered). This reads
 * the state of that folder for the assistant: what is linked there, and whether the owner marked "no trigger document
 * (own initiative)". Reads only; makes nothing.
 */
import { readdirSync } from 'node:fs'
import { listMounts } from './life-mounts.js'
import { projectFileTarget, TRIGGER_FOLDER_NAMES } from './project-files.js'
import type { ProjectRow } from './projects.js'
import type { WorkItemRow } from './workbench.js'

export type TriggerState = {
  /** project-relative folder, or null when the item has no trigger folder (yet). */
  folder: string | null
  files: string[]
  noTrigger: boolean
}

export function triggerStateOf(project: ProjectRow, item: Pick<WorkItemRow, 'folder' | 'container_folder' | 'no_trigger'>): TriggerState {
  const noTrigger = item.no_trigger === 1
  // An own-file item has no folder of its own: its container folder is the item folder.
  const cf = String(item.container_folder ?? '').trim()
  const base = String(item.folder ?? '').trim() || (cf && cf !== '@project' ? cf : '')
  if (!base) return { folder: null, files: [], noTrigger }
  for (const n of [TRIGGER_FOLDER_NAMES.hu, TRIGGER_FOLDER_NAMES.en]) {
    const sub = `${base}/${n}`
    const t = projectFileTarget(project, sub)
    if (!t.ok) continue
    const files = new Set<string>()
    // A linked file is a file mount (it has no entry on the disk of the folder), a plain file is an entry.
    const prefix = `${project.folder_path}/${sub}/`
    for (const m of listMounts()) if (m.file && m.rel.startsWith(prefix) && !m.rel.slice(prefix.length).includes('/')) files.add(m.rel.slice(prefix.length))
    try { for (const e of readdirSync(t.dirAbs, { withFileTypes: true })) if (e.isFile() && !e.name.startsWith('.')) files.add(e.name) } catch { /* unreadable: counts as no files, the warning is the safe side */ }
    return { folder: sub, files: [...files].sort(), noTrigger }
  }
  return { folder: null, files: [], noTrigger }
}

/** The line(s) the assistant reads first in every turn: the work does not start without a trigger document. */
export function triggerContextLine(st: TriggerState): string {
  if (st.noTrigger) return 'Trigger document: the owner marked "no trigger document (own initiative)": no document triggered this work item, work on without one.'
  if (st.files.length) return `Trigger document (linked in the "Kiváltó irat" folder): ${st.files.join('; ')}. Read it first: this is what the work answers.`
  return 'Trigger document: NONE is linked in the "Kiváltó irat" folder and the owner did not mark "no trigger document". BEFORE any work, in your FIRST reply, tell the owner that the trigger document is missing and offer to find it in the Life tree and link it (the document stays where it is, only a link goes into the folder), or to mark the item "no trigger document (own initiative)". Do not start the work until one of the two is done.'
}

/** #794 (Boss TG 3795): true when the assistant must not work on the item: it has a trigger folder, nothing is linked in it
 *  and the owner did not mark "no trigger document". An item without a trigger folder (a sub-document, a language version)
 *  is not held up. Decided by the server, not left to the model. */
export function triggerBlocksWork(st: TriggerState): boolean {
  return st.folder !== null && st.files.length === 0 && !st.noTrigger
}
