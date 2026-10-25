/**
 * TEXT-FILE WORK ITEMS (.md / .txt): what is left of the old note finalize (kanban #667).
 *
 * #777 / #803 (Boss TG: "egy helyen javitunk, mindenhol javitva van"): a note is read onto the document page and finalized
 * there by the court document's own finalize (workbench-docfinal.ts); the separate note PDF finalize is gone. This module
 * only keeps the file-kind test and the reader of a final PDF the old panel made (an item finalized before #777).
 */
import { statSync } from 'node:fs'
import { basename } from 'node:path'
import { resolveLifePath } from './life-explorer.js'
import { listWorkItemAssets } from './workbench-assets.js'
import { fileStem } from './workbench-docfinal.js'
import { type WorkItemRow } from './workbench.js'
import { documentOutline, hasDocModel } from './workbench-docmodel.js'

/** True when the file is a plain text / Markdown file: the kind that has no outline of its own. */
export function isTextSourcePath(rel: string | null | undefined): boolean {
  return /\.(md|markdown|txt)$/i.test(rel || '')
}

/** A text-file item: the kind that is read onto the document page and finalized there (#777 / #803). */
export function hasTextFinalPanel(item: Pick<WorkItemRow, 'source_path'>): boolean {
  return isTextSourcePath(item.source_path)
}

/**
 * #783: the final PDF the note finalize left in Finished materials (an item finalized before #777, when the note had its own
 * finalize), for the project close check: its name, and whether the text changed since it was made. Null = there is none.
 */
export function noteFinalPdf(item: WorkItemRow): { name: string; path: string; stale: boolean } | null {
  if (!item.source_path || !isTextSourcePath(item.source_path)) return null
  const pdfName = `${fileStem(basename(item.source_path).replace(/\.[^.]+$/, ''))}.pdf`
  const base = pdfName.replace(/\.pdf$/i, '')
  const rows = listWorkItemAssets(item.id).filter((a) => a.present && (a.name === pdfName || new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(\\d+\\)\\.pdf$`, 'i').test(a.name)))
  const last = rows[rows.length - 1]
  if (!last) return null
  return { name: last.name, path: last.path, stale: !unchangedFinalPdf(item, pdfName) }
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
