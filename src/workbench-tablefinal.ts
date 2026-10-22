/**
 * FINALIZING A TABLE (SPREADSHEET) WORK ITEM (kanban #674, Boss TG 9357).
 *
 * The top Finalize button of a table item used to be a bare browser confirm. It now opens a panel (like the note's, #667),
 * and finalizing puts the finished workbook into the item's Finished materials folder, with a PDF next to it when
 * LibreOffice is there. There is no language version: tables are not translated.
 * The workbook is saved first: when it cannot be, the status does not change. A missing PDF never blocks the finalize
 * (the workbook is the deliverable), but the outcome says so.
 */
import { readFileSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import { resolveLifePath } from './life-explorer.js'
import { attachAsset, listWorkItemAssets, sha256Of } from './workbench-assets.js'
import { FINISHED_FOLDER_NAMES, FINISHED_FOLDER_OLD_NAMES } from './project-files.js'
import { fileStem } from './workbench-docfinal.js'
import { convertOfficeToPdf, isOfficeConvertible } from './office-convert.js'
import { isTableFile } from './workbench-table.js'
import { getWorkItem, type WorkItemRow } from './workbench.js'
import { finalizeWorkItem } from './workbench-approval.js'

/** Whether the top Finalize button of this item opens the table finalize panel. */
export function hasTableFinalPanel(item: Pick<WorkItemRow, 'source_path'>): boolean {
  return !!item.source_path && isTableFile(item.source_path)
}

export type TableFinalCode = 'table_final_not_table' | 'table_final_unreadable' | 'table_final_save_failed' | 'table_final_already_done'

export type TableFinalOutcome =
  | { ok: true; item: WorkItemRow; asset_path: string; asset_name: string; pdf_name: string | null; pdf_note: 'made' | 'no_converter' | 'not_convertible' | 'failed' }
  | { ok: false; code: TableFinalCode; detail: string | null }

export async function finalizeTableItem(item: WorkItemRow, input: { by: string | null }): Promise<TableFinalOutcome> {
  if (!hasTableFinalPanel(item)) return { ok: false, code: 'table_final_not_table', detail: null }
  if (item.status === 'done') return { ok: false, code: 'table_final_already_done', detail: null }
  const abs = resolveLifePath(item.source_path as string)
  if (!abs) return { ok: false, code: 'table_final_unreadable', detail: null }
  let data: Buffer
  try { data = readFileSync(abs) } catch (e) { return { ok: false, code: 'table_final_unreadable', detail: e instanceof Error ? e.message : String(e) } }
  const fileName = basename(item.source_path as string)
  // #738 (Boss TG 4110): a workbook that did not change since its final copy was made gets no new copy and no new PDF -- the
  // ones in Finished materials are used again, so finalizing again never piles up "(2)" twins. A changed workbook is saved anew.
  const sameBook = unchangedFinishedBook(item, data)
  const saved = sameBook
    ? { ok: true as const, asset: sameBook }
    : attachAsset(item, fileName, data, { force: true, createdBy: input.by, into: 'finished' })
  if (!saved.ok) return { ok: false, code: 'table_final_save_failed', detail: saved.code }
  let pdfName: string | null = null
  let pdfNote: 'made' | 'no_converter' | 'not_convertible' | 'failed' = 'not_convertible'
  if (isOfficeConvertible(fileName)) {
    const stem = fileStem(fileName.replace(/\.[^.]+$/, ''))
    const samePdf = sameBook ? finishedPdfNotOlder(item, `${stem}.pdf`, sameBook.path) : null
    if (samePdf) { pdfName = samePdf.name; pdfNote = 'made' } else {
      const c = await convertOfficeToPdf(abs)
      if (c.ok) {
        const p = attachAsset(item, `${stem}.pdf`, readFileSync(c.pdf), { force: true, createdBy: input.by, into: 'finished' })
        if (p.ok) { pdfName = p.asset.name; pdfNote = 'made' } else pdfNote = 'failed'
      } else pdfNote = c.code === 'not_installed' || c.code === 'check_failed' ? 'no_converter' : 'failed'
    }
  }
  const done = finalizeWorkItem(item.id, { by: input.by || 'dashboard' })
  if (!done.ok) return { ok: false, code: 'table_final_already_done', detail: done.code }
  return { ok: true, item: getWorkItem(item.id) ?? done.item, asset_path: saved.asset.path, asset_name: saved.asset.name, pdf_name: pdfName, pdf_note: pdfNote }
}

const FINISHED_DIRS: string[] = [...Object.values(FINISHED_FOLDER_NAMES), ...FINISHED_FOLDER_OLD_NAMES]

/** Whether a registered asset stands in the item's Finished materials folder (not among the uploads or the source). */
function inFinished(path: string): boolean {
  return path.split('/').slice(0, -1).some((seg) => FINISHED_DIRS.includes(seg))
}

/** The newest Finished-materials copy that holds exactly these bytes and is still on disk, else null. */
function unchangedFinishedBook(item: WorkItemRow, data: Buffer): ReturnType<typeof listWorkItemAssets>[number] | null {
  const sha = sha256Of(data)
  const rows = listWorkItemAssets(item.id).filter((a) => a.present && a.sha256 === sha && inFinished(a.path))
  return rows[rows.length - 1] ?? null
}

/** The newest Finished-materials PDF of this name (or "name (N)") that is not older than the workbook copy, else null. */
function finishedPdfNotOlder(item: WorkItemRow, pdfName: string, bookPath: string): { name: string } | null {
  const base = pdfName.replace(/\.pdf$/i, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`^${base}( \\(\\d+\\))?\\.pdf$`, 'i')
  const rows = listWorkItemAssets(item.id).filter((a) => a.present && inFinished(a.path) && re.test(a.name))
  const last = rows[rows.length - 1]
  const pdfAbs = last ? resolveLifePath(last.path) : null
  const bookAbs = resolveLifePath(bookPath)
  if (!last || !pdfAbs || !bookAbs) return null
  try { return statSync(pdfAbs).mtimeMs >= statSync(bookAbs).mtimeMs ? { name: last.name } : null } catch { return null }
}
