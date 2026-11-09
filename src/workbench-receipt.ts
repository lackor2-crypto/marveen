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
import { makeProjectFolder, writeProjectFile, RECEIPT_FOLDER_NAMES, type FileErrorCode } from './project-files.js'
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
  const wanted = String(folderName ?? '').trim() || defaultReceiptFolder()
  const made = makeProjectFolder(project, '', wanted)
  if (!made.ok) return { ok: false, code: made.code, message: made.message }
  const w = writeProjectFile(project, made.sub, fileName, data)
  if (!w.ok) return { ok: false, code: w.code, message: w.message }
  const fresh = getWorkItem(item.id) || item
  const line = `- ${ol('Feladási bizonylat (a portál visszaigazolása) elmentve', 'Proof of submission (the portal confirmation) saved')}: ${w.rel}`
  appendItemContext(contextOwner(fresh), project, 'log', line)
  return { ok: true, folder: made.sub, rel: w.rel, name: w.name, renamed: w.renamed }
}
