/**
 * #590 (Boss, TG 9007): the document page shows, with a dashed horizontal line, WHERE the next page of the PDF begins --
 * "ha szaggatott vonal ala kerul valami iras, akkor tudom, hogy feljebb kell rakni". The editor sheet is not as tall as
 * the PDF page, so the place cannot be computed from the screen: it is MEASURED on the real draft PDF. The PDF is rendered
 * the way the draft button renders it (same source, same cache), its text is read page by page, and every block of the
 * document is looked up in that text, in order. The answer is "page N begins at / inside block X".
 *
 * Text matching is on letters and digits only (bullets, quotes, hyphens and line wrapping differ between the model and the
 * PDF), by the first and the last characters of a block. A block that cannot be found (a picture, a table the PDF text
 * reads column-wise) is skipped; the next one carries on from the same place, so one miss never moves the other lines.
 */
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { documentOutline, isPlaceholderSectionTitle, tableBlockParts } from './workbench-docmodel.js'
import { documentAuthor, docLangFor, docMetaTitle, contentHash, renderInputFor } from './workbench-docfinal.js'
import { renderOutlinePdf } from './workbench-docrender.js'
import { FIT_MAX_LEVEL, fitOf, saveFit } from './workbench-docfit.js'
import type { WorkItemRow } from './workbench.js'

const run = promisify(execFile)

/** How many normalized characters of a block's start / end are looked up (long enough to be unique, short enough to survive a page break inside it). */
export const PAGE_MATCH_CHARS = 28
/** A block is looked for at most this many pages after the previous one (a stray equal text far away must not drag the cursor along). */
const PAGE_SEARCH_AHEAD = 3

export interface PageUnit { id: string; text: string; kind: 'section' | 'block' }
/** `at`: the page begins right before this unit (`inside` false), or inside it (the unit goes on over the line). */
export interface PageMark { id: string; page: number; inside: boolean }

/** Letters and digits only, lower case: what stays the same between the model's text and the PDF's text layer. */
export function pageNorm(s: string): string {
  return String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

/** Where a unit of the document is in the PDF text: the page (0-based) of its first and of its last characters. */
export function matchPages(pages: string[], units: PageUnit[]): PageMark[] {
  const norm = pages.map(pageNorm)
  let cp = 0
  let cpos = 0
  const find = (needle: string, from: number, pos: number): { page: number; at: number } | null => {
    for (let p = from; p < norm.length && p <= from + PAGE_SEARCH_AHEAD; p++) {
      const i = (norm[p] as string).indexOf(needle, p === from ? pos : 0)
      if (i >= 0) return { page: p, at: i }
    }
    return null
  }
  const spans: { id: string; start: number; end: number }[] = []
  for (const u of units) {
    const n = pageNorm(u.text)
    if (!n) continue
    const head = find(n.slice(0, PAGE_MATCH_CHARS), cp, cpos)
    if (!head) continue
    cp = head.page
    cpos = head.at + Math.min(n.length, PAGE_MATCH_CHARS)
    let endPage = head.page
    if (n.length > PAGE_MATCH_CHARS * 2) {
      const tailNeedle = n.slice(-PAGE_MATCH_CHARS)
      const tail = find(tailNeedle, cp, cpos)
      if (tail) { endPage = tail.page; cp = tail.page; cpos = tail.at + tailNeedle.length }
    }
    spans.push({ id: u.id, start: head.page, end: endPage })
  }
  const marks: PageMark[] = []
  let seen = 0
  for (const s of spans) {
    if (s.start > seen) marks.push({ id: s.id, page: s.start + 1, inside: false })
    if (s.end > s.start) marks.push({ id: s.id, page: s.end + 1, inside: true })
    seen = Math.max(seen, s.end)
  }
  return marks
}

/** The units of a rendered outline, in reading order: a chapter title, then its blocks (a table by the first cell of each row, a picture not at all). */
export function pageUnitsOf(sections: { id: string; title: string; blocks: { id: string; kind: string; text: string }[] }[]): PageUnit[] {
  const out: PageUnit[] = []
  for (const s of sections) {
    if (!isPlaceholderSectionTitle(s.title)) out.push({ id: s.id, text: s.title, kind: 'section' })
    for (const b of s.blocks) {
      if (b.kind === 'image') continue
      if (b.kind === 'table') {
        // Every ROW is a unit of its own (owner report 2026-11-09: a table that runs over several PDF pages showed no page
        // lines inside it, so the sheet's pages came out wrong). The first row carries the block's id, the later rows
        // `<block id>#r<row index>`; a row is looked up by its first filled cell.
        const rows = tableBlockParts(b.text).text.split('\n')
        rows.forEach((row, r) => {
          const cell = row.split('|').map((c) => c.trim()).find((c) => c) || ''
          if (r === 0 || cell) out.push({ id: r === 0 ? b.id : `${b.id}#r${r}`, text: cell, kind: 'block' })
        })
        continue
      }
      out.push({ id: b.id, text: b.text, kind: 'block' })
    }
  }
  return out
}

export type PageBreaksResult =
  | { ok: true; pages: number; marks: PageMark[] }
  | { ok: false; code: string; detail: string | null }

/** The text of every page of a PDF (poppler's pdftotext puts a form feed after each page). */
export async function pdfPageTexts(pdf: Buffer): Promise<{ ok: true; pages: string[] } | { ok: false; detail: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'marveen-pagebreaks-'))
  try {
    const file = join(dir, 'doc.pdf')
    writeFileSync(file, pdf)
    const r = await run('pdftotext', ['-q', '-enc', 'UTF-8', file, '-'], { maxBuffer: 32 * 1024 * 1024, timeout: 60_000 })
    const pages = String(r.stdout).split('\f')
    if (pages.length && !pages[pages.length - 1]!.trim()) pages.pop()
    return { ok: true, pages }
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) }
  } finally {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* a temp dir in /tmp */ }
  }
}

/** Where the pages of the draft PDF begin, in terms of the document's own chapters and blocks. */
export async function pageBreaksFor(item: WorkItemRow, lang: 'hu' | 'en'): Promise<PageBreaksResult> {
  const outline = renderInputFor(item, true)
  const r = await renderOutlinePdf(outline, { title: docMetaTitle(item, lang), author: documentAuthor(), draft: true, lang: docLangFor(item, lang) })
  if (!r.ok) return { ok: false, code: r.code, detail: r.detail }
  const t = await pdfPageTexts(r.pdf)
  if (!t.ok) return { ok: false, code: 'pdftotext_failed', detail: t.detail }
  // The render input carries no ids; the model's own outline lists the same chapters and blocks in the same order.
  return { ok: true, pages: t.pages.length, marks: matchPages(t.pages, pageUnitsOf(documentOutline(item.id).sections)) }
}

export interface FitResult { level: number; source_pages: number; pages: number; fits: boolean }

async function pageCountOf(item: WorkItemRow, lang: 'hu' | 'en', level: number): Promise<number | null> {
  const r = await renderOutlinePdf(renderInputFor(item, true, level), { title: docMetaTitle(item, lang), author: documentAuthor(), draft: true, lang: docLangFor(item, lang) })
  if (!r.ok) return null
  const t = await pdfPageTexts(r.pdf)
  return t.ok ? t.pages.length : null
}

/**
 * #856: the gentlest tightening step (workbench-docfit.ts) at which the language version has no more pages than its original.
 * The result is stored per version, together with a fingerprint of both texts, so it is measured again only when one of them
 * changed. Null when the pages cannot be counted (the caller then draws the version as it is).
 */
export async function fitVariantToSource(source: WorkItemRow, variant: WorkItemRow, lang: 'hu' | 'en'): Promise<FitResult | null> {
  const hash = `${contentHash(source)}|${contentHash(variant)}`
  const cur = fitOf(variant.id)
  if (cur && cur.hash === hash) return { level: cur.level, source_pages: cur.source_pages, pages: cur.pages, fits: !!cur.fits }
  const srcPages = await pageCountOf(source, lang, 0)
  if (!srcPages) return null
  let best: FitResult | null = null
  for (let level = 0; level <= FIT_MAX_LEVEL; level++) {
    const pages = await pageCountOf(variant, lang, level)
    if (!pages) return null
    best = { level, source_pages: srcPages, pages, fits: pages <= srcPages }
    if (best.fits) break
  }
  if (!best) return null
  saveFit(variant.id, { hash, ...best })
  return best
}
