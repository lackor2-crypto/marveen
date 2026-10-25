/**
 * WORD (.docx) WORK ITEMS: what is left of the old Word finalize (kanban #719).
 *
 * #777 / #803 (Boss TG: "egy helyen javitunk, mindenhol javitva van"): a Word file is read onto the document page and
 * finalized there by the court document's own finalize (workbench-docfinal.ts); the separate Word PDF finalize is gone.
 * This module only keeps the file-kind test and the reader of a final PDF the old panel made (an item finalized before
 * #777): the project close check (#783) and the e-mail draft (#723) still find it.
 */
import { statSync } from 'node:fs'
import { resolveLifePath } from './life-explorer.js'
import { fileStem } from './workbench-docfinal.js'
import { type WorkItemRow } from './workbench.js'
import { listWorkItemAssets } from './workbench-assets.js'
import { basename } from 'node:path'

const SUFFIX = { hu: 'végleges', en: 'final' } as const

const stemOf = (item: WorkItemRow): string => fileStem(basename(item.source_path as string).replace(/\.[^.]+$/, ''))

/** A Word (.docx) item: the kind whose old-panel final PDF is still read (#783, #723). */
export function hasDocxFinalPanel(item: Pick<WorkItemRow, 'source_path'>): boolean {
  return !!item.source_path && /\.docx$/i.test(item.source_path)
}

/**
 * #783: the final PDF the Word finalize left (an item finalized before #777), for the project close check: its name, and
 * whether the Word file changed since it was made. Null = there is none.
 */
export function docxFinalState(item: WorkItemRow): { name: string; path: string; stale: boolean } | null {
  if (!hasDocxFinalPanel(item)) return null
  const pdf = docxFinalPdf(item)
  if (!pdf) return null
  const src = item.source_path ? resolveLifePath(item.source_path) : null
  let stale = false
  try { if (src) stale = statSync(pdf.abs).mtimeMs < statSync(src).mtimeMs } catch { /* an unreadable file: not called stale */ }
  return { name: pdf.name, path: pdf.rel, stale }
}

/**
 * The newest final PDF of the item (registered by the finalize), or null. Both languages' names count: the page language
 * may have changed since the finalize. The e-mail draft (workbench-maildraft.ts, #723) attaches it.
 */
export function docxFinalPdf(item: WorkItemRow): { abs: string; rel: string; name: string } | null {
  const bases = Object.values(SUFFIX).map((s) => `${stemOf(item)} - ${s}`)
  const rows = listWorkItemAssets(item.id).filter((a) => a.present && bases.some((b) => a.name.startsWith(b)) && /\.pdf$/i.test(a.name))
  const last = rows[rows.length - 1]
  if (!last) return null
  const abs = resolveLifePath(last.path)
  return abs ? { abs, rel: last.path, name: last.name } : null
}
