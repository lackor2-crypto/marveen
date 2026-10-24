/**
 * FINALIZING A TEXT-FILE WORK ITEM (kanban #667, Boss TG 9260).
 *
 * A note (or any item) whose file is a .md / .txt has no outline, no checks and no language variants of its own, so the
 * plain status switch left the owner with "done" and nothing in Finished materials. Finalizing it now also makes the
 * PDF of the file and puts it into the item's Finished materials folder, then marks the item finalized.
 * The PDF comes first: when it cannot be made the status does not change.
 */
import { readFileSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import { resolveLifePath } from './life-explorer.js'
import { attachAsset, listWorkItemAssets } from './workbench-assets.js'
import { fileStem } from './workbench-docfinal.js'
import { buildTextFodt, PDF_FILTER_FINAL, renderFodtPdf } from './workbench-docrender.js'
import { getWorkItem, type WorkItemRow } from './workbench.js'
import { finalizeWorkItem } from './workbench-approval.js'
import { cleanLangCode, readTextVariant, saveTextVariant } from './workbench-notelang.js'
import { outlineTextOf } from './workbench-textdoc.js'
import { documentOutline, hasDocModel } from './workbench-docmodel.js'

/** True when the file is a plain text / Markdown file: the kind that has no outline of its own. */
export function isTextSourcePath(rel: string | null | undefined): boolean {
  return /\.(md|markdown|txt)$/i.test(rel || '')
}

/** Whether the top Finalize button of this item opens the finalize panel (with the PDF) instead of the bare status switch. */
export function hasTextFinalPanel(item: Pick<WorkItemRow, 'source_path'>): boolean {
  return isTextSourcePath(item.source_path)
}

export type NoteFinalCode = 'note_final_not_text' | 'note_final_unreadable' | 'note_final_pdf_failed' | 'note_final_save_failed' | 'note_final_already_done' | 'note_final_bad_translation' | 'note_final_no_variant'

export type NoteFinalOutcome =
  | { ok: true; item: WorkItemRow; asset_path: string; asset_name: string }
  | { ok: false; code: NoteFinalCode; detail: string | null }

export async function finalizeTextItem(item: WorkItemRow, input: { by: string | null; lang?: string | null; text?: string | null }): Promise<NoteFinalOutcome> {
  if (!item.source_path || !isTextSourcePath(item.source_path)) return { ok: false, code: 'note_final_not_text', detail: null }
  if (item.status === 'done') return { ok: false, code: 'note_final_already_done', detail: null }
  // A picked language is PDF-ed instead of the file; its language code goes into the PDF's name, so the original-language PDF
  // and the translated one sit side by side in Finished materials.
  const lang = input.lang ? cleanLangCode(input.lang) : null
  if (input.lang && !lang) return { ok: false, code: 'note_final_bad_translation', detail: null }
  let text: string
  if (lang) {
    // A text sent with the language is the fresh translation: it is SAVED as the language version first (so it is not lost),
    // then PDF-ed. Without a text, the saved version of that language is used.
    if (input.text != null) {
      const sv = saveTextVariant(item, lang, input.text, input.by)
      if (!sv.ok) return { ok: false, code: sv.code === 'bad_text' || sv.code === 'bad_lang' || sv.code === 'variant_of_variant' ? 'note_final_bad_translation' : 'note_final_save_failed', detail: sv.detail ?? sv.code }
      text = input.text
    } else {
      const have = readTextVariant(item, lang)
      if (have == null) return { ok: false, code: 'note_final_no_variant', detail: lang }
      text = have
    }
  } else {
    // #673: once the note is on the document page its outline is the truth (the file can be a moment behind it).
    const fromPage = outlineTextOf(item)
    const abs = resolveLifePath(item.source_path)
    try {
      if (fromPage != null) text = fromPage
      else if (!abs) return { ok: false, code: 'note_final_unreadable', detail: null }
      else text = readFileSync(abs, 'utf-8')
    } catch (e) {
      return { ok: false, code: 'note_final_unreadable', detail: e instanceof Error ? e.message : String(e) }
    }
  }
  const stem = fileStem(basename(item.source_path).replace(/\.[^.]+$/, ''))
  // #725 (Boss TG 3987): a text that did not change since its final PDF was made gets no new PDF -- the one there is is used
  // again, so finalizing (or sending to many places) never piles up "(2)", "(3)" copies. Language versions are always made.
  const same = lang ? null : unchangedFinalPdf(item, `${stem}.pdf`)
  if (same) {
    const done0 = finalizeWorkItem(item.id, { by: input.by || 'dashboard' })
    if (!done0.ok) return { ok: false, code: 'note_final_already_done', detail: done0.code }
    return { ok: true, item: getWorkItem(item.id) ?? done0.item, asset_path: same.path, asset_name: same.name }
  }
  const r = await renderFodtPdf(buildTextFodt(text, stem), PDF_FILTER_FINAL)
  if (!r.ok) return { ok: false, code: 'note_final_pdf_failed', detail: r.detail ?? r.code }
  const pdfName = lang ? `${stem} (${lang.toUpperCase()}).pdf` : `${stem}.pdf`
  const saved = attachAsset(item, pdfName, r.pdf, { force: true, createdBy: input.by, into: 'finished' })
  if (!saved.ok) return { ok: false, code: 'note_final_save_failed', detail: saved.code }
  const done = finalizeWorkItem(item.id, { by: input.by || 'dashboard' })
  if (!done.ok) return { ok: false, code: 'note_final_already_done', detail: done.code }
  return { ok: true, item: getWorkItem(item.id) ?? done.item, asset_path: saved.asset.path, asset_name: saved.asset.name }
}

/**
 * #783: the final PDF the note finalize left in Finished materials (an item finalized before #777, when the note had its own
 * finalize), for the project close check: its name, and whether the text changed since it was made. Null = there is none.
 */
export function noteFinalPdf(item: WorkItemRow): { name: string; stale: boolean } | null {
  if (!item.source_path || !isTextSourcePath(item.source_path)) return null
  const pdfName = `${fileStem(basename(item.source_path).replace(/\.[^.]+$/, ''))}.pdf`
  const base = pdfName.replace(/\.pdf$/i, '')
  const rows = listWorkItemAssets(item.id).filter((a) => a.present && (a.name === pdfName || new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(\\d+\\)\\.pdf$`, 'i').test(a.name)))
  const last = rows[rows.length - 1]
  if (!last) return null
  return { name: last.name, stale: !unchangedFinalPdf(item, pdfName) }
}

/** The newest final PDF of the item when it is not older than the text it was made from (the file and the page), else null. */
function unchangedFinalPdf(item: WorkItemRow, pdfName: string): { path: string; name: string } | null {
  const base = pdfName.replace(/\.pdf$/i, '')
  const rows = listWorkItemAssets(item.id).filter((a) => a.present && (a.name === pdfName || new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(\\d+\\)\\.pdf$`, 'i').test(a.name)))
  const last = rows[rows.length - 1]
  const abs = last ? resolveLifePath(last.path) : null
  if (!last || !abs) return null
  try {
    const made = statSync(abs).mtimeMs
    let changed = 0
    const src = item.source_path ? resolveLifePath(item.source_path) : null
    if (src) changed = Math.max(changed, statSync(src).mtimeMs)
    if (hasDocModel(item.id)) {
      for (const sec of documentOutline(item.id).sections) {
        changed = Math.max(changed, (sec.updated_at || 0) * 1000)
        for (const b of sec.blocks) changed = Math.max(changed, (b.updated_at || 0) * 1000)
      }
    }
    return made >= changed ? { path: last.path, name: last.name } : null
  } catch { return null }
}
