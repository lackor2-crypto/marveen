/**
 * WHAT THE DOCUMENT PAGE HOLDS, FOR THE READERS THAT ARE NOT THE PAGE (#792).
 *
 * A document written on the document page (a court document, or a note / Word file read onto it) keeps its text in the
 * page's own store (sections + blocks), not in the old "parts". The project search and the handoff package read only the
 * parts, so a written submission was "empty" for them. They read the page through here instead: one reader, so a fix to
 * how the page is read reaches every one of them.
 */
import { basename } from 'node:path'
import { hasDocModel, imageBlockParts, listBlocks, listSections, tableBlockParts, type BlockKind } from './workbench-docmodel.js'
import { finalState } from './workbench-docfinal.js'
import { noteFinalPdf } from './workbench-notefinal.js'
import { docxFinalState } from './workbench-docxfinal.js'
import type { WorkItemRow } from './workbench.js'

export interface DocPageSection {
  id: string
  title: string
  updated_at: number
  blocks: DocPageBlock[]
}

export interface DocPageBlock {
  id: string
  kind: BlockKind
  /** The block's plain text; for a table its rows (cells joined by " | "), without the size suffix; empty for a picture. */
  text: string
  /** A picture block: the picture's path under the Marveen folder, without the size suffix. */
  image: string | null
  updated_at: number
}

/** The page of a document-page item, or null when the item is not on the document page. */
export function docPageContent(itemId: string): DocPageSection[] | null {
  if (!hasDocModel(itemId)) return null
  const blocks = listBlocks(itemId)
  return listSections(itemId).map((s) => ({
    id: s.id,
    title: s.title,
    updated_at: s.updated_at,
    blocks: blocks.filter((b) => b.section_id === s.id).map((b) => ({
      id: b.id,
      kind: b.kind,
      text: b.kind === 'image' ? '' : b.kind === 'table' ? tableBlockParts(b.text).text : b.text,
      image: b.kind === 'image' ? imageBlockParts(b.text).path || null : null,
      updated_at: b.updated_at,
    })),
  }))
}

export interface DocPageFinalFile {
  /** The file's path under the Marveen folder. */
  rel: string
  name: string
}

export interface DocPageFinal {
  /** "Végleges -- <date>" of a court final; null for an item finalized with its old note / Word panel (before #777). */
  label: string | null
  /** The document changed since: the files show an older text. */
  stale: boolean
  files: DocPageFinalFile[]
}

/**
 * The files of the item's newest final: the court final's saved files (the submission, or the combined file, and the
 * annexes it saved), or the PDF an older note / Word finalize left in Finished materials. Null = never finalized.
 */
export function docPageFinal(item: WorkItemRow): DocPageFinal | null {
  const fin = finalState(item)
  if (fin) {
    const list = fin.files && fin.files.length ? fin.files : [{ path: fin.pdf_path, name: fin.pdf_name }]
    return { label: fin.label, stale: fin.stale, files: list.filter((f) => !!f.path).map((f) => ({ rel: f.path, name: f.name || basename(f.path) })) }
  }
  if (item.status !== 'done') return null
  const legacy = noteFinalPdf(item) ?? docxFinalState(item)
  return legacy ? { label: null, stale: legacy.stale, files: [{ rel: legacy.path, name: legacy.name }] } : null
}
