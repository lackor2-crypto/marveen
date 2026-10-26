/**
 * ONE DOCUMENT EDITOR: A WORD FILE ON THE COURT DOCUMENT PAGE (kanban #720, Boss TG 3877-3886).
 *
 * Boss: "mindenfele dokumentumot az a birosagi resz kezelne le, igy csak egy helyen lenne az egesz." Decision 1A + 2A:
 * a .docx / .doc / .odt / .rtf work item opens on the SAME page as a court document (the text profile of #673 hides the
 * court-only parts), and saving updates the same work item and the same file -- no "(2).docx" per save; the old state is
 * the previous version in the version bar.
 *
 * The way in: LibreOffice turns the file into HTML (the same export the Word editor used, pictures embedded), and this
 * module reads that HTML into the page's outline: headings -> chapters, paragraphs (bold / italic / underline / strike,
 * font, size, colour, alignment), lists, tables, pictures. #781 (the owner's decision 2B): nothing is written beside the
 * file any more -- no "X (2).docx" copy, no "X - kép 1.png" -- because the owner tidies those away as clutter and the item
 * then silently lost its file (the Sozialamt item, 2026-10-20). The pictures and the state the file had before the page
 * wrote it go to Marveen's own place in the tree (`wordStoreDir`, under the System branch the owner does not work in),
 * the state before is the previous version there, and the page writes (through the mirror, `workbench-docmirror.ts`)
 * into the owner's own .docx. A .doc / .odt / .rtf file is not overwritten: the page writes a .docx beside it.
 *
 * What the page cannot hold (header / footer, text box, columns, footnotes, a picture in an unknown format) is not
 * silently dropped: it is listed as a warning the page shows, and the original file stays in the version history.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { APP_LANG } from './config.js'
import { getDb } from './db.js'
import { resolveLifePath } from './life-explorer.js'
import { lifeName } from './life-tree.js'
import { writeBlockReason } from './git-guard.js'
import { safeFileName } from './project-files.js'
import { getProject } from './projects.js'
import { docEditExt, docToEditableHtml } from './workbench-docedit.js'
import { fileStem, renderDocx } from './workbench-docfinal.js'
import { seedMirrorRow, scheduleOutlineMirror } from './workbench-docmirror.js'
import {
  BLANK_LINE, BLOCK_TEXT_MAX, BLOCKS_MAX, OVER_Y_MAX, PLACEHOLDER_SECTION_TITLES, SECTION_TITLE_MAX, addSection, documentOutline,
  hasDocModel, replacePage, type PageSectionIn,
} from './workbench-docmodel.js'
import { richMatches, richToPlain, sanitizeRich } from './workbench-docrich.js'
import { saveBytesAsNewVersion } from './workbench-edit.js'
import { createWorkItemVersion, deleteWorkItemVersion, getWorkItem, getWorkItemVersion, versionLoadedOnDelete, type WorkItemRow, type WorkItemVersionRow } from './workbench.js'

export type WordDocCode = 'worddoc_not_word' | 'worddoc_unreadable' | 'worddoc_convert_failed' | 'worddoc_project_gone' | 'worddoc_save_failed' | 'worddoc_import_failed'

/** What did not come over from the file (the page lists them; the original file stays in the version history). */
export const WORD_WARNINGS = ['header_footer', 'text_box', 'columns', 'footnotes', 'images_skipped', 'nested_tables', 'too_long'] as const
export type WordWarning = typeof WORD_WARNINGS[number]

export type WordImportOutcome =
  | { ok: true; item: WorkItemRow; imported: boolean; warnings: WordWarning[] }
  | { ok: false; code: WordDocCode; detail: string | null }

/** The width of the text on an A4 page with 2.54 cm margins (what LibreOffice writes by default), in cm and in CSS px. */
const TEXT_WIDTH_CM = 15.92

function ensureWordTable(): void {
  getDb().exec(`CREATE TABLE IF NOT EXISTS wb_word_import (
    work_item_id TEXT PRIMARY KEY,
    warnings TEXT NOT NULL DEFAULT '[]',
    imported_at INTEGER NOT NULL
  )`)
}

/** Was this item read in from a Word file (it then mirrors into its own .docx and takes the text profile)? */
export function isWordImported(itemId: string): boolean {
  ensureWordTable()
  return !!getDb().prepare('SELECT 1 FROM wb_word_import WHERE work_item_id = ?').get(itemId)
}

/** The warnings of the import still shown on the page ([] once the owner closed them). */
export function wordImportWarnings(itemId: string): WordWarning[] {
  ensureWordTable()
  const row = getDb().prepare('SELECT warnings FROM wb_word_import WHERE work_item_id = ?').get(itemId) as { warnings: string } | undefined
  if (!row) return []
  try {
    const v = JSON.parse(row.warnings) as unknown
    return Array.isArray(v) ? v.filter((w): w is WordWarning => (WORD_WARNINGS as readonly string[]).includes(String(w))) : []
  } catch { return [] }
}

export function dismissWordWarnings(itemId: string): void {
  ensureWordTable()
  getDb().prepare(`UPDATE wb_word_import SET warnings = '[]' WHERE work_item_id = ?`).run(itemId)
}

function markImported(itemId: string, warnings: WordWarning[]): void {
  ensureWordTable()
  getDb().prepare(`INSERT INTO wb_word_import (work_item_id, warnings, imported_at) VALUES (?, ?, ?)
    ON CONFLICT(work_item_id) DO UPDATE SET warnings = excluded.warnings, imported_at = excluded.imported_at`)
    .run(itemId, JSON.stringify(warnings), Date.now())
}

/**
 * A document work item whose file is a Word-like document, not yet on the page (or read in by this module before).
 * A court document that has its own page AND a .docx path from elsewhere is left alone: its page is the source already.
 */
export function isWordProfileCandidate(item: Pick<WorkItemRow, 'id' | 'type' | 'source_path' | 'deleted_at'>): boolean {
  if (item.type !== 'document' || item.deleted_at || !docEditExt(item.source_path)) return false
  return !hasDocModel(item.id) || isWordImported(item.id)
}

// ---- HTML -> page -------------------------------------------------------------------------------

const TOKEN_RE = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b((?:[^>"']|"[^"]*"|'[^']*')*)>|([^<]+)/g
const INLINE_KEEP = new Set(['b', 'strong', 'i', 'em', 'u', 's', 'strike', 'del', 'span', 'font'])
const SKIP_CONTENT = new Set(['head', 'style', 'script', 'title', 'sdfield'])

function attr(attrs: string, name: string): string | null {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(attrs)
  return m ? (m[1] ?? m[2] ?? m[3] ?? '') : null
}

function styleOf(attrs: string, prop: string): string | null {
  const st = attr(attrs, 'style')
  if (!st) return null
  const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, 'i').exec(st)
  return m ? (m[1] as string).trim() : null
}

/** A CSS length in cm (cm, mm, in, pt, px); null when it is not one. */
function cmOf(v: string | null): number | null {
  const m = /^(-?[\d.]+)\s*(cm|mm|in|pt|px)?$/i.exec(String(v ?? '').trim())
  if (!m) return null
  const n = Number(m[1])
  if (!Number.isFinite(n)) return null
  const unit = (m[2] || 'px').toLowerCase()
  return unit === 'cm' ? n : unit === 'mm' ? n / 10 : unit === 'in' ? n * 2.54 : unit === 'pt' ? n / 72 * 2.54 : n / 96 * 2.54
}

function alignOf(attrs: string): 'c' | 'r' | 'j' | '' {
  const a = (styleOf(attrs, 'text-align') || attr(attrs, 'align') || '').toLowerCase()
  return a === 'center' ? 'c' : a === 'right' ? 'r' : a === 'justify' ? 'j' : ''
}

function decodeText(s: string): string {
  return s.replace(/&nbsp;|&#160;|&#xa0;/gi, ' ')
}

function placeholderTitle(): string {
  return APP_LANG === 'en' ? PLACEHOLDER_SECTION_TITLES[1] as string : PLACEHOLDER_SECTION_TITLES[0] as string
}

/** One picture found in the file: its bytes (from the embedded data: address) and how it stood on the page. */
export interface WordPicture { mime: string; data: Buffer; widthCm: number | null; align: 'l' | 'c' | 'r'; over: { x: number; y: number } | null }

interface ParsedBlock { kind: 'paragraph' | 'list' | 'table' | 'image'; text: string; rich?: string; align?: string; picture?: WordPicture }
export interface ParsedWord { sections: { title: string; blocks: ParsedBlock[] }[]; warnings: WordWarning[] }

const PICTURE_MIME: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }

/**
 * The LibreOffice HTML of a Word document as the page's sections. Pure (no files): a picture is returned with its bytes,
 * the caller writes it. What is not understood stays as paragraph text, so no words can vanish.
 */
export function parseWordHtml(html: string): ParsedWord {
  const warnings = new Set<WordWarning>()
  const sections: ParsedWord['sections'] = []
  let cur: ParsedWord['sections'][number] | null = null
  const section = (): ParsedWord['sections'][number] => {
    if (!cur) { cur = { title: placeholderTitle(), blocks: [] }; sections.push(cur) }
    return cur
  }

  const src = String(html ?? '')
  const bodyAt = src.search(/<body\b/i)
  const body = bodyAt >= 0 ? src.slice(bodyAt) : src
  if (/<div\b[^>]*\btitle\s*=\s*"?(header|footer)/i.test(body)) warnings.add('header_footer')
  if (/column-count|<multicol\b/i.test(body)) warnings.add('columns')

  // The capture: the paragraph / heading / list item / table cell being read.
  type Capture = { kind: 'p' | 'h' | 'li' | 'cell'; buf: string; align: string; pics: WordPicture[]; lineStart: boolean; space: boolean }
  let cap = null as Capture | null
  const skip: string[] = []            // open tags whose content is not read (head, header, footnote, ...)
  const divs: boolean[] = []           // per open <div>: does it skip its content
  // #782: a list item keeps its formatting (`rich`, '' = none); `nested` = a line of an inner list, already indented and numbered.
  type ListLine = { text: string; rich: string; nested: boolean }
  const lists: { ordered: boolean; items: ListLine[] }[] = []
  let table = null as { rows: string[][]; depth: number } | null
  let afterImg = false
  // #777 follow-up: LibreOffice writes a run of "Preformatted Text" paragraphs (a .txt saved as Word) as ONE <pre> with a
  // line end per paragraph. Inside it every line is its own paragraph again (null = not in a <pre>; true = before its first text).
  let pre = null as boolean | null

  const open = (kind: 'p' | 'h' | 'li' | 'cell', attrs: string): void => {
    cap = { kind, buf: '', align: alignOf(attrs), pics: [], lineStart: true, space: false }
  }
  const text = (raw: string): void => {
    if (!cap) {
      if (!raw.trim() || table) return
      open('p', '')
    }
    const c = cap as Capture
    let t = decodeText(raw).replace(/\s+/g, ' ')
    // LibreOffice breaks the line right after a picture: that break is not a space in the text ("B<img>\n\nakos").
    if (afterImg && /^\s/.test(raw)) t = t.replace(/^ /, '')
    afterImg = false
    if (c.lineStart || c.space) t = t.replace(/^ /, '')
    if (!t) return
    c.buf += t.replace(/[<>]/g, (ch) => (ch === '<' ? '&lt;' : '&gt;'))
    c.lineStart = false
    c.space = t.endsWith(' ')
  }
  const preText = (raw: string): void => {
    // HTML drops the one line end right after <pre>.
    const lines = (pre ? raw.replace(/^\r?\n/, '') : raw).split(/\r?\n/)
    pre = false
    lines.forEach((line, i) => {
      if (i > 0) { flush(); open('p', '') }
      if (!cap) open('p', '')
      text(line)
    })
  }
  const picture = (attrs: string): void => {
    afterImg = true
    const srcAttr = attr(attrs, 'src') || ''
    const m = /^data:([^;,]+);base64,([\s\S]*)$/i.exec(srcAttr.trim())
    const ext = m ? PICTURE_MIME[(m[1] as string).toLowerCase()] : undefined
    if (!m || !ext) { warnings.add('images_skipped'); return }
    let data: Buffer
    try { data = Buffer.from((m[2] as string).replace(/\s+/g, ''), 'base64') } catch { warnings.add('images_skipped'); return }
    if (!data.length) { warnings.add('images_skipped'); return }
    const widthCm = cmOf(styleOf(attrs, 'width')) ?? cmOf(attr(attrs, 'width'))
    const fl = (styleOf(attrs, 'float') || attr(attrs, 'align') || '').toLowerCase()
    const pAlign = cap && cap.align === 'c' ? 'c' : cap && cap.align === 'r' ? 'r' : 'l'
    const align: 'l' | 'c' | 'r' = fl === 'right' ? 'r' : fl === 'left' ? 'l' : pAlign
    let over: WordPicture['over'] = null
    if ((styleOf(attrs, 'position') || '').toLowerCase() === 'absolute') {
      const left = cmOf(styleOf(attrs, 'left')) ?? 0
      const top = cmOf(styleOf(attrs, 'top')) ?? 0
      over = { x: Math.max(0, Math.round(left / TEXT_WIDTH_CM * 1000) / 10), y: Math.max(0, Math.min(OVER_Y_MAX, Math.round(top / TEXT_WIDTH_CM * 1000) / 10)) }
    }
    const pic: WordPicture = { mime: (m[1] as string).toLowerCase(), data, widthCm, align, over }
    if (cap) cap.pics.push(pic)
    else if (!table) section().blocks.push({ kind: 'image', text: '', picture: pic })
  }
  const flush = (): void => {
    const c = cap
    if (!c) return
    cap = null
    const buf = c.buf.replace(/ ((?:<\/?(?:b|strong|i|em|u|s|strike|del|span|font)\b[^>]*>)*)$/i, '$1')
    const plain = richToPlain(buf).replace(/[ \t]*\n[ \t]*/g, '\n').replace(/^\n+|\n+$/g, '').trim()
    if (c.kind === 'h') {
      if (plain) { cur = { title: plain.replace(/\s*\n\s*/g, ' ').slice(0, SECTION_TITLE_MAX), blocks: [] }; sections.push(cur) }
    } else if (c.kind === 'li') {
      const l = lists[lists.length - 1]
      if (l && plain) {
        const one = plain.replace(/\s*\n\s*/g, ' ')
        const rich = one === plain ? sanitizeRich(buf) : ''
        l.items.push({ text: one, rich: rich && richMatches(rich, one) ? rich : '', nested: false })
      }
    } else if (c.kind === 'cell') {
      if (table) {
        const row = table.rows[table.rows.length - 1]
        if (row) row.push(plain.replace(/\s*\n\s*/g, ' ').replace(/\|/g, '/'))
      }
    } else if (plain) {
      const rich = sanitizeRich(buf)
      const pieces = plain.length > BLOCK_TEXT_MAX ? chunk(plain) : [plain]
      for (const piece of pieces) {
        const b: ParsedBlock = { kind: 'paragraph', text: piece }
        if (pieces.length === 1 && rich && richMatches(rich, piece)) b.rich = rich
        if (c.align) b.align = c.align
        section().blocks.push(b)
      }
    } else if (!c.pics.length && c.kind === 'p') section().blocks.push({ kind: 'paragraph', text: BLANK_LINE })
    for (const pic of c.pics) section().blocks.push({ kind: 'image', text: '', picture: pic })
  }

  for (const m of body.matchAll(TOKEN_RE)) {
    const whole = m[0]
    if (whole.startsWith('<!--')) continue
    const tag = (m[2] || '').toLowerCase()
    const attrs = m[3] || ''
    const closing = m[1] === '/'
    if (!tag) {
      if (!skip.length) { if (pre !== null && !table) preText(m[4] ?? ''); else text(m[4] ?? '') }
      continue
    }
    if (skip.length) {
      // Inside skipped content only the matching close (and nested divs) count.
      if (tag === 'div') {
        if (closing) { if (divs.pop()) skip.pop() } else divs.push(false)
      } else if (closing && tag === skip[skip.length - 1]) skip.pop()
      continue
    }
    if (SKIP_CONTENT.has(tag)) { if (!closing && !/\/\s*$/.test(attrs)) skip.push(tag); continue }
    if (tag === 'a' && !closing && /sdfootnoteanc|sdendnoteanc/i.test(attrs)) { warnings.add('footnotes'); skip.push('a'); continue }
    if (tag === 'div') {
      if (closing) { flush(); if (divs.pop()) skip.pop(); continue }
      flush()
      const header = /\btitle\s*=\s*"?(header|footer)/i.test(attrs)
      const note = /\bid\s*=\s*"?sd(foot|end)note/i.test(attrs)
      if (note) warnings.add('footnotes')
      if (/\bid\s*=\s*"?(frame|text ?frame|shape)\d*/i.test(attrs) || /sd-abs-pos/i.test(attrs)) warnings.add('text_box')
      divs.push(header || note)
      if (header || note) skip.push('div')
      continue
    }
    if (/^h[1-6]$/.test(tag)) {
      if (table) continue
      flush()
      if (!closing) open('h', attrs)
      continue
    }
    if (tag === 'pre') {
      if (table) continue
      flush()
      pre = closing ? null : true
      if (!closing) open('p', attrs)
      continue
    }
    if (tag === 'p') {
      if (table) continue
      if (cap && cap.kind === 'li') continue
      flush()
      if (!closing) open('p', attrs)
      continue
    }
    if (tag === 'ol' || tag === 'ul') {
      if (table) continue
      if (!closing) {
        if (cap && cap.kind === 'li') flush()
        else flush()
        lists.push({ ordered: tag === 'ol', items: [] })
      } else {
        flush()
        const l = lists.pop()
        if (l && l.items.length) {
          // #782: only this list's own items are numbered (an inner list's lines came in already numbered and indented).
          let n = 0
          const lines = l.items.map((x) => {
            if (x.nested || !l.ordered) return x
            const mark = `${++n}. `
            return { text: mark + x.text, rich: x.rich ? mark + x.rich : '', nested: false }
          })
          const parent = lists[lists.length - 1]
          if (parent) parent.items.push(...lines.map((x) => ({ text: `  ${x.text}`, rich: x.rich ? `  ${x.rich}` : '', nested: true })))
          else {
            const t = lines.map((x) => x.text).join('\n')
            const pieces = chunk(t)
            const rich = lines.some((x) => x.rich) ? sanitizeRich(lines.map((x) => x.rich || x.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')).join('<br>')) : ''
            for (const piece of pieces) {
              const b: ParsedBlock = { kind: 'list', text: piece }
              if (pieces.length === 1 && rich && richMatches(rich, piece)) b.rich = rich
              section().blocks.push(b)
            }
          }
        }
      }
      continue
    }
    if (tag === 'li') {
      if (table) continue
      flush()
      if (!closing) open('li', attrs)
      continue
    }
    if (tag === 'table') {
      if (!closing) {
        if (table) { table.depth++; warnings.add('nested_tables'); continue }
        flush()
        table = { rows: [], depth: 1 }
      } else if (table) {
        if (--table.depth > 0) continue
        flush()
        const rows = table.rows.filter((r) => r.some((c) => c.trim()))
        table = null
        if (rows.length) section().blocks.push({ kind: 'table', text: rows.map((r) => r.join(' | ')).join('\n').slice(0, BLOCK_TEXT_MAX) })
      }
      continue
    }
    if (table && tag === 'tr') { if (!closing && table.depth === 1) { flush(); table.rows.push([]) } continue }
    if (table && (tag === 'td' || tag === 'th')) {
      if (table.depth > 1) continue
      flush()
      if (!closing) { if (!table.rows.length) table.rows.push([]); open('cell', attrs) }
      continue
    }
    if (tag === 'img') { picture(attrs); continue }
    if (tag === 'br') {
      if (cap) {
        cap.buf = cap.buf.replace(/ ((?:<\/?(?:b|strong|i|em|u|s|strike|del|span|font)\b[^>]*>)*)$/i, '$1') + '<br>'
        cap.lineStart = true
        cap.space = false
      }
      continue
    }
    if (INLINE_KEEP.has(tag) && cap) {
      cap.buf += closing ? `</${tag}>` : `<${tag}${tag === 'span' || tag === 'font' ? attrs.replace(/\/\s*$/, '') : ''}>`
      continue
    }
    if (tag === 'body' && closing) flush()
  }
  flush()
  // Empty lines at the very end (the trailing paragraph marks of a Word file) carry nothing.
  for (const s of sections) while (s.blocks.length && s.blocks[s.blocks.length - 1]?.text === BLANK_LINE) s.blocks.pop()
  let total = 0
  for (const s of sections) {
    if (total + s.blocks.length > BLOCKS_MAX) { s.blocks.length = Math.max(0, BLOCKS_MAX - total); warnings.add('too_long') }
    total += s.blocks.length
  }
  return { sections, warnings: [...warnings] }
}

function chunk(text: string): string[] {
  if (text.length <= BLOCK_TEXT_MAX) return [text]
  const out: string[] = []
  for (let i = 0; i < text.length; i += BLOCK_TEXT_MAX) out.push(text.slice(i, i + BLOCK_TEXT_MAX))
  return out
}

// ---- pictures -----------------------------------------------------------------------------------

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex')

/**
 * #781: Marveen's own place for a Word item's support files (its pictures, the states its file had before the page wrote
 * it), relative to the tree root: under the System branch, one folder per item. Inside the tree, so the page and the PDF
 * read the pictures the same way as any other, and a disk copy carries them; not in the owner's folder.
 */
export function wordStoreDir(itemId: string): string {
  return `${lifeName('system')}/${APP_LANG === 'en' ? 'Workbench' : 'Munkapad'}/${itemId}`
}

/** Is this tree path in Marveen's own Word store (not one of the owner's files)? */
export function isWordStorePath(rel: unknown): boolean {
  const r = String(rel ?? '').replace(/\\/g, '/').replace(/^\/+/, '')
  return r.startsWith(`${lifeName('system', 'hu')}/Munkapad/`) || r.startsWith(`${lifeName('system', 'en')}/Workbench/`)
}

/**
 * Writes `data` into the item's store folder under `name` and returns its tree path. The very same bytes already there
 * (any name) are reused, so reading the same file twice does not make a second copy. Null = it could not be written.
 */
function writeStoreFile(itemId: string, name: string, data: Buffer): string | null {
  const dirRel = wordStoreDir(itemId)
  if (writeBlockReason(`${dirRel}/x`)) return null
  const dirAbs = resolveLifePath(dirRel)
  if (!dirAbs) return null
  try { mkdirSync(dirAbs, { recursive: true }) } catch { return null }
  const want = sha(data)
  try {
    for (const have of readdirSync(dirAbs)) {
      const abs = join(dirAbs, have)
      try { if (!statSync(abs).isFile() || statSync(abs).size !== data.length) continue } catch { continue }
      if (sha(readFileSync(abs)) === want) return `${dirRel}/${have}`
    }
  } catch { /* an unreadable folder: write below */ }
  const clean = safeFileName(name) || 'file'
  const ext = extname(clean)
  const stem = clean.slice(0, clean.length - ext.length)
  for (let i = 1; i < 1000; i++) {
    const n = i === 1 ? clean : `${stem} (${i})${ext}`
    const abs = join(dirAbs, n)
    if (existsSync(abs)) continue
    try { writeFileSync(abs, data, { flag: 'wx' }) } catch { continue }
    return `${dirRel}/${n}`
  }
  return null
}

/** A picture of the file, in the item's store folder (#781: not beside the owner's file). */
function placePicture(itemId: string, stem: string, n: number, pic: WordPicture): string | null {
  const ext = PICTURE_MIME[pic.mime] ?? 'png'
  const word = APP_LANG === 'en' ? 'picture' : 'kép'
  return writeStoreFile(itemId, `${stem} - ${word} ${n}.${ext}`, pic.data)
}

/**
 * #781: the item's own .docx at `rel` keeps its path; the state it has now (`bytes`) becomes the PREVIOUS version, kept as a
 * copy in the item's store folder (the version bar shows it, nothing beside the owner's file). A new current version stands
 * at `rel`, which the page writes into. Returns the new version (and its item), or null (nothing changed then).
 */
function keepStateAsPrevious(
  item: WorkItemRow, rel: string, bytes: Buffer, by: string | null, edit: string, label: string, meta: Record<string, unknown> = {},
): { item: WorkItemRow; version: WorkItemVersionRow } | null {
  const ext = extname(rel) || '.docx'
  const backup = writeStoreFile(item.id, `${basename(rel, extname(rel))} - ${label}${ext}`, bytes)
  if (!backup) return null
  const db = getDb()
  const prev = item.current_version_id
  const was = prev ? (db.prepare('SELECT source_path FROM work_item_versions WHERE id = ?').get(prev) as { source_path: string | null } | undefined)?.source_path ?? null : null
  if (prev) db.prepare('UPDATE work_item_versions SET source_path = ? WHERE id = ?').run(backup, prev)
  const v = createWorkItemVersion(item.id, { source_path: rel, created_by: by, metadata_json: JSON.stringify({ edit, previous_state: backup, ...meta }) })
  if (!v.ok) {
    if (prev) db.prepare('UPDATE work_item_versions SET source_path = ? WHERE id = ?').run(was, prev)
    return null
  }
  return { item: v.item, version: v.version }
}

function imageBlockText(path: string, pic: WordPicture): string {
  const width = pic.widthCm ? Math.max(10, Math.min(100, Math.round(pic.widthCm / TEXT_WIDTH_CM * 100))) : 40
  if (pic.over) return `${path}#w=${width}&a=l&x=${Math.min(100 - width, pic.over.x)}&y=${pic.over.y}&o=1`
  return `${path}#w=${width}&a=${pic.align}`
}

/** The parsed file as the page's sections, its pictures written into the item's store folder (#781). */
function pageOf(parsed: ParsedWord, itemId: string, sourceRel: string, title: string, warnings: Set<WordWarning>): PageSectionIn[] {
  const stem = fileStem(title || basename(sourceRel, extname(sourceRel)), 80)
  let n = 0
  return parsed.sections.map((s) => ({
    title: s.title,
    blocks: s.blocks.flatMap((b) => {
      if (b.kind !== 'image') return [{ kind: b.kind, text: b.text, ...(b.rich ? { rich: b.rich } : {}), ...(b.align ? { align: b.align } : {}) }]
      const pic = b.picture as WordPicture
      const path = placePicture(itemId, stem, ++n, pic)
      if (!path) { warnings.add('images_skipped'); return [] }
      return [{ kind: 'image', text: imageBlockText(path, pic) }]
    }),
  }))
}

async function readWordFile(abs: string): Promise<{ ok: true; parsed: ParsedWord } | { ok: false; code: WordDocCode; detail: string | null }> {
  const r = await docToEditableHtml(abs)
  if (!r.ok) return { ok: false, code: 'worddoc_convert_failed', detail: r.detail ?? r.code }
  return { ok: true, parsed: parseWordHtml(r.html) }
}

/**
 * Reads a Word work item onto the document page (once: an item that has a page is left alone). #781: a .docx stays the
 * item's file and the page writes into it; its state before is the previous version, a copy in the store folder. A .doc /
 * .odt / .rtf file is left as it is (the previous version), and the page writes a .docx of the same name beside it.
 */
export async function importWordToOutline(item: WorkItemRow, by: string | null): Promise<WordImportOutcome> {
  if (!isWordProfileCandidate(item)) return { ok: false, code: 'worddoc_not_word', detail: null }
  if (hasDocModel(item.id)) return { ok: true, item, imported: false, warnings: wordImportWarnings(item.id) }
  const rel = item.source_path as string
  const abs = resolveLifePath(rel)
  if (!abs) return { ok: false, code: 'worddoc_unreadable', detail: null }
  try { statSync(abs) } catch { return { ok: false, code: 'worddoc_unreadable', detail: null } }
  const project = getProject(item.project_id)
  if (!project || project.archived_at != null) return { ok: false, code: 'worddoc_project_gone', detail: null }
  const read = await readWordFile(abs)
  if (!read.ok) return read
  if (hasDocModel(item.id)) return { ok: true, item, imported: false, warnings: wordImportWarnings(item.id) }
  const warnings = new Set<WordWarning>(read.parsed.warnings)
  const page = pageOf(read.parsed, item.id, rel, item.title, warnings)
  if (!page.length) {
    const s = addSection(item.id, placeholderTitle(), {})
    if (!s.ok) return { ok: false, code: 'worddoc_import_failed', detail: s.detail }
  } else {
    const r = replacePage(item.id, page, [], 'owner')
    if (!r.ok) return { ok: false, code: 'worddoc_import_failed', detail: r.detail }
  }
  // Nothing half-done: on a failure below the page goes again, the item stays a Word file.
  const undoPage = (): void => { replacePage(item.id, [], documentOutline(item.id).sections.flatMap((s) => [s.id, ...s.blocks.map((b) => b.id)]), 'owner') }
  const doc = await renderDocx(item, APP_LANG === 'en' ? 'en' : 'hu')
  let fresh: WorkItemRow
  if (/\.docx$/i.test(rel)) {
    // #781: the owner's own .docx stays the item's file: its state before becomes the previous version (a copy in the
    // store folder), and the page's render is written into it. Without a converter the file is left as it is (the next
    // mirror run writes it).
    const original = readFileSync(abs)
    const made = keepStateAsPrevious(item, rel, original, by, 'word_import', APP_LANG === 'en' ? 'original' : 'eredeti')
    if (!made) { undoPage(); return { ok: false, code: 'worddoc_save_failed', detail: 'the original could not be kept in the store folder' } }
    if (doc.ok) {
      try { writeFileSync(abs, doc.docx) } catch (e) {
        undoPage()
        return { ok: false, code: 'worddoc_save_failed', detail: e instanceof Error ? e.message : String(e) }
      }
    }
    fresh = made.item
  } else {
    // A .doc / .odt / .rtf file is not overwritten with Word bytes: the page's own .docx goes beside it.
    const data = doc.ok ? doc.docx : readFileSync(abs)
    const stem = basename(rel, extname(rel))
    const saved = saveBytesAsNewVersion(item, project, rel, data, { created_by: by, edit: 'word_import', fileName: `${dirname(rel)}/${stem}.docx` })
    if (!saved.ok) { undoPage(); return { ok: false, code: 'worddoc_save_failed', detail: saved.code } }
    fresh = saved.item
  }
  const list = [...warnings]
  markImported(item.id, list)
  fresh = getWorkItem(item.id) ?? fresh
  // A rendered page already matches the outline; a raw copy (no converter) is rewritten by the next mirror run.
  seedMirrorRow(fresh, doc.ok ? {} : { outlineSha: '' })
  if (!doc.ok) scheduleOutlineMirror(item.id)
  return { ok: true, item: fresh, imported: true, warnings: list }
}

/**
 * The owner edited the item's .docx by hand (in Word, outside the page): reads it onto the page again. The edited file
 * is kept as the previous version first (#781: a copy in the store folder); the page then writes into the same file.
 */
export async function reimportWordFromFile(item: WorkItemRow, by: string | null): Promise<WordImportOutcome> {
  if (!isWordProfileCandidate(item) || !isWordImported(item.id)) return { ok: false, code: 'worddoc_not_word', detail: null }
  const rel = item.source_path as string
  const abs = resolveLifePath(rel)
  if (!abs) return { ok: false, code: 'worddoc_unreadable', detail: null }
  let bytes: Buffer
  try { bytes = readFileSync(abs) } catch { return { ok: false, code: 'worddoc_unreadable', detail: null } }
  const project = getProject(item.project_id)
  if (!project || project.archived_at != null) return { ok: false, code: 'worddoc_project_gone', detail: null }
  const read = await readWordFile(abs)
  if (!read.ok) return read
  const warnings = new Set<WordWarning>(read.parsed.warnings)
  const page = pageOf(read.parsed, item.id, rel, item.title, warnings)
  const saved = keepStateAsPrevious(item, rel, bytes, by, 'word_reimport', APP_LANG === 'en' ? 'edited in Word' : 'Wordben szerkesztve')
  if (!saved) return { ok: false, code: 'worddoc_save_failed', detail: 'the edited file could not be kept in the store folder' }
  const list = [...warnings]
  const put = putPage(saved.item, page, list)
  if (!put.ok) return put
  return { ok: true, item: put.item, imported: true, warnings: list }
}

export type WordVersionOutcome =
  | { ok: true; item: WorkItemRow; version: WorkItemVersionRow | null; loaded: WorkItemVersionRow | null }
  | { ok: false; code: WordDocCode | 'version_last'; detail: string | null }

/** The earlier state a Word item's version kept in the store folder, read and parsed; null = not this case. */
async function storedWordState(item: WorkItemRow, storeRel: string | null): Promise<
  null | { ok: false; code: WordDocCode; detail: string | null } | { ok: true; rel: string; abs: string; stored: Buffer; page: PageSectionIn[]; warnings: WordWarning[] }
> {
  const rel = item.source_path
  if (!isWordImported(item.id) || !isWordStorePath(storeRel) || !rel || isWordStorePath(rel)) return null
  const abs = resolveLifePath(rel)
  const from = resolveLifePath(storeRel as string)
  if (!abs || !from) return { ok: false, code: 'worddoc_unreadable', detail: null }
  let stored: Buffer
  try { stored = readFileSync(from); statSync(abs) } catch { return { ok: false, code: 'worddoc_unreadable', detail: null } }
  const project = getProject(item.project_id)
  if (!project || project.archived_at != null) return { ok: false, code: 'worddoc_project_gone', detail: null }
  const read = await readWordFile(from)
  if (!read.ok) return read
  const warnings = new Set<WordWarning>(read.parsed.warnings)
  const page = pageOf(read.parsed, item.id, rel, item.title, warnings)
  return { ok: true, rel, abs, stored, page, warnings: [...warnings] }
}

/** The page read from `page` again (the whole page is replaced), the import mark refreshed, and the mirror rewrites the file. */
function putPage(item: WorkItemRow, page: PageSectionIn[], warnings: WordWarning[]): { ok: true; item: WorkItemRow } | { ok: false; code: WordDocCode; detail: string | null } {
  const known = documentOutline(item.id).sections.flatMap((s) => [s.id, ...s.blocks.map((b) => b.id)])
  const r = replacePage(item.id, page.length ? page : [{ title: placeholderTitle(), blocks: [] }], known, 'owner')
  if (!r.ok) return { ok: false, code: 'worddoc_import_failed', detail: r.detail }
  markImported(item.id, warnings)
  const fresh = getWorkItem(item.id) ?? item
  seedMirrorRow(fresh, { outlineSha: '' })
  scheduleOutlineMirror(item.id)
  return { ok: true, item: fresh }
}

/**
 * #781: restoring an earlier version of a Word item whose state is kept in the store folder. The plain restore would point
 * the item at that copy (under the System branch) and the page would write there from then on; instead the earlier state is
 * written back into the owner's own file, the state it has now is kept as the previous version, and the page is read from
 * it. Null = not this case (the caller restores the usual way).
 */
export async function restoreWordVersion(item: WorkItemRow, versionId: string, by: string | null): Promise<WordVersionOutcome | null> {
  const target = getWorkItemVersion(versionId)
  if (!target || target.work_item_id !== item.id || target.id === item.current_version_id) return null
  const st = await storedWordState(item, target.source_path)
  if (!st || !st.ok) return st
  let current: Buffer
  try { current = readFileSync(st.abs) } catch { return { ok: false, code: 'worddoc_unreadable', detail: null } }
  const made = keepStateAsPrevious(item, st.rel, current, by, 'word_restore', APP_LANG === 'en' ? 'before restore' : 'visszaállítás előtt',
    { restored_from: target.id, restored_from_no: target.version_no })
  if (!made) return { ok: false, code: 'worddoc_save_failed', detail: 'the current state could not be kept in the store folder' }
  try { writeFileSync(st.abs, st.stored) } catch (e) { return { ok: false, code: 'worddoc_save_failed', detail: e instanceof Error ? e.message : String(e) } }
  const put = putPage(made.item, st.page, st.warnings)
  if (!put.ok) return put
  return { ok: true, item: put.item, version: made.version, loaded: null }
}

/**
 * #781: deleting the CURRENT version of a Word item when the version below it is a state kept in the store folder. The plain
 * delete would point the item at that copy; instead that state is written back into the owner's own file, which stays the
 * item's file, and the page is read from it. Null = not this case (the caller deletes the usual way).
 */
export async function deleteWordCurrentVersion(item: WorkItemRow, versionId: string): Promise<WordVersionOutcome | null> {
  const target = getWorkItemVersion(versionId)
  if (!target || target.work_item_id !== item.id || target.id !== item.current_version_id) return null
  const below = versionLoadedOnDelete(item.id, target)
  if (!below) return null
  const st = await storedWordState(item, below.source_path)
  if (!st || !st.ok) return st
  let current: Buffer
  try { current = readFileSync(st.abs) } catch { return { ok: false, code: 'worddoc_unreadable', detail: null } }
  try { writeFileSync(st.abs, st.stored) } catch (e) { return { ok: false, code: 'worddoc_save_failed', detail: e instanceof Error ? e.message : String(e) } }
  const del = deleteWorkItemVersion(target.id, item.id, undefined, { loadedSource: st.rel })
  if (!del.ok) {
    try { writeFileSync(st.abs, current) } catch { /* the file keeps the earlier state; the version is still there */ }
    return { ok: false, code: del.code === 'version_last' ? 'version_last' : 'worddoc_save_failed', detail: del.code }
  }
  const put = putPage(del.item, st.page, st.warnings)
  if (!put.ok) return put
  return { ok: true, item: put.item, version: null, loaded: del.loaded }
}

/**
 * #781: "Upload the edited file" on a Word item read onto the page. The plain upload wrote "X (2).docx" beside the owner's
 * file and pointed the item at it, while the page kept the old text. Instead the uploaded file goes INTO the owner's own
 * file (same type only), the state it had is kept as the previous version (store folder), and the page is read from it.
 * Null = not this case (another type, or not a Word item on the page): the caller uploads the usual way.
 */
export async function uploadWordVersion(item: WorkItemRow, bytes: Buffer, name: unknown, by: string | null): Promise<WordVersionOutcome | null> {
  const rel = item.source_path
  if (!isWordImported(item.id) || !rel || isWordStorePath(rel)) return null
  const ext = extname(rel).toLowerCase()
  if (!ext || extname(String(name ?? '')).toLowerCase() !== ext) return null
  const abs = resolveLifePath(rel)
  if (!abs) return { ok: false, code: 'worddoc_unreadable', detail: null }
  let current: Buffer
  try { current = readFileSync(abs) } catch { return { ok: false, code: 'worddoc_unreadable', detail: null } }
  const project = getProject(item.project_id)
  if (!project || project.archived_at != null) return { ok: false, code: 'worddoc_project_gone', detail: null }
  const upRel = writeStoreFile(item.id, `${basename(rel, extname(rel))} - ${APP_LANG === 'en' ? 'uploaded' : 'feltöltve'}${extname(rel)}`, bytes)
  const upAbs = upRel ? resolveLifePath(upRel) : null
  if (!upAbs) return { ok: false, code: 'worddoc_save_failed', detail: 'the uploaded file could not be kept in the store folder' }
  const read = await readWordFile(upAbs)
  if (!read.ok) return read
  const warnings = new Set<WordWarning>(read.parsed.warnings)
  const page = pageOf(read.parsed, item.id, rel, item.title, warnings)
  const made = keepStateAsPrevious(item, rel, current, by, 'word_upload', APP_LANG === 'en' ? 'before upload' : 'feltöltés előtt')
  if (!made) return { ok: false, code: 'worddoc_save_failed', detail: 'the current state could not be kept in the store folder' }
  try { writeFileSync(abs, bytes) } catch (e) { return { ok: false, code: 'worddoc_save_failed', detail: e instanceof Error ? e.message : String(e) } }
  const put = putPage(made.item, page, [...warnings])
  if (!put.ok) return put
  return { ok: true, item: put.item, version: made.version, loaded: null }
}
