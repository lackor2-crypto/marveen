/**
 * FINALIZING A TEXT-FILE WORK ITEM (kanban #667, Boss TG 9260).
 *
 * A note (or any item) whose file is a .md / .txt has no outline, no checks and no language variants of its own, so the
 * plain status switch left the owner with "done" and nothing in Finished materials. Finalizing it now also makes the
 * PDF of the file and puts it into the item's Finished materials folder, then marks the item finalized.
 * The PDF comes first: when it cannot be made the status does not change.
 */
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { resolveLifePath } from './life-explorer.js'
import { attachAsset } from './workbench-assets.js'
import { fileStem } from './workbench-docfinal.js'
import { buildTextFodt, PDF_FILTER_FINAL, renderFodtPdf } from './workbench-docrender.js'
import { getWorkItem, type WorkItemRow } from './workbench.js'
import { finalizeWorkItem } from './workbench-approval.js'

/** True when the file is a plain text / Markdown file: the kind that has no outline of its own. */
export function isTextSourcePath(rel: string | null | undefined): boolean {
  return /\.(md|markdown|txt)$/i.test(rel || '')
}

/** Whether the top Finalize button of this item opens the finalize panel (with the PDF) instead of the bare status switch. */
export function hasTextFinalPanel(item: Pick<WorkItemRow, 'source_path'>): boolean {
  return isTextSourcePath(item.source_path)
}

export type NoteFinalCode = 'note_final_not_text' | 'note_final_unreadable' | 'note_final_pdf_failed' | 'note_final_save_failed' | 'note_final_already_done'

export type NoteFinalOutcome =
  | { ok: true; item: WorkItemRow; asset_path: string; asset_name: string }
  | { ok: false; code: NoteFinalCode; detail: string | null }

export async function finalizeTextItem(item: WorkItemRow, input: { by: string | null }): Promise<NoteFinalOutcome> {
  if (!item.source_path || !isTextSourcePath(item.source_path)) return { ok: false, code: 'note_final_not_text', detail: null }
  if (item.status === 'done') return { ok: false, code: 'note_final_already_done', detail: null }
  const abs = resolveLifePath(item.source_path)
  let text: string
  try {
    if (!abs) return { ok: false, code: 'note_final_unreadable', detail: null }
    text = readFileSync(abs, 'utf-8')
  } catch (e) {
    return { ok: false, code: 'note_final_unreadable', detail: e instanceof Error ? e.message : String(e) }
  }
  const stem = fileStem(basename(item.source_path).replace(/\.[^.]+$/, ''))
  const r = await renderFodtPdf(buildTextFodt(text, stem), PDF_FILTER_FINAL)
  if (!r.ok) return { ok: false, code: 'note_final_pdf_failed', detail: r.detail ?? r.code }
  const saved = attachAsset(item, `${stem}.pdf`, r.pdf, { force: true, createdBy: input.by, into: 'finished' })
  if (!saved.ok) return { ok: false, code: 'note_final_save_failed', detail: saved.code }
  const done = finalizeWorkItem(item.id, { by: input.by || 'dashboard' })
  if (!done.ok) return { ok: false, code: 'note_final_already_done', detail: done.code }
  return { ok: true, item: getWorkItem(item.id) ?? done.item, asset_path: saved.asset.path, asset_name: saved.asset.name }
}
