/**
 * FINALIZING A WORD (.docx) WORK ITEM (kanban #719, Boss TG 3822 / 3828 / 3830).
 *
 * The top Finalize button of an uploaded Word file only closed the item: no PDF, no e-mail, unlike a drafted (court)
 * document. Now it opens a panel; finalizing makes a PDF of the Word file and puts it into the item's Finished materials
 * folder (as a table's finalize does, Boss TG 3830). Nothing is overwritten (a taken name gets a number). After that the
 * owner can make an e-mail draft (.eml, the PDF attached) in the same folder and open it in the mail program.
 * A PDF that cannot be made blocks the finalize: the PDF is what the owner asked for.
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolveLifePath } from './life-explorer.js'
import { fileStem } from './workbench-docfinal.js'
import { convertOfficeToPdf } from './office-convert.js'
import { getWorkItem, type WorkItemRow } from './workbench.js'
import { finalizeWorkItem } from './workbench-approval.js'
import { attachAsset, listWorkItemAssets } from './workbench-assets.js'
import { buildEml, cleanAddresses } from './workbench-maildraft.js'
import { basename } from 'node:path'

const SUFFIX = { hu: 'végleges', en: 'final' } as const
const MAIL_SUFFIX = { hu: 'e-mail piszkozat', en: 'email draft' } as const
type Ui = 'hu' | 'en'

/** Whether the top Finalize button of this item opens the Word finalize panel. */
export function hasDocxFinalPanel(item: Pick<WorkItemRow, 'source_path'>): boolean {
  return !!item.source_path && /\.docx$/i.test(item.source_path)
}

export type DocxFinalCode =
  | 'docx_final_not_docx' | 'docx_final_unreadable' | 'docx_final_save_failed' | 'docx_final_already_done'
  | 'docx_mail_no_pdf' | 'docx_mail_bad_address' | 'docx_mail_save_failed'

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

/** The newest final PDF of the item (registered by the finalize), or null. */
function latestFinalPdf(item: WorkItemRow, ui: Ui): { abs: string; name: string } | null {
  const base = `${stemOf(item)} - ${SUFFIX[ui]}`
  const rows = listWorkItemAssets(item.id).filter((a) => a.present && a.name.startsWith(base) && /\.pdf$/i.test(a.name))
  const last = rows[rows.length - 1]
  if (!last) return null
  const abs = resolveLifePath(last.path)
  return abs ? { abs, name: last.name } : null
}

export interface DocxMailView { pdf_name: string | null; default_subject: string }

/** What the mail panel shows: whether there is a final PDF to attach, and the default subject. */
export function docxMailView(item: WorkItemRow, ui: Ui): DocxMailView {
  const p = latestFinalPdf(item, ui)
  return { pdf_name: p ? p.name : null, default_subject: item.title }
}

export type DocxMailOutcome =
  | { ok: true; eml_path: string; eml_name: string; pdf_name: string }
  | { ok: false; code: DocxFinalCode; detail: string | null }

/** The e-mail draft: an .eml (opens in the mail program as an unsent draft) in Finished materials, the final PDF attached. */
export function makeDocxMailDraft(item: WorkItemRow, input: { to?: unknown; cc?: unknown; subject?: unknown; body?: unknown }, ui: Ui): DocxMailOutcome {
  if (!hasDocxFinalPanel(item)) return { ok: false, code: 'docx_final_not_docx', detail: null }
  const pdf = latestFinalPdf(item, ui)
  if (!pdf) return { ok: false, code: 'docx_mail_no_pdf', detail: null }
  const to = cleanAddresses(input.to ?? '')
  const cc = cleanAddresses(input.cc ?? '')
  if (to == null || cc == null) return { ok: false, code: 'docx_mail_bad_address', detail: null }
  const subject = typeof input.subject === 'string' && input.subject.trim() ? input.subject.trim().slice(0, 300) : item.title
  const body = typeof input.body === 'string' ? input.body.slice(0, 20_000) : ''
  let eml: Buffer
  try { eml = buildEml({ to, cc, subject, body, attachments: [{ name: pdf.name, data: readFileSync(pdf.abs), type: 'application/pdf' }] }) }
  catch (e) { return { ok: false, code: 'docx_mail_save_failed', detail: e instanceof Error ? e.message : String(e) } }
  const saved = attachAsset(item, `${stemOf(item)} - ${MAIL_SUFFIX[ui]}.eml`, eml, { force: true, createdBy: null, into: 'finished' })
  if (!saved.ok) return { ok: false, code: 'docx_mail_save_failed', detail: saved.code }
  return { ok: true, eml_path: saved.asset.path, eml_name: saved.asset.name, pdf_name: pdf.name }
}
