/**
 * #508 (Boss TG 2920/2925, decision TG 2943): a file dropped onto a document's page is either BUILT INTO the
 * page or attached as an annex -- the owner picks. What can be built in (the usual editor behaviour: Word /
 * Google Docs take a picture as a picture, a spreadsheet as a table, a text document as its text):
 *   - picture (jpg, png, gif)          -> one `image` block
 *   - spreadsheet (xlsx, xlsm, csv, tsv) -> one `table` block per non-empty sheet (a sheet title before it when there are more)
 *   - text document (docx, odt, txt, md) -> its paragraphs as `paragraph` blocks, its tables as `table` blocks
 * Anything else (video, zip, pdf, ...) can only be an annex. Pure: bytes in, blocks out.
 */
import { extname } from 'node:path'
import { readTable, readZip, xmlUnescape } from './workbench-table.js'
import { BLOCK_TEXT_MAX, DOC_IMAGE_EXT, type BlockKind } from './workbench-docmodel.js'

export type EmbedKind = 'image' | 'table' | 'text'

/** At most this many blocks come from one file (a whole book dropped on a letter is a mistake, not a wish). */
export const EMBED_MAX_BLOCKS = 300
/** A table block keeps at most this many rows; the rest stays in the file (which is shown as truncated). */
export const EMBED_MAX_TABLE_ROWS = 200

const TABLE_EXT = new Set(['xlsx', 'xlsm', 'csv', 'tsv'])
const TEXT_EXT = new Set(['docx', 'odt', 'txt', 'md'])

export function embedKind(name: string): EmbedKind | null {
  const e = extname(String(name || '')).slice(1).toLowerCase()
  if (DOC_IMAGE_EXT.has(e)) return 'image'
  if (TABLE_EXT.has(e)) return 'table'
  if (TEXT_EXT.has(e)) return 'text'
  return null
}

export type EmbedBlock = { kind: BlockKind; text: string }
export type EmbedResult =
  | { ok: true; blocks: EmbedBlock[]; truncated: boolean }
  | { ok: false; code: 'embed_unsupported' | 'embed_unreadable' | 'embed_empty'; detail?: string }

/** A grid as the `a | b | c` lines a table block holds; empty edge rows/columns dropped, `|` in a cell made safe. */
export function gridToTableText(rows: string[][], maxRows = EMBED_MAX_TABLE_ROWS): { text: string; truncated: boolean } {
  const clean = rows.map((r) => r.map((c) => String(c ?? '').replace(/\r?\n/g, ' ').replace(/\|/g, '/').trim()))
  while (clean.length && clean[clean.length - 1]!.every((c) => !c)) clean.pop()
  while (clean.length && clean[0]!.every((c) => !c)) clean.shift()
  let cols = Math.max(0, ...clean.map((r) => r.length))
  while (cols > 0 && clean.every((r) => !(r[cols - 1] ?? ''))) cols--
  let truncated = clean.length > maxRows
  const lines: string[] = []
  let size = 0
  for (const r of clean.slice(0, maxRows)) {
    const line = Array.from({ length: cols }, (_, i) => r[i] ?? '').join(' | ')
    if (size + line.length + 1 > BLOCK_TEXT_MAX) { truncated = true; break }
    lines.push(line)
    size += line.length + 1
  }
  return { text: cols ? lines.join('\n') : '', truncated }
}

/** A long paragraph split at sentence/space boundaries so every block stays under the block size limit. */
function splitLong(text: string): string[] {
  const out: string[] = []
  let rest = text
  while (rest.length > BLOCK_TEXT_MAX) {
    let cut = rest.lastIndexOf('. ', BLOCK_TEXT_MAX)
    if (cut < BLOCK_TEXT_MAX / 2) cut = rest.lastIndexOf(' ', BLOCK_TEXT_MAX)
    if (cut < BLOCK_TEXT_MAX / 2) cut = BLOCK_TEXT_MAX - 1
    out.push(rest.slice(0, cut + 1).trim())
    rest = rest.slice(cut + 1)
  }
  if (rest.trim()) out.push(rest.trim())
  return out
}

/** The text of one WordprocessingML / ODF fragment: runs joined, tabs and line breaks kept. */
function runsText(xml: string, flavour: 'w' | 'odf'): string {
  const s = flavour === 'w'
    ? xml.replace(/<w:tab\/>/g, '\u0000\t\u0001').replace(/<w:br\/>|<w:cr\/>/g, '\u0000\n\u0001').replace(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g, '\u0000$1\u0001')
    : xml.replace(/<text:tab\/>/g, '\t').replace(/<text:line-break\/>/g, '\n').replace(/<text:s(?:\s+text:c="(\d+)")?\/>/g, (_m, n) => ' '.repeat(Number(n || 1)))
  if (flavour === 'w') {
    let t = ''
    const re = /\u0000([\s\S]*?)\u0001/g
    let m: RegExpExecArray | null
    while ((m = re.exec(s))) t += m[1]
    return xmlUnescape(t)
  }
  return xmlUnescape(s.replace(/<[^>]+>/g, ''))
}

function docxBlocks(buf: Buffer): EmbedBlock[] | null {
  const zip = readZip(buf)
  const doc = zip?.find((z) => z.name === 'word/document.xml')
  if (!doc) return null
  const body = doc.data.toString('utf8').replace(/^[\s\S]*?<w:body>/, '').replace(/<w:sectPr[\s\S]*$/, '')
  const out: EmbedBlock[] = []
  const re = /<w:tbl>[\s\S]*?<\/w:tbl>|<w:p[\s>][\s\S]*?<\/w:p>|<w:p\/>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(body))) {
    const x = m[0]
    if (x.startsWith('<w:tbl>')) {
      const rows = (x.match(/<w:tr[\s>][\s\S]*?<\/w:tr>/g) || []).map((tr) => (tr.match(/<w:tc[\s>][\s\S]*?<\/w:tc>/g) || []).map((tc) => runsText(tc, 'w').replace(/\s+/g, ' ').trim()))
      const t = gridToTableText(rows).text
      if (t) out.push({ kind: 'table', text: t })
      continue
    }
    const text = runsText(x, 'w').trim()
    if (!text) continue
    const list = /<w:numPr[\s>/]/.test(x)
    for (const part of splitLong(text)) out.push({ kind: list ? 'list' : 'paragraph', text: part })
  }
  return out
}

function odtBlocks(buf: Buffer): EmbedBlock[] | null {
  const zip = readZip(buf)
  const doc = zip?.find((z) => z.name === 'content.xml')
  if (!doc) return null
  const body = doc.data.toString('utf8').replace(/^[\s\S]*?<office:text[^>]*>/, '').replace(/<\/office:text>[\s\S]*$/, '')
  const out: EmbedBlock[] = []
  const re = /<table:table[\s>][\s\S]*?<\/table:table>|<text:(p|h)[\s>][\s\S]*?<\/text:\1>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(body))) {
    const x = m[0]
    if (x.startsWith('<table:table')) {
      const rows = (x.match(/<table:table-row[\s>][\s\S]*?<\/table:table-row>/g) || []).map((tr) => (tr.match(/<table:table-cell[\s>][\s\S]*?<\/table:table-cell>|<table:table-cell[^>]*\/>/g) || []).map((tc) => runsText(tc, 'odf').replace(/\s+/g, ' ').trim()))
      const t = gridToTableText(rows).text
      if (t) out.push({ kind: 'table', text: t })
      continue
    }
    const text = runsText(x, 'odf').trim()
    if (text) for (const part of splitLong(text)) out.push({ kind: 'paragraph', text: part })
  }
  return out
}

function plainBlocks(buf: Buffer): EmbedBlock[] {
  let text = buf.toString('utf8')
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  return text.replace(/\r\n?/g, '\n').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
    .flatMap((p) => splitLong(p).map((x) => ({ kind: 'paragraph' as BlockKind, text: x })))
}

/** The blocks a non-picture file becomes on the page (a picture needs no reading: its path is the block). */
export function fileToBlocks(buf: Buffer, name: string, opts: { sheetTitle?: (name: string) => string } = {}): EmbedResult {
  const kind = embedKind(name)
  if (!kind || kind === 'image') return { ok: false, code: 'embed_unsupported' }
  let blocks: EmbedBlock[] | null
  let truncated = false
  if (kind === 'table') {
    const r = readTable(buf, name)
    if (!r.ok) return { ok: false, code: 'embed_unreadable', detail: r.code }
    const sheets = r.table.sheets.map((s) => ({ name: s.name, ...gridToTableText(s.rows) })).filter((s) => s.text)
    blocks = []
    for (const s of sheets) {
      if (sheets.length > 1 && s.name) blocks.push({ kind: 'paragraph', text: opts.sheetTitle ? opts.sheetTitle(s.name) : s.name })
      blocks.push({ kind: 'table', text: s.text })
      if (s.truncated) truncated = true
    }
  } else {
    const e = extname(name).slice(1).toLowerCase()
    blocks = e === 'docx' ? docxBlocks(buf) : e === 'odt' ? odtBlocks(buf) : plainBlocks(buf)
    if (!blocks) return { ok: false, code: 'embed_unreadable' }
  }
  if (!blocks.length) return { ok: false, code: 'embed_empty' }
  if (blocks.length > EMBED_MAX_BLOCKS) { blocks = blocks.slice(0, EMBED_MAX_BLOCKS); truncated = true }
  return { ok: true, blocks, truncated }
}
