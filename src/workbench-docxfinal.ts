/**
 * FINALIZING A WORD (.docx) WORK ITEM (kanban #719, Boss TG 3822 / 3828 / 3830).
 *
 * The top Finalize button of an uploaded Word file only closed the item: no PDF, no e-mail, unlike a drafted (court)
 * document. Now it opens a panel; finalizing makes a PDF of the Word file and puts it into the item's Finished materials
 * folder (as a table's finalize does, Boss TG 3830). Nothing is overwritten (a taken name gets a number). After that the
 * owner makes the e-mail draft with the same panel and code as a court document (workbench-maildraft.ts, #723).
 * A PDF that cannot be made blocks the finalize: the PDF is what the owner asked for.
 */
import { existsSync, readFileSync } from 'node:fs'
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
  const c = await convertOfficeToPdf(abs)
  if (!c.ok) return { ok: false, code: 'convert', convert: c.code, detail: c.detail }
  const saved = attachAsset(item, `${stemOf(item)} - ${SUFFIX[input.ui]}.pdf`, readFileSync(c.pdf), { force: true, createdBy: input.by, into: 'finished' })
  if (!saved.ok) return { ok: false, code: 'docx_final_save_failed', detail: saved.code }
  const done = finalizeWorkItem(item.id, { by: input.by || 'dashboard' })
  if (!done.ok) return { ok: false, code: 'docx_final_already_done', detail: done.code }
  return { ok: true, item: getWorkItem(item.id) ?? done.item, pdf_path: saved.asset.path, pdf_name: saved.asset.name }
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
