/**
 * FINALIZING A WORD (.docx) WORK ITEM (kanban #719, Boss TG 3822 / 3828 / 3830).
 *
 * The top Finalize button of an uploaded Word file only closed the item: no PDF, no e-mail, unlike a drafted (court)
 * document. Now it opens a panel; finalizing makes a PDF of the Word file and puts it into the item's Finished materials
 * folder (as a table's finalize does, Boss TG 3830). Nothing is overwritten (a taken name gets a number). After that the
 * owner makes the e-mail draft with the same panel and code as a court document (workbench-maildraft.ts, #723).
 * A PDF that cannot be made blocks the finalize: the PDF is what the owner asked for.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolveLifePath } from './life-explorer.js'
import { fileStem } from './workbench-docfinal.js'
import { convertOfficeToPdf } from './office-convert.js'
import { getWorkItem, type WorkItemRow } from './workbench.js'
import { finalizeWorkItem } from './workbench-approval.js'
import { attachAsset, listWorkItemAssets } from './workbench-assets.js'
import { basename } from 'node:path'

const SUFFIX = { hu: 'végleges', en: 'final' } as const
type Ui = 'hu' | 'en'

/** Whether the top Finalize button of this item opens the Word finalize panel. */
export function hasDocxFinalPanel(item: Pick<WorkItemRow, 'source_path'>): boolean {
  return !!item.source_path && /\.docx$/i.test(item.source_path)
}

export type DocxFinalCode =
  | 'docx_final_not_docx' | 'docx_final_unreadable' | 'docx_final_save_failed' | 'docx_final_already_done'

export type DocxFinalOutcome =
  | { ok: true; item: WorkItemRow; pdf_path: string; pdf_name: string }
  | { ok: false; code: DocxFinalCode | 'convert'; detail: string | null; convert?: string }

const stemOf = (item: WorkItemRow): string => fileStem(basename(item.source_path as string).replace(/\.[^.]+$/, ''))

export async function finalizeDocxItem(item: WorkItemRow, input: { by: string | null; ui: Ui }): Promise<DocxFinalOutcome> {
  if (!hasDocxFinalPanel(item)) return { ok: false, code: 'docx_final_not_docx', detail: null }
  if (item.status === 'done') return { ok: false, code: 'docx_final_already_done', detail: null }
  const abs = resolveLifePath(item.source_path as string)
  if (!abs || !existsSync(abs)) return { ok: false, code: 'docx_final_unreadable', detail: null }
  // #725 (Boss TG 3987): a Word file that did not change since its final PDF was made gets no new PDF -- the one that is there
  // is used again, so pressing Finalize (or sending to many places) never piles up "(2)", "(3)" copies in Finished materials.
  const same = unchangedFinalPdf(item, abs)
  let pdfPath: string
  let pdfName: string
  if (same) {
    pdfPath = same.path
    pdfName = same.name
  } else {
    const c = await convertOfficeToPdf(abs)
    if (!c.ok) return { ok: false, code: 'convert', convert: c.code, detail: c.detail }
    const saved = attachAsset(item, `${stemOf(item)} - ${SUFFIX[input.ui]}.pdf`, readFileSync(c.pdf), { force: true, createdBy: input.by, into: 'finished' })
    if (!saved.ok) return { ok: false, code: 'docx_final_save_failed', detail: saved.code }
    pdfPath = saved.asset.path
    pdfName = saved.asset.name
  }
  const done = finalizeWorkItem(item.id, { by: input.by || 'dashboard' })
  if (!done.ok) return { ok: false, code: 'docx_final_already_done', detail: done.code }
  return { ok: true, item: getWorkItem(item.id) ?? done.item, pdf_path: pdfPath, pdf_name: pdfName }
}

/** The newest final PDF of the item when it is not older than the Word file (so it still shows the file as it is), else null. */
function unchangedFinalPdf(item: WorkItemRow, docxAbs: string): { path: string; name: string } | null {
  const bases = Object.values(SUFFIX).map((s) => `${stemOf(item)} - ${s}`)
  const rows = listWorkItemAssets(item.id).filter((a) => a.present && bases.some((b) => a.name.startsWith(b)) && /\.pdf$/i.test(a.name))
  const last = rows[rows.length - 1]
  if (!last) return null
  const abs = resolveLifePath(last.path)
  if (!abs) return null
  try { return statSync(abs).mtimeMs >= statSync(docxAbs).mtimeMs ? { path: last.path, name: last.name } : null } catch { return null }
}

/**
 * #783: the final PDF the Word finalize left (an item finalized before #777), for the project close check: its name, and
 * whether the Word file changed since it was made. Null = there is none.
 */
export function docxFinalState(item: WorkItemRow): { name: string; stale: boolean } | null {
  if (!hasDocxFinalPanel(item)) return null
  const pdf = docxFinalPdf(item)
  if (!pdf) return null
  const src = item.source_path ? resolveLifePath(item.source_path) : null
  let stale = false
  try { if (src) stale = statSync(pdf.abs).mtimeMs < statSync(src).mtimeMs } catch { /* an unreadable file: not called stale */ }
  return { name: pdf.name, stale }
}

/**
 * The newest final PDF of the item (registered by the finalize), or null. Both languages' names count: the page language
 * may have changed since the finalize. The e-mail draft (workbench-maildraft.ts, #723) attaches it.
 */
export function docxFinalPdf(item: WorkItemRow): { abs: string; name: string } | null {
  const bases = Object.values(SUFFIX).map((s) => `${stemOf(item)} - ${s}`)
  const rows = listWorkItemAssets(item.id).filter((a) => a.present && bases.some((b) => a.name.startsWith(b)) && /\.pdf$/i.test(a.name))
  const last = rows[rows.length - 1]
  if (!last) return null
  const abs = resolveLifePath(last.path)
  return abs ? { abs, name: last.name } : null
}
