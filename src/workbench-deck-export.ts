/**
 * Export of a presentation deck to a PPTX or a PDF file in the project folder
 * (v4 spec phase 5). The PPTX is built natively (`workbench-deck-pptx.ts`); the
 * PDF is that same file converted by LibreOffice, so both show the same slides.
 * A NEW file every time: nothing is overwritten (the free-name search adds " (2)").
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProjectRow } from './projects.js'
import { writeProjectFile } from './project-files.js'
import { itemOutputFolder } from './workbench-assets.js'
import type { WorkItemRow } from './workbench.js'
import { convertOfficeToPdf } from './office-convert.js'
import { readCanvasImageFile } from './workbench-canvas-store.js'
import { buildDeckPptx, type PptxImage } from './workbench-deck-pptx.js'
import type { DeckDoc } from './workbench-deck.js'

export type DeckExportFormat = 'pptx' | 'pdf'
export const DECK_EXPORT_FORMATS: readonly DeckExportFormat[] = ['pptx', 'pdf']

export type DeckExportResult =
  | { ok: true; file: { rel: string; name: string; bytes: number }; format: DeckExportFormat; slides: number; warnings: string[] }
  | { ok: false; code: string; detail: string | null }

/** `Nyari plakat` -> `nyari-plakat`; the deck's title as a file name stem. */
function stem(title: string): string {
  const base = String(title ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)
  return base || 'prezentacio'
}

export async function exportDeck(
  project: ProjectRow, item: Pick<WorkItemRow, 'title' | 'folder' | 'container_folder' | 'source_path'>, deckRel: string | null, deck: DeckDoc, format: DeckExportFormat,
): Promise<DeckExportResult> {
  if (!deck.slides.length) return { ok: false, code: 'deck_export_empty', detail: null }
  const loadImage = (src: string): PptxImage | null => {
    const r = readCanvasImageFile(project, src)
    return r.ok ? { bytes: r.bytes, mime: r.mime } : null
  }
  let built: ReturnType<typeof buildDeckPptx>
  try { built = buildDeckPptx(deck, loadImage) } catch (e) {
    return { ok: false, code: 'deck_export_failed', detail: e instanceof Error ? e.message : String(e) }
  }
  let bytes = built.bytes
  if (format === 'pdf') {
    // LibreOffice reads a file, so the PPTX goes to a private temporary folder first.
    const tmp = mkdtempSync(join(tmpdir(), 'wbdeck'))
    try {
      const src = join(tmp, `${stem(item.title)}.pptx`)
      writeFileSync(src, built.bytes)
      const r = await convertOfficeToPdf(src, { timeoutMs: 240_000 })
      if (!r.ok) return { ok: false, code: `deck_pdf_${r.code}`, detail: r.detail || null }
      bytes = readFileSync(r.pdf)
    } finally {
      try { rmSync(tmp, { recursive: true, force: true }) } catch { /* the temporary folder is cleaned by the system later */ }
    }
  }
  // #496: into the item's own folder (else beside the deck file, else the work-items box), never the project root.
  const out = writeProjectFile(project, itemOutputFolder(project, item, deckRel), `${stem(item.title)}.${format}`, bytes)
  if (!out.ok) return { ok: false, code: out.code === 'write_failed' ? 'deck_export_failed' : out.code, detail: out.message || null }
  return { ok: true, file: { rel: out.rel, name: out.name, bytes: out.bytes }, format, slides: deck.slides.length, warnings: built.warnings }
}
