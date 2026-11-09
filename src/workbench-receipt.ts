/**
 * Boss, 2026-11-08 (#879): the proof an online portal gives back after an upload (a PDF or screenshot with the
 * confirmation) goes into ONE project-level subfolder, default "Feladási bizonylatok" / "Proofs of submission".
 * It never goes into the work item's own folder (that holds only the Kontextus and Teendő files). The folder name is
 * the owner's to change; the Kontextus log records where the file went.
 */
import { ol } from './owner-lang.js'
import { getProject } from './projects.js'
import { getWorkItem, type WorkItemRow } from './workbench.js'
import { appendItemContext, contextOwner } from './workbench-item-context.js'
import { workItemFolder } from './workbench-assets.js'
import { makeProjectFolder, writeProjectFile, receiptFolderFor, RECEIPT_FOLDER_NAMES, type FileErrorCode } from './project-files.js'
import type { UploadData } from './upload-stream.js'

export { RECEIPT_FOLDER_NAMES }

/** The default folder name in the owner's language. */
export function defaultReceiptFolder(): string { return ol(RECEIPT_FOLDER_NAMES.hu, RECEIPT_FOLDER_NAMES.en) }

export type ReceiptOutcome =
  | { ok: true; folder: string; rel: string; name: string; renamed: boolean }
  | { ok: false; code: FileErrorCode | 'folder_name' | 'project_not_found' | 'item_not_found'; message?: string }

export function saveReceiptFile(item: WorkItemRow, folderName: unknown, fileName: unknown, data: UploadData): ReceiptOutcome {
  const project = getProject(item.project_id)
  if (!project) return { ok: false, code: 'project_not_found' }
  const typed = String(folderName ?? '').trim()
  // The panel always sends the default name: that (either language) means "the item's own folder", not a project-level one.
  const custom = typed === RECEIPT_FOLDER_NAMES.hu || typed === RECEIPT_FOLDER_NAMES.en ? '' : typed
  // #890 (Boss TG 5754): by default the proof goes into the WORK ITEM's own "Feladási bizonylatok" subfolder (next to its
  // trigger document and finished materials). Only an item without a folder of its own (or a name the owner typed) uses a
  // project-level folder.
  const itemFolder = custom ? null : workItemFolder(item.id)
  const own = itemFolder ? receiptFolderFor(project, itemFolder, undefined, true) : null
  let sub: string
  if (own) sub = own
  else {
    const made = makeProjectFolder(project, '', custom || defaultReceiptFolder())
    if (!made.ok) return { ok: false, code: made.code, message: made.message }
    sub = made.sub
  }
  const w = writeProjectFile(project, sub, fileName, data)
  if (!w.ok) return { ok: false, code: w.code, message: w.message }
  const fresh = getWorkItem(item.id) || item
  const line = `- ${ol('Feladási bizonylat (a portál visszaigazolása) elmentve', 'Proof of submission (the portal confirmation) saved')}: ${w.rel}`
  appendItemContext(contextOwner(fresh), project, 'log', line)
  return { ok: true, folder: sub, rel: w.rel, name: w.name, renamed: w.renamed }
}
