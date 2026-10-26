/**
 * A DOKUMENTUMMODELLBOL VALODI PDF (kanban #441, v4 spec 1/A, K-1.21 ... K-1.24).
 *
 * Nem a bongeszo nyomtatasa: a modellbol (fejezetek, blokkok) egy ODF-
 * dokumentum (egyetlen XML-fajl, .fodt) keszul, es a meglevo LibreOffice-
 * atalakitas csinal belole PDF-et. Igy benne van: stabil oldaltores, fejlec
 * (a 2. oldaltol a cim), lablec "X / Y oldal" szamozassal, margok, beagyazott
 * betutipusok, cimhierarchia (a PDF konyvjelzoi a fejezetcimekbol), valodi
 * labjegyzet, alairasblokk, metaadatok (cim, szerzo), cimkezett (akadalymentes)
 * PDF. A VEGLEGES PDF/A-2b (archivalhato; a nemet ERVV es a birosagi
 * gyakorlat ezt varja), a PISZKOZAT (K-1.21) minden oldalan vizjel all, es a
 * hiany-jelolesek kiemelve benne maradnak.
 *
 * A FORRAS SOSE KERUL BELE (K-1.13): a renderelo csak a fejezetcimekbol es a
 * blokkok szovegebol dolgozik -- allitas, forras, ikon, fajlnev, belso
 * azonosito nem jut el ide.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { convertOfficeToPdf, renderCacheDir, sofficeConvertFile, RENDER_CACHE_MAX_AGE_MS, type ConvertResult } from './office-convert.js'
import { MISSING_MARK_RE, isBlankLine, isPlaceholderSectionTitle, imageBlockParts, tableBlockParts, type BlockKind, type SectionStatus } from './workbench-docmodel.js'
import { isBlockAlign, richMatches, richRuns, type ParaFmt, type RichRun } from './workbench-docrich.js'

/** Amit a renderelo a modellbol lat: CSAK cim, allapot, blokk-fajta es szoveg. */
export interface RenderOutline {
  sections: { title: string; status: SectionStatus; /** #604: the chapter title's alignment. */ align?: string | null; rich?: string | null; blocks: { kind: BlockKind; text: string; img?: RenderImage | null; rich?: string | null; align?: string | null; pfmt?: ParaFmt | null }[] }[]
  /** Mellekletjegyzek a dokumentum vegen (K-1.18): cimke + rovid leiras, a fajl utja NEM. */
  annexes?: { label: string; title: string }[]
  annexTitle?: string
}

export type DocLang = 'hu' | 'en' | 'de'

/** A picture of an `image` block, read from disk by the caller: its bytes and pixel size. */
export interface RenderImage { data: Buffer; width: number; height: number; mime: string }

/**
 * Pixel size of a PNG, JPEG or GIF from its header (no image library needed).
 * JPEG: the EXIF orientation is honoured, so a phone photo taken upright keeps
 * its upright proportions. Null when the bytes are not one of these formats.
 */
export function imageSize(buf: Buffer): { width: number; height: number; mime: string } | null {
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), mime: 'image/png' }
  if (buf.length >= 10 && buf.toString('ascii', 0, 3) === 'GIF') return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8), mime: 'image/gif' }
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null
  let i = 2
  let rotated = false
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue }
    const m = buf[i + 1] as number
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue }
    const len = buf.readUInt16BE(i + 2)
    if (m === 0xe1 && buf.toString('ascii', i + 4, i + 8) === 'Exif') rotated = exifRotated(buf, i + 10, i + 2 + len)
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      const h = buf.readUInt16BE(i + 5)
      const w = buf.readUInt16BE(i + 7)
      return rotated ? { width: h, height: w, mime: 'image/jpeg' } : { width: w, height: h, mime: 'image/jpeg' }
    }
    i += 2 + len
  }
  return null
}

/** True when the EXIF orientation (5-8) turns the picture by 90 degrees. */
function exifRotated(buf: Buffer, start: number, end: number): boolean {
  try {
    const le = buf.toString('ascii', start, start + 2) === 'II'
    const u16 = (o: number): number => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o))
    const u32 = (o: number): number => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o))
    const ifd = start + u32(start + 4)
    const n = u16(ifd)
    for (let k = 0; k < n; k++) {
      const e = ifd + 2 + k * 12
      if (e + 12 > end) break
      if (u16(e) === 0x0112) { const v = u16(e + 8); return v >= 5 && v <= 8 }
    }
  } catch { /* a broken EXIF block: use the stored size */ }
  return false
}

/** Text area width of the page (21 cm - 2.5 cm - 2 cm) and the tallest picture we let a block take. */
const IMG_MAX_W_CM = 16.5
const IMG_MAX_H_CM = 20

/** An `image` block in the ODF: the picture embedded, centred, scaled to fit the text width. */
function imageBlock(b: { text: string; img?: RenderImage | null }, n: number, draft: boolean, extraStyles: string[] = []): string[] {
  const img = b.img
  const pic = imageBlockParts(b.text)
  if (!img || !img.width || !img.height) {
    const name = pic.path.split('/').pop() || ''
    return [`<text:p text:style-name="Body">${draft ? '<text:span text:style-name="Missing">' : ''}⚠ ${xmlEscape(name)}${draft ? '</text:span>' : ''}</text:p>`]
  }
  // 96 dpi as the natural size, never wider than the text, never taller than most of a page.
  let w = img.width / 96 * 2.54
  let h = img.height / 96 * 2.54
  // A width the owner set (#508) is a share of the text width; the height follows, still never taller than the cap.
  const k = pic.width ? Math.min(IMG_MAX_W_CM * pic.width / 100 / w, IMG_MAX_H_CM / h) : Math.min(1, IMG_MAX_W_CM / w, IMG_MAX_H_CM / h)
  w = Math.max(0.5, w * k)
  h = Math.max(0.5, h * k)
  let style = pic.align === 'l' ? 'ImagePL' : pic.align === 'r' ? 'ImagePR' : 'ImageP'
  // #521: placed freely -- a left indent and an empty space above, in the text flow (so a page break carries it).
  if (pic.x !== null && pic.y !== null && !pic.over) {
    style = `ImageFree${n}`
    extraStyles.push(`<style:style style:name="${style}" style:family="paragraph" style:parent-style-name="Standard"><style:paragraph-properties fo:text-align="start" fo:margin-left="${(IMG_MAX_W_CM * pic.x / 100).toFixed(2)}cm" fo:margin-top="${(0.15 + IMG_MAX_W_CM * pic.y / 100).toFixed(2)}cm" fo:margin-bottom="0.3cm"/></style:style>`)
  }
  // #566: lying OVER the text -- a frame anchored at the paragraph, run-through, at x / y from it; takes no room, pushes nothing.
  if (pic.over && pic.x !== null && pic.y !== null) {
    extraStyles.push(`<style:style style:name="ImgOver${n}" style:family="graphic" style:parent-style-name="Frame"><style:graphic-properties style:wrap="run-through" style:run-through="foreground" style:horizontal-pos="from-left" style:horizontal-rel="paragraph" style:vertical-pos="from-top" style:vertical-rel="paragraph" fo:margin-left="0cm" fo:margin-right="0cm" fo:margin-top="0cm" fo:margin-bottom="0cm" fo:padding="0cm" fo:border="none" draw:stroke="none" draw:fill="none"/></style:style>`)
    return [`<text:p text:style-name="FrameAnchor"><draw:frame draw:style-name="ImgOver${n}" draw:name="Picture ${n}" text:anchor-type="paragraph" svg:x="${(IMG_MAX_W_CM * pic.x / 100).toFixed(2)}cm" svg:y="${(IMG_MAX_W_CM * pic.y / 100).toFixed(2)}cm" svg:width="${w.toFixed(2)}cm" svg:height="${h.toFixed(2)}cm" draw:z-index="1"><draw:image draw:mime-type="${xmlEscape(img.mime)}"><office:binary-data>${img.data.toString('base64')}</office:binary-data></draw:image></draw:frame></text:p>`]
  }
  // #562: left / right and narrower than the page -- the text runs beside the picture, as on the page (and as a table does).
  if (pic.x === null && !pic.over && pic.width !== null && pic.width < 100 && pic.align !== 'c') {
    const right = pic.align === 'r'
    extraStyles.push(`<style:style style:name="ImgWrap${n}" style:family="graphic" style:parent-style-name="Frame"><style:graphic-properties style:wrap="parallel" style:number-wrapped-paragraphs="no-limit" style:run-through="foreground" style:horizontal-pos="${right ? 'right' : 'left'}" style:horizontal-rel="paragraph" style:vertical-pos="top" style:vertical-rel="paragraph" fo:margin-left="${right ? '0.4cm' : '0cm'}" fo:margin-right="${right ? '0cm' : '0.4cm'}" fo:margin-top="0cm" fo:margin-bottom="0.2cm" fo:padding="0cm" fo:border="none" draw:stroke="none" draw:fill="none"/></style:style>`)
    return [`<text:p text:style-name="FrameAnchor"><draw:frame draw:style-name="ImgWrap${n}" draw:name="Picture ${n}" text:anchor-type="paragraph" svg:width="${w.toFixed(2)}cm" svg:height="${h.toFixed(2)}cm" draw:z-index="1"><draw:image draw:mime-type="${xmlEscape(img.mime)}"><office:binary-data>${img.data.toString('base64')}</office:binary-data></draw:image></draw:frame></text:p>`]
  }
  return [`<text:p text:style-name="${style}"><draw:frame draw:style-name="ImgFrame" draw:name="Picture ${n}" text:anchor-type="as-char" svg:width="${w.toFixed(2)}cm" svg:height="${h.toFixed(2)}cm" draw:z-index="1"><draw:image draw:mime-type="${xmlEscape(img.mime)}"><office:binary-data>${img.data.toString('base64')}</office:binary-data></draw:image></draw:frame></text:p>`]
}

export interface RenderOptions {
  title: string
  author: string | null
  draft: boolean
  /** A DOKUMENTUM nyelve (lablec, vizjel, nyelvi cimke) -- nyelvi valtozatnal a valtozate. */
  lang: DocLang
  /** 'docx' (K-1.26): szerkesztheto Word-fajlnak keszul -- nincs vizjel es futo
   *  fejlec (az ugyved a sajatjat teszi ra), a hiany-jelolesek kiemelve maradnak. */
  target?: 'pdf' | 'docx'
}

/** A LibreOffice PDF-exportjanak beallitasai (JSON szuro-opciok, LibreOffice 7.4+). */
const PDF_COMMON = '"UseTaggedPDF":{"type":"boolean","value":"true"},"ExportBookmarks":{"type":"boolean","value":"true"},"ExportNotes":{"type":"boolean","value":"false"}'
export const PDF_FILTER_DRAFT = `pdf:writer_pdf_Export:{${PDF_COMMON}}`
/** PDF/A-2b: beagyazott betuk, XMP-metaadat, nincs kulso hivatkozas vagy JavaScript. */
export const PDF_FILTER_FINAL = `pdf:writer_pdf_Export:{${PDF_COMMON},"SelectPdfVersion":{"type":"long","value":"2"}}`

/** Ennyi .fodt forras marad a gyorsitotarban (a PDF-jeiket az atalakito sajat takaritasa viszi). */
export const RENDER_SOURCES_MAX = 60

export function xmlEscape(s: string): string {
  return String(s ?? '')
    // XML 1.0-ban tiltott vezerlo karakterek (a tab, sortores maradhat).
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** Egy sor szovege ODF-ben: a tobbszoros szokoz es a tab megmarad. */
function inline(s: string): string {
  return xmlEscape(s)
    .replace(/\t/g, '<text:tab/>')
    .replace(/ {2,}/g, (m) => ` <text:s text:c="${m.length - 1}"/>`)
}

/** Sor szovege; a piszkozatban a hiany-jelolesek kiemelve (K-1.21). */
function inlineMarked(s: string, draft: boolean): string {
  if (!draft) return inline(s)
  const out: string[] = []
  let last = 0
  for (const m of s.matchAll(new RegExp(MISSING_MARK_RE.source, 'g'))) {
    const at = m.index ?? 0
    out.push(inline(s.slice(last, at)), `<text:span text:style-name="Missing">${inline(m[0])}</text:span>`)
    last = at + m[0].length
  }
  out.push(inline(s.slice(last)))
  return out.join('')
}

/**
 * Bekezdes(ek). Ures sor = uj bekezdes. Sima sortores = uj sor ugyanabban a
 * gondolatban -- de SORKIZART bekezdesben a LibreOffice a kezi sortores elotti
 * sort a lap szeleig szethuzna ("Tisztelt            Birosag!"), ezert minden
 * sor kulon bekezdes, a belso sorok kozott terkoz nelkul.
 */
/** Automatic styles made on the fly (a paragraph's spacing / indent, a run's font / size / colours), one per distinct value. */
interface StyleCtx { extra: string[]; names: Map<string, string> }

function autoStyle(st: StyleCtx, key: string, make: (name: string) => string): string {
  const hit = st.names.get(key)
  if (hit) return hit
  const name = `Fx${st.names.size + 1}`
  st.names.set(key, name)
  st.extra.push(make(name))
  return name
}

/** The paragraph style for a block's spacing / indent / alignment on top of the base style `parent`. */
function paraStyle(st: StyleCtx, parent: string, pf: ParaFmt | null, last: boolean, align?: string): string {
  const props: string[] = []
  if (pf?.ls) props.push(`fo:line-height="${Math.round(pf.ls * 130)}%"`)
  if (pf?.sa !== undefined && last) props.push(`fo:margin-bottom="${pf.sa}pt"`)
  if (pf?.ind) props.push(`fo:margin-left="${pf.ind.toFixed(2)}cm"`)
  if (align) props.push(`fo:text-align="${align}"`)
  if (!props.length) return parent
  return autoStyle(st, `p|${parent}|${props.join(' ')}`, (name) => `<style:style style:name="${name}" style:family="paragraph" style:parent-style-name="${parent}"><style:paragraph-properties ${props.join(' ')}/></style:style>`)
}

/**
 * Bekezdes(ek). Ures sor = uj bekezdes. Sima sortores = uj sor ugyanabban a
 * gondolatban -- de SORKIZART bekezdesben a LibreOffice a kezi sortores elotti
 * sort a lap szeleig szethuzna ("Tisztelt            Birosag!"), ezert minden
 * sor kulon bekezdes, a belso sorok kozott terkoz nelkul.
 */
function paragraphs(text: string, style: 'Body' | 'Note', draft: boolean, st: StyleCtx, rich?: string | null, align?: string | null, pf?: ParaFmt | null): string[] {
  const out: string[] = []
  const p = style === 'Body' ? pf ?? null : null
  // Alignment styles exist for the body text only (BodyAl_c, BodyLineAl_c, ...); justify is the body default.
  const al = style === 'Body' && isBlockAlign(align) && align !== 'j' ? `Al_${align}` : ''
  const useRich = !!rich && richMatches(rich, text)
  const runs = useRich ? richRuns(String(rich)) : null
  // One output paragraph: a heading level (text:h) or a body line.
  const emit = (inner: string, inGroupLast: boolean): string => {
    if (p?.h) {
      const parent = `Heading_20_${p.h}`
      const a = isBlockAlign(align) && align !== 'j' ? (align === 'l' ? 'start' : align === 'c' ? 'center' : 'end') : ''
      const name = paraStyle(st, parent, { ...p, sa: undefined }, true, a)
      return `<text:h text:style-name="${name}" text:outline-level="${p.h}">${inner}</text:h>`
    }
    const base = (inGroupLast ? style : style + 'Line') + al
    return `<text:p text:style-name="${paraStyle(st, base, p, inGroupLast)}">${inner}</text:p>`
  }
  if (runs) {
    // Split the formatted runs into lines at "\n", keeping each run's marks.
    const lines: RichRun[][] = [[]]
    for (const r of runs) {
      r.text.split('\n').forEach((piece, i) => {
        if (i > 0) lines.push([])
        if (piece) lines[lines.length - 1].push({ ...r, text: piece })
      })
    }
    // Same paragraph rule as the plain text: an empty line starts a new paragraph, the others are lines of one.
    const groups: RichRun[][][] = [[]]
    for (const ln of lines) {
      if (!ln.length || ln.every((r) => !r.text.trim())) { if (groups[groups.length - 1].length) groups.push([]) }
      else groups[groups.length - 1].push(ln)
    }
    for (const g of groups) {
      g.forEach((ln, i) => out.push(emit(ln.map((r) => richSpan(r, draft, st)).join(''), i === g.length - 1)))
    }
    return out
  }
  for (const para of text.split(/\n[ \t]*\n+/)) {
    const lines = para.split('\n')
    lines.forEach((l, i) => out.push(emit(inlineMarked(l, draft), i === lines.length - 1)))
  }
  return out
}

/** The heading text: the formatted runs when the title has formatting, else the plain title. */
function titleInner(s: { title: string; rich?: string | null }, draft: boolean, st: StyleCtx): string {
  if (s.rich && richMatches(s.rich, s.title)) return richRuns(String(s.rich)).map((r) => richSpan(r, draft, st)).join('')
  return inline(s.title)
}

/** One formatted run in ODF: the marks as nested character-style spans around the (marked) text. */
function richSpan(r: RichRun, draft: boolean, st: StyleCtx): string {
  let x = inlineMarked(r.text, draft)
  if (r.s) x = `<text:span text:style-name="FmtS">${x}</text:span>`
  if (r.u) x = `<text:span text:style-name="FmtU">${x}</text:span>`
  if (r.i) x = `<text:span text:style-name="FmtI">${x}</text:span>`
  if (r.b) x = `<text:span text:style-name="FmtB">${x}</text:span>`
  const props: string[] = []
  if (r.n) props.push('fo:font-weight="normal"')
  if (r.f) props.push(`fo:font-family="'${r.f}'"`)
  if (r.z) props.push(`fo:font-size="${r.z}pt"`)
  if (r.c) props.push(`fo:color="${r.c}"`)
  if (r.h) props.push(`fo:background-color="${r.h}"`)
  if (props.length) {
    const name = autoStyle(st, `t|${props.join(' ')}`, (n) => `<style:style style:name="${n}" style:family="text"><style:text-properties ${props.join(' ')}/></style:style>`)
    x = `<text:span text:style-name="${name}">${x}</text:span>`
  }
  return x
}

/** Alairasblokk: minden sor megmarad (az ures sor is: oda kerul az alairas), egyben marad. */
function signature(text: string, draft: boolean): string[] {
  const lines = text.split('\n')
  return lines.map((l, i) => {
    const st = i === 0 ? 'SignatureFirst' : 'Signature'
    const keep = i < lines.length - 1 ? 'Keep' : ''
    return `<text:p text:style-name="${st}${keep}">${inlineMarked(l, draft)}</text:p>`
  })
}

const LIST_MARK = /^\s*(?:[-*•–]|\d+[.)])\s+/

/** #782: list levels the PDF draws (two leading spaces = one level deeper, as the Word import writes a nested list). */
export const LIST_LEVELS = 3

/** The runs of a formatted line without its first `n` characters (the indent and the list marker). */
function runsAfter(runs: RichRun[], n: number): RichRun[] {
  const out: RichRun[] = []
  let skip = n
  for (const r of runs) {
    if (skip >= r.text.length) { skip -= r.text.length; continue }
    out.push(skip ? { ...r, text: r.text.slice(skip) } : r)
    skip = 0
  }
  return out
}

/**
 * A list block: one item per line. #782: a line indented by two spaces per level is an item of an inner list (at most
 * LIST_LEVELS deep), each list numbered on its own when all of its items carry a number; a formatted block keeps its
 * bold / italic / ... per line.
 */
function listBlock(text: string, draft: boolean, st: StyleCtx, rich?: string | null): string[] {
  const raw = text.split('\n')
  // The formatted lines, when the formatting describes this text line by line.
  let richLines: RichRun[][] | null = null
  if (rich && richMatches(rich, text)) {
    const lines: RichRun[][] = [[]]
    for (const r of richRuns(String(rich))) {
      r.text.split('\n').forEach((piece, i) => {
        if (i > 0) lines.push([])
        if (piece) lines[lines.length - 1].push({ ...r, text: piece })
      })
    }
    if (lines.length === raw.length) richLines = lines
  }
  type Item = { depth: number; numbered: boolean; inner: string; kids: Item[] }
  const items: Item[] = []
  raw.forEach((l, i) => {
    if (!l.trim()) return
    const lead = (/^[ \t]*/.exec(l) as RegExpExecArray)[0].replace(/\t/g, '  ').length
    const depth = Math.min(LIST_LEVELS - 1, Math.floor(lead / 2))
    const numbered = /^\s*\d+[.)]\s+/.test(l)
    let inner = inlineMarked(l.replace(LIST_MARK, '').trim(), draft)
    const rl = richLines ? richLines[i] : null
    if (rl) {
      const plain = rl.map((r) => r.text).join('')
      if (plain.trim() === l.trim()) {
        const m = LIST_MARK.exec(plain)
        const cut = m ? m[0].length : (/^\s*/.exec(plain) as RegExpExecArray)[0].length
        const rest = runsAfter(rl, cut)
        if (rest.length) {
          const last = rest[rest.length - 1] as RichRun
          rest[rest.length - 1] = { ...last, text: last.text.replace(/\s+$/, '') }
          inner = rest.filter((r) => r.text).map((r) => richSpan(r, draft, st)).join('')
        }
      }
    }
    items.push({ depth, numbered, inner, kids: [] })
  })
  // The flat lines as a tree: a line one level deeper belongs to the item above it (a jump of two levels counts as one).
  const roots: Item[] = []
  const stack: Item[] = []
  for (const it of items) {
    while (stack.length && (stack[stack.length - 1] as Item).depth >= it.depth) stack.pop()
    const parent = stack[stack.length - 1]
    if (parent) { it.depth = parent.depth + 1; parent.kids.push(it) } else { it.depth = 0; roots.push(it) }
    stack.push(it)
  }
  const list = (nodes: Item[]): string => {
    const numbered = nodes.every((n) => n.numbered)
    return `<text:list text:style-name="${numbered ? 'LNum' : 'LBul'}">`
      + nodes.map((n) => `<text:list-item><text:p text:style-name="ListP">${n.inner}</text:p>${n.kids.length ? list(n.kids) : ''}</text:list-item>`).join('')
      + '</text:list>'
  }
  return roots.length ? [list(roots)] : []
}

/** Tablazat "a | b | c" sorokbol; az elso sor fejlec (oldaltoresnel ismetlodik), a "---|---" elvalaszto kimarad. */
function tableBlock(text: string, n: number, draft: boolean, extraStyles: string[]): string[] {
  const parts = tableBlockParts(text)
  const rows = parts.text.split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^\|?[\s:|-]+\|?$/.test(l))
    .map((l) => l.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim()))
  if (!rows.length) return []
  const cols = Math.max(1, ...rows.map((r) => r.length))
  const row = (r: string[], head: boolean): string => `<table:table-row>${Array.from({ length: cols }, (_, ci) => `<table:table-cell table:style-name="Cell" office:value-type="string"><text:p text:style-name="${head ? 'TableHead' : 'TableBody'}">${inlineMarked(r[ci] ?? '', draft)}</text:p></table:table-cell>`).join('')}</table:table-row>`
  // A width the owner set (#508) is a share of the text width. Left / right + narrower than the page: the text runs beside it.
  const freeAsked = parts.x !== null && parts.y !== null
  const wCm = parts.width && (parts.width < 100 || freeAsked) ? Math.max(1.5, IMG_MAX_W_CM * parts.width / 100) : null
  // #521: placed freely -- the table stays in the text flow with a left indent and an empty space above it (no text
  // beside it), so it is where the editor shows it, a page break carries it, and it cannot run into the footer.
  const over = parts.over && parts.x !== null && parts.y !== null
  const free = parts.x !== null && parts.y !== null && !over
  const wrap = wCm !== null && parts.align !== 'c' && !free && !over
  const styleName = wCm === null ? 'Tbl' : `TblW${n}`
  if (wCm !== null) {
    extraStyles.push(over
      ? `<style:style style:name="${styleName}" style:family="table"><style:table-properties style:width="${wCm.toFixed(2)}cm" table:align="left" fo:margin-left="0cm" fo:margin-bottom="0cm"/></style:style>`
      : free
      ? `<style:style style:name="${styleName}" style:family="table"><style:table-properties style:width="${wCm.toFixed(2)}cm" table:align="left" fo:margin-left="${(IMG_MAX_W_CM * (parts.x as number) / 100).toFixed(2)}cm" fo:margin-bottom="0.3cm"/></style:style>`
      : `<style:style style:name="${styleName}" style:family="table"><style:table-properties style:width="${wCm.toFixed(2)}cm" table:align="${wrap ? 'left' : 'center'}" fo:margin-bottom="${wrap ? '0cm' : '0.3cm'}"/></style:style>`)
  }
  const table = `<table:table table:name="T${n}" table:style-name="${styleName}">`
    + `<table:table-column table:number-columns-repeated="${cols}"/>`
    + `<table:table-header-rows>${row(rows[0] as string[], true)}</table:table-header-rows>`
    + rows.slice(1).map((r) => row(r, false)).join('')
    + '</table:table>'
  // #590: lying OVER the text -- a frame anchored at the paragraph, run-through, at x / y from it; takes no room, pushes nothing
  // (the same as a picture, #566).
  if (over) {
    extraStyles.push(`<style:style style:name="TblOver${n}" style:family="graphic" style:parent-style-name="Frame"><style:graphic-properties style:wrap="run-through" style:run-through="foreground" style:horizontal-pos="from-left" style:horizontal-rel="paragraph" style:vertical-pos="from-top" style:vertical-rel="paragraph" fo:margin-left="0cm" fo:margin-right="0cm" fo:margin-top="0cm" fo:margin-bottom="0cm" fo:padding="0cm" fo:border="none" draw:stroke="none" draw:fill="none" draw:auto-grow-height="true" fo:min-height="0.3cm"/></style:style>`)
    return [`<text:p text:style-name="FrameAnchor"><draw:frame draw:style-name="TblOver${n}" draw:name="TableFrame ${n}" text:anchor-type="paragraph" svg:x="${(IMG_MAX_W_CM * (parts.x as number) / 100).toFixed(2)}cm" svg:y="${(IMG_MAX_W_CM * (parts.y as number) / 100).toFixed(2)}cm" svg:width="${wCm!.toFixed(2)}cm" draw:z-index="1"><draw:text-box fo:min-height="0.3cm">${table}</draw:text-box></draw:frame></text:p>`]
  }
  if (free && (parts.y as number) > 0) {
    // The empty space above is its own (1pt) paragraph, not the table's top margin: measured 2026-10-10, the Word
    // export drops a table's top margin, while an empty paragraph's space survives in both the PDF and the .docx.
    extraStyles.push(`<style:style style:name="TblGap${n}" style:family="paragraph" style:parent-style-name="FrameAnchor"><style:paragraph-properties fo:margin-top="${(IMG_MAX_W_CM * (parts.y as number) / 100).toFixed(2)}cm" fo:margin-bottom="0cm"/></style:style>`)
    return [`<text:p text:style-name="TblGap${n}"/>`, table]
  }
  if (!wrap) return [table]
  const right = parts.align === 'r'
  extraStyles.push(`<style:style style:name="TblFrame${n}" style:family="graphic" style:parent-style-name="Frame"><style:graphic-properties style:wrap="parallel" style:number-wrapped-paragraphs="no-limit" style:run-through="foreground" style:horizontal-pos="${right ? 'right' : 'left'}" style:horizontal-rel="paragraph" style:vertical-pos="top" style:vertical-rel="paragraph" fo:margin-left="${right ? '0.4cm' : '0cm'}" fo:margin-right="${right ? '0cm' : '0.4cm'}" fo:margin-top="0cm" fo:margin-bottom="0.2cm" fo:padding="0cm" fo:border="none" draw:stroke="none" draw:fill="none" draw:auto-grow-height="true" fo:min-height="0.3cm"/></style:style>`)
  return [`<text:p text:style-name="FrameAnchor"><draw:frame draw:style-name="TblFrame${n}" draw:name="TableFrame ${n}" text:anchor-type="paragraph" svg:width="${wCm!.toFixed(2)}cm" draw:z-index="1"><draw:text-box fo:min-height="0.3cm">${table}</draw:text-box></draw:frame></text:p>`]
}

/** #566: a picture lying OVER the text, as the anchor paragraph `imageBlock` writes it (one frame, nothing else in it). */
const OVER_ANCHOR_RE = /^<text:p text:style-name="FrameAnchor">(<draw:frame draw:style-name="ImgOver\d+"[\s\S]*<\/draw:frame>)<\/text:p>$/
/** The opening tag of the first paragraph of a chunk (a paragraph, a heading, or the first item of a list) -- not an empty `<text:p .../>`. */
const FIRST_PARA_OPEN_RE = /^(?:<text:list[^>]*>(?:<text:list-item>)?)?<text:[ph] [^>]*[^/]>/

/**
 * #566 (measured 2026-10-16 on the PDF: a free signature pushed every line below it down by 1.15 pt): the picture's own
 * anchor paragraph is a line, however small its font, so a picture that "takes no room" still moved the text. The frame is
 * anchored at the paragraph it lies over -- the next one, which is also what the editor measures x / y from -- by putting
 * it INSIDE that paragraph's opening. Only when there is no such paragraph (the picture ends the chapter, or a table
 * follows) does the picture keep its own anchor paragraph. Walks backwards so a run of pictures all land in the same one.
 */
function anchorOverPictures(sec: string[]): string[] {
  const out = sec.slice()
  for (let i = out.length - 2; i >= 0; i--) {
    const m = OVER_ANCHOR_RE.exec(out[i] as string)
    if (!m) continue
    const next = out[i + 1] as string
    const open = FIRST_PARA_OPEN_RE.exec(next)
    if (!open) continue
    out[i + 1] = open[0] + (m[1] as string) + next.slice(open[0].length)
    out.splice(i, 1)
  }
  return out
}

/** Valodi labjegyzet az elozo blokk utolso bekezdesenek vegen (a lap aljan jelenik meg). */
function footnoteXml(text: string, n: number, draft: boolean): string {
  const clean = text.replace(/^\s*(?:[¹²³⁴⁵⁶⁷⁸⁹⁰]+|\(?\d+\)|\d+[.)]|\*)\s*/, '').trim()
  const body = clean.split('\n').map((l) => `<text:p text:style-name="Footnote">${inlineMarked(l, draft)}</text:p>`).join('')
  return `<text:note text:id="ftn${n}" text:note-class="footnote"><text:note-citation>${n}</text:note-citation><text:note-body>${body}</text:note-body></text:note>`
}

function attachFootnote(parts: string[], note: string): boolean {
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i] as string
    const at = p.lastIndexOf('</text:p>')
    if (at >= 0) { parts[i] = p.slice(0, at) + note + p.slice(at); return true }
  }
  return false
}

const LABELS = {
  hu: { draft: 'PISZKOZAT', pageOf: (cur: string, all: string) => `${cur} / ${all} oldal` },
  en: { draft: 'DRAFT', pageOf: (cur: string, all: string) => `Page ${cur} of ${all}` },
  de: { draft: 'ENTWURF', pageOf: (cur: string, all: string) => `Seite ${cur} von ${all}` },
} as const

/** A modell -> ODF (flat XML). Csak a cimek es a blokkok szovege kerul bele (K-1.13). */
/** The words a hand-written annex list starts with ("Anlagen:", "Mellékletek:", ...), in any of the document languages. */
const ANNEX_LIST_HEADINGS = ['mellékletek', 'melléklet', 'mellékletjegyzék', 'anlagen', 'anlage', 'beilagen', 'annexes', 'annex', 'exhibits', 'attachments', 'enclosures', 'enclosure']

/**
 * #794 (found re-checking the Berlin letter): a letter imported from Word often carries its own annex list ("Anlagen:"
 * and a line per annex). Appending the generated list after it printed the annexes twice. The document has its own
 * list when a paragraph is just such a heading and a later paragraph names one of the annexes by its label ("K1").
 */
export function hasOwnAnnexList(outline: RenderOutline): boolean {
  if (!outline.annexes || !outline.annexes.length) return false
  const headings = new Set([...ANNEX_LIST_HEADINGS, (outline.annexTitle || '').trim().toLowerCase()].filter(Boolean))
  const labels = outline.annexes.map((a) => new RegExp(`(?<![\\p{L}\\p{N}])${a.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'u'))
  const texts = outline.sections.flatMap((s) => s.blocks.filter((b) => b.kind !== 'image' && b.kind !== 'table').map((b) => b.text))
  const at = texts.findIndex((t) => headings.has(t.trim().replace(/[:.]\s*$/, '').trim().toLowerCase()))
  return at >= 0 && texts.slice(at + 1).some((t) => labels.some((re) => re.test(t)))
}

export function buildFodt(outline: RenderOutline, opts: RenderOptions): string {
  const docx = opts.target === 'docx'
  // A Word-valtozatban a hiany-jelolesek kiemelve maradnak (a `draft` itt csak a kiemelest jelenti), vizjel nelkul.
  const o = docx ? { ...opts, draft: true } : opts
  const L = LABELS[o.lang]
  // The work item's own title (its file name) is never printed into the document: not as a main heading, not in the page header.
  const body: string[] = []
  let tables = 0
  const extraStyles: string[] = []
  let notes = 0
  let pictures = 0
  const st: StyleCtx = { extra: extraStyles, names: new Map() }
  for (const s of outline.sections) {
    // #534: a section the program titled with its own placeholder has no heading in the document.
    if (!isPlaceholderSectionTitle(s.title)) body.push(`<text:h text:style-name="${isBlockAlign(s.align) ? `Heading_20_1_Al_${s.align}` : 'Heading_20_1'}" text:outline-level="1">${titleInner(s, o.draft, st)}</text:h>`)
    const sec: string[] = []
    for (const b of s.blocks) {
      if (isBlankLine(b.text) && b.kind !== 'image' && b.kind !== 'table') {
        // #565: an empty line of the owner is an empty paragraph -- it holds its line in the PDF and in Word as on the page.
        // Whatever kind it was stored under (a list item or a note emptied by the owner), it never prints as a bullet or a note.
        sec.push(...paragraphs(' ', 'Body', o.draft, st, null, b.align, b.pfmt).map((p) => p.replace(/> <\/text:p>$/, '></text:p>')))
      } else if (b.kind === 'list') sec.push(...listBlock(b.text, o.draft, st, b.rich))
      else if (b.kind === 'table') sec.push(...tableBlock(b.text, ++tables, o.draft, extraStyles))
      else if (b.kind === 'signature') sec.push(...signature(b.text, o.draft))
      else if (b.kind === 'image') sec.push(...imageBlock(b, ++pictures, o.draft, extraStyles))
      else if (b.kind === 'footnote') {
        // Nincs elotte szoveg a fejezetben: kis betus megjegyzeskent all.
        const note = footnoteXml(b.text, notes + 1, o.draft)
        if (attachFootnote(sec, note)) notes++
        else sec.push(...paragraphs(b.text, 'Note', o.draft, st))
      } else sec.push(...paragraphs(b.text, 'Body', o.draft, st, b.rich, b.align, b.pfmt))
    }
    body.push(...anchorOverPictures(sec))
  }
  if (outline.annexes && outline.annexes.length && !hasOwnAnnexList(outline)) {
    body.push(`<text:h text:style-name="Heading_20_1" text:outline-level="1">${inline(outline.annexTitle || 'Mellékletek')}</text:h>`)
    for (const a of outline.annexes) body.push(`<text:p text:style-name="AnnexLine">${inline(a.label)} – ${inlineMarked(a.title, o.draft)}</text:p>`)
  }
  const lang = o.lang === 'en' ? { l: 'en', c: 'GB', tag: 'en-GB' } : o.lang === 'de' ? { l: 'de', c: 'DE', tag: 'de-DE' } : { l: 'hu', c: 'HU', tag: 'hu-HU' }
  const watermark = o.draft && !docx
    ? `<text:p text:style-name="HeaderMark"><draw:frame draw:style-name="WmFrame" draw:name="Watermark" text:anchor-type="paragraph" svg:x="0cm" svg:y="10cm" svg:width="16.5cm" svg:height="4cm" draw:z-index="0"><draw:text-box><text:p text:style-name="Watermark">${L.draft}</text:p></draw:text-box></draw:frame></text:p>`
    : ''
  const footer = `<style:footer><text:p text:style-name="Footer">${o.draft && !docx ? `${L.draft} · ` : ''}${L.pageOf('<text:page-number text:select-page="current"/>', '<text:page-count/>')}</text:p></style:footer>`
  return `<?xml version="1.0" encoding="UTF-8"?>
<office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0" office:version="1.3" office:mimetype="application/vnd.oasis.opendocument.text">
<office:meta><dc:title>${xmlEscape(o.title)}</dc:title>${o.author ? `<meta:initial-creator>${xmlEscape(o.author)}</meta:initial-creator><dc:creator>${xmlEscape(o.author)}</dc:creator>` : ''}<dc:language>${lang.tag}</dc:language></office:meta>
<office:font-face-decls><style:font-face style:name="Liberation Serif" svg:font-family="'Liberation Serif'" style:font-family-generic="roman" style:font-pitch="variable"/></office:font-face-decls>
<office:styles>
<style:default-style style:family="paragraph"><style:paragraph-properties fo:orphans="2" fo:widows="2"/><style:text-properties style:font-name="Liberation Serif" fo:font-size="12pt" fo:language="${lang.l}" fo:country="${lang.c}"/></style:default-style>
<style:style style:name="Standard" style:family="paragraph"/>
<style:style style:name="Body" style:family="paragraph" style:parent-style-name="Standard"><style:paragraph-properties fo:margin-top="0cm" fo:margin-bottom="0.25cm" fo:text-align="justify" style:justify-single-word="false" fo:line-height="130%"/></style:style>
<style:style style:name="BodyLine" style:family="paragraph" style:parent-style-name="Body"><style:paragraph-properties fo:margin-bottom="0cm"/></style:style>
${(['l', 'c', 'r'] as const).map((a) => {
  const v = a === 'l' ? 'start' : a === 'c' ? 'center' : 'end'
  return `<style:style style:name="BodyAl_${a}" style:family="paragraph" style:parent-style-name="Body"><style:paragraph-properties fo:text-align="${v}"/></style:style>\n<style:style style:name="BodyLineAl_${a}" style:family="paragraph" style:parent-style-name="BodyLine"><style:paragraph-properties fo:text-align="${v}"/></style:style>`
}).join('\n')}
<style:style style:name="FmtB" style:family="text"><style:text-properties fo:font-weight="bold"/></style:style>
<style:style style:name="FmtI" style:family="text"><style:text-properties fo:font-style="italic"/></style:style>
<style:style style:name="FmtU" style:family="text"><style:text-properties style:text-underline-style="solid" style:text-underline-width="auto" style:text-underline-color="font-color"/></style:style>
<style:style style:name="FmtS" style:family="text"><style:text-properties style:text-line-through-style="solid"/></style:style>
<style:style style:name="AnnexLine" style:family="paragraph" style:parent-style-name="Standard"><style:paragraph-properties fo:margin-left="0.9cm" fo:text-indent="-0.9cm" fo:margin-bottom="0.1cm"/></style:style>
<style:style style:name="ListP" style:family="paragraph" style:parent-style-name="Body"><style:paragraph-properties fo:margin-bottom="0.1cm"/></style:style>
<style:style style:name="Title" style:family="paragraph" style:parent-style-name="Standard"><style:paragraph-properties fo:text-align="center" fo:margin-bottom="0.6cm" fo:keep-with-next="always"/><style:text-properties fo:font-size="16pt" fo:font-weight="bold"/></style:style>
<style:style style:name="Heading_20_1" style:display-name="Heading 1" style:family="paragraph" style:parent-style-name="Standard" style:default-outline-level="1"><style:paragraph-properties fo:margin-top="0.45cm" fo:margin-bottom="0.2cm" fo:keep-with-next="always"/><style:text-properties fo:font-size="13pt" fo:font-weight="bold"/></style:style>
${(['l', 'c', 'r', 'j'] as const).map((a) => `<style:style style:name="Heading_20_1_Al_${a}" style:family="paragraph" style:parent-style-name="Heading_20_1"><style:paragraph-properties fo:text-align="${a === 'l' ? 'start' : a === 'c' ? 'center' : a === 'r' ? 'end' : 'justify'}"/></style:style>`).join('\n')}
<style:style style:name="Heading_20_2" style:display-name="Heading 2" style:family="paragraph" style:parent-style-name="Standard" style:default-outline-level="2"><style:paragraph-properties fo:margin-top="0.35cm" fo:margin-bottom="0.15cm" fo:keep-with-next="always"/><style:text-properties fo:font-size="12pt" fo:font-weight="bold"/></style:style>
<style:style style:name="Heading_20_3" style:display-name="Heading 3" style:family="paragraph" style:parent-style-name="Standard" style:default-outline-level="3"><style:paragraph-properties fo:margin-top="0.3cm" fo:margin-bottom="0.12cm" fo:keep-with-next="always"/><style:text-properties fo:font-size="11pt" fo:font-weight="bold" fo:font-style="italic"/></style:style>
<style:style style:name="Note" style:family="paragraph" style:parent-style-name="Standard"><style:paragraph-properties fo:margin-bottom="0.15cm"/><style:text-properties fo:font-size="9.5pt"/></style:style>
<style:style style:name="NoteLine" style:family="paragraph" style:parent-style-name="Note"><style:paragraph-properties fo:margin-bottom="0cm"/></style:style>
<style:style style:name="Footnote" style:family="paragraph" style:parent-style-name="Standard" style:class="extra"><style:paragraph-properties fo:margin-left="0.4cm" fo:text-indent="-0.4cm"/><style:text-properties fo:font-size="10pt"/></style:style>
<style:style style:name="SignatureFirst" style:family="paragraph" style:parent-style-name="Standard"><style:paragraph-properties fo:margin-top="1.2cm" fo:margin-left="9cm"/></style:style>
<style:style style:name="Signature" style:family="paragraph" style:parent-style-name="Standard"><style:paragraph-properties fo:margin-left="9cm"/></style:style>
<style:style style:name="SignatureFirstKeep" style:family="paragraph" style:parent-style-name="SignatureFirst"><style:paragraph-properties fo:keep-with-next="always"/></style:style>
<style:style style:name="SignatureKeep" style:family="paragraph" style:parent-style-name="Signature"><style:paragraph-properties fo:keep-with-next="always"/></style:style>
<style:style style:name="TableHead" style:family="paragraph" style:parent-style-name="Standard"><style:text-properties fo:font-weight="bold" fo:font-size="11pt"/></style:style>
<style:style style:name="TableBody" style:family="paragraph" style:parent-style-name="Standard"><style:text-properties fo:font-size="11pt"/></style:style>
<style:style style:name="Header" style:family="paragraph" style:parent-style-name="Standard"><style:paragraph-properties fo:text-align="end"/><style:text-properties fo:font-size="9pt" fo:color="#555555"/></style:style>
<style:style style:name="HeaderMark" style:family="paragraph" style:parent-style-name="Standard"><style:text-properties fo:font-size="2pt"/></style:style>
<style:style style:name="Footer" style:family="paragraph" style:parent-style-name="Standard"><style:paragraph-properties fo:text-align="center"/><style:text-properties fo:font-size="9pt"/></style:style>
<style:style style:name="Watermark" style:family="paragraph"><style:paragraph-properties fo:text-align="center"/><style:text-properties fo:font-size="72pt" fo:color="#d0d0d0" fo:font-weight="bold"/></style:style>
<style:style style:name="ImageP" style:family="paragraph" style:parent-style-name="Standard"><style:paragraph-properties fo:text-align="center" fo:margin-top="0.15cm" fo:margin-bottom="0.3cm"/></style:style>
<style:style style:name="ImagePL" style:family="paragraph" style:parent-style-name="Standard"><style:paragraph-properties fo:text-align="start" fo:margin-top="0.15cm" fo:margin-bottom="0.3cm"/></style:style>
<style:style style:name="ImagePR" style:family="paragraph" style:parent-style-name="Standard"><style:paragraph-properties fo:text-align="end" fo:margin-top="0.15cm" fo:margin-bottom="0.3cm"/></style:style>
<style:style style:name="ImgFrame" style:family="graphic"><style:graphic-properties style:vertical-pos="top" style:vertical-rel="baseline" draw:stroke="none" draw:fill="none"/></style:style>
<style:style style:name="Missing" style:family="text"><style:text-properties fo:background-color="#fff1a8" fo:font-weight="bold"/></style:style>
<style:style style:name="WmFrame" style:family="graphic"><style:graphic-properties draw:stroke="none" draw:fill="none" style:run-through="background" style:wrap="run-through" style:vertical-pos="from-top" style:vertical-rel="page" style:horizontal-pos="center" style:horizontal-rel="page"/></style:style>
<text:list-style style:name="LBul"><text:list-level-style-bullet text:level="1" text:bullet-char="•"><style:list-level-properties text:list-level-position-and-space-mode="label-alignment"><style:list-level-label-alignment text:label-followed-by="listtab" text:list-tab-stop-position="0.9cm" fo:text-indent="-0.5cm" fo:margin-left="0.9cm"/></style:list-level-properties></text:list-level-style-bullet><text:list-level-style-bullet text:level="2" text:bullet-char="◦"><style:list-level-properties text:list-level-position-and-space-mode="label-alignment"><style:list-level-label-alignment text:label-followed-by="listtab" text:list-tab-stop-position="1.6cm" fo:text-indent="-0.5cm" fo:margin-left="1.6cm"/></style:list-level-properties></text:list-level-style-bullet><text:list-level-style-bullet text:level="3" text:bullet-char="▪"><style:list-level-properties text:list-level-position-and-space-mode="label-alignment"><style:list-level-label-alignment text:label-followed-by="listtab" text:list-tab-stop-position="2.3cm" fo:text-indent="-0.5cm" fo:margin-left="2.3cm"/></style:list-level-properties></text:list-level-style-bullet></text:list-style>
<text:list-style style:name="LNum"><text:list-level-style-number text:level="1" style:num-suffix="." style:num-format="1"><style:list-level-properties text:list-level-position-and-space-mode="label-alignment"><style:list-level-label-alignment text:label-followed-by="listtab" text:list-tab-stop-position="0.9cm" fo:text-indent="-0.6cm" fo:margin-left="0.9cm"/></style:list-level-properties></text:list-level-style-number><text:list-level-style-number text:level="2" style:num-suffix="." style:num-format="1"><style:list-level-properties text:list-level-position-and-space-mode="label-alignment"><style:list-level-label-alignment text:label-followed-by="listtab" text:list-tab-stop-position="1.6cm" fo:text-indent="-0.6cm" fo:margin-left="1.6cm"/></style:list-level-properties></text:list-level-style-number><text:list-level-style-number text:level="3" style:num-suffix="." style:num-format="1"><style:list-level-properties text:list-level-position-and-space-mode="label-alignment"><style:list-level-label-alignment text:label-followed-by="listtab" text:list-tab-stop-position="2.3cm" fo:text-indent="-0.6cm" fo:margin-left="2.3cm"/></style:list-level-properties></text:list-level-style-number></text:list-style>
<text:notes-configuration text:note-class="footnote" style:num-format="1" text:start-value="0" text:footnotes-position="page" text:start-numbering-at="document"/>
<style:style style:name="Frame" style:family="graphic"><style:graphic-properties text:anchor-type="paragraph" svg:x="0cm" svg:y="0cm" style:wrap="parallel" style:number-wrapped-paragraphs="no-limit" style:wrap-contour="false" style:vertical-pos="top" style:vertical-rel="paragraph-content" style:horizontal-pos="center" style:horizontal-rel="paragraph-content" fo:padding="0cm" fo:border="none"/></style:style>
</office:styles>
<office:automatic-styles>
<style:style style:name="TitleFirst" style:family="paragraph" style:parent-style-name="Title" style:master-page-name="First"/>
<style:style style:name="FrameAnchor" style:family="paragraph" style:parent-style-name="Standard"><style:paragraph-properties fo:margin-top="0cm" fo:margin-bottom="0cm" fo:line-height="100%"/><style:text-properties fo:font-size="1pt"/></style:style>
${extraStyles.join('\n')}
<style:style style:name="Tbl" style:family="table"><style:table-properties style:width="16.5cm" table:align="margins" fo:margin-bottom="0.3cm"/></style:style>
<style:style style:name="Cell" style:family="table-cell"><style:table-cell-properties fo:padding="0.08cm" fo:border="0.5pt solid #000000"/></style:style>
<style:page-layout style:name="pm1"><style:page-layout-properties fo:page-width="21cm" fo:page-height="29.7cm" fo:margin-top="1.5cm" fo:margin-bottom="1.5cm" fo:margin-left="2.5cm" fo:margin-right="2cm"/><style:header-style><style:header-footer-properties fo:min-height="0.5cm" fo:margin-bottom="0.5cm"/></style:header-style><style:footer-style><style:header-footer-properties fo:min-height="0.8cm" fo:margin-top="0.4cm"/></style:footer-style></style:page-layout>
</office:automatic-styles>
<office:master-styles>
<style:master-page style:name="First" style:page-layout-name="pm1" style:next-style-name="Standard"><style:header>${watermark || '<text:p text:style-name="HeaderMark"/>'}</style:header>${footer}</style:master-page>
<style:master-page style:name="Standard" style:page-layout-name="pm1">${docx || !watermark ? '' : `<style:header>${watermark}</style:header>`}${footer}</style:master-page>
</office:master-styles>
<office:body><office:text>
${body.join('\n')}
</office:text></office:body></office:document>
`
}

/** A renderelt tartalom: ami a PDF-be kerul. Mas mezo (allitas, forras) nem. */
export function toRenderOutline(outline: { sections: { title: string; status: SectionStatus; align?: string | null; rich?: string | null; blocks: { kind: BlockKind; text: string; rich?: string | null; align?: string | null; pfmt?: ParaFmt | null }[] }[] }): RenderOutline {
  return { sections: outline.sections.map((s) => ({ title: s.title, status: s.status, ...(isBlockAlign(s.align) ? { align: s.align } : {}), ...(s.rich && richMatches(s.rich, s.title) ? { rich: s.rich } : {}), blocks: s.blocks.map((b) => ({ kind: b.kind, text: b.text, ...(b.rich ? { rich: b.rich } : {}), ...(b.align ? { align: b.align } : {}), ...(b.pfmt ? { pfmt: b.pfmt } : {}) })) })) }
}

/** A dokumentum tartalmanak ujjlenyomata: ha a vegleges PDF utan valtozik, a vegleges allapot megszunik (K-1.23). */
export function outlineHash(outline: RenderOutline, title: string): string {
  const core = {
    title,
    s: outline.sections.map((s) => ({ t: s.title, st: s.status, ...(isBlockAlign(s.align) ? { al: s.align } : {}), ...(s.rich && richMatches(s.rich, s.title) ? { r: s.rich } : {}), b: s.blocks.map((b) => ({ k: b.kind, x: b.text, ...(b.rich ? { r: b.rich } : {}), ...(b.align ? { al: b.align } : {}), ...(b.pfmt ? { pf: b.pfmt } : {}) })) })),
    ...(outline.annexes && outline.annexes.length ? { a: outline.annexes.map((a) => [a.label, a.title]), at: outline.annexTitle || '' } : {}),
  }
  return createHash('sha256').update(JSON.stringify(core)).digest('hex')
}

export type RenderResult =
  | { ok: true; pdf: Buffer; cached: boolean }
  | { ok: false; code: Exclude<ConvertResult, { ok: true }>['code']; detail: string | null }

/** A .fodt forrasok takaritasa: a legujabbak maradnak (a hozzajuk tartozo PDF-et az atalakito takaritja). */
function pruneSources(dir: string, now = Date.now()): void {
  let names: string[] = []
  try { names = readdirSync(dir).filter((n) => n.endsWith('.fodt')) } catch { return }
  const files = names.map((n) => {
    try { return { p: join(dir, n), m: statSync(join(dir, n)).mtimeMs } } catch { return null }
  }).filter((x): x is { p: string; m: number } => !!x).sort((a, b) => b.m - a.m)
  files.forEach((f, i) => {
    if (i >= RENDER_SOURCES_MAX || now - f.m > RENDER_CACHE_MAX_AGE_MS) {
      try { rmSync(f.p, { force: true }) } catch { /* a takaritas hibaja nem a felhasznalo baja */ }
    }
  })
}

/** Egy ODF (flat XML) PDF-kent, a LibreOffice-on at. Ugyanaz a tartalom ujra a gyorsitotarbol jon. */
export async function renderFodtPdf(xml: string, filter: string): Promise<RenderResult> {
  const dir = join(renderCacheDir(), 'docmodel')
  const fail = (e: unknown): RenderResult => ({ ok: false, code: 'convert_failed', detail: e instanceof Error ? e.message : String(e) })
  try { mkdirSync(dir, { recursive: true }) } catch (e) { return fail(e) }
  const src = join(dir, createHash('sha256').update(xml).digest('hex').slice(0, 24) + '.fodt')
  // Ugyanaz a tartalom = ugyanaz a fajl, valtozatlan idobelyeggel: a PDF a gyorsitotarbol jon.
  try { if (!existsSync(src)) { writeFileSync(src, xml, 'utf-8'); pruneSources(dir) } } catch (e) { return fail(e) }
  const r = await convertOfficeToPdf(src, { pdfFilter: filter })
  if (!r.ok) return { ok: false, code: r.code, detail: r.detail }
  try { return { ok: true, pdf: readFileSync(r.pdf), cached: r.cached } } catch (e) { return fail(e) }
}

/** A modell PDF-kent. */
export async function renderOutlinePdf(outline: RenderOutline, o: RenderOptions): Promise<RenderResult> {
  return renderFodtPdf(buildFodt(outline, o), o.draft ? PDF_FILTER_DRAFT : PDF_FILTER_FINAL)
}

/** A LibreOffice Word-exportja: valodi Word-stilusok (Cim, Cimsor 1), valodi labjegyzet, valodi szamozas. */
export const DOCX_FILTER = 'docx:MS Word 2007 XML'

export type DocxResult =
  | { ok: true; docx: Buffer }
  | { ok: false; code: 'not_installed' | 'check_failed' | 'timeout' | 'convert_failed' | 'no_output'; detail: string | null }

/**
 * A modell szerkesztheto DOCX-kent (K-1.26), UGYANABBOL az ODF-bol, amibol a
 * PDF keszul -- igy a ket formatum nem terhet el egymastol (K-1.15).
 */
export async function renderOutlineDocx(outline: RenderOutline, o: Omit<RenderOptions, 'draft' | 'target'>): Promise<DocxResult> {
  const xml = buildFodt(outline, { ...o, draft: false, target: 'docx' })
  const dir = join(renderCacheDir(), 'docmodel')
  const fail = (e: unknown): DocxResult => ({ ok: false, code: 'convert_failed', detail: e instanceof Error ? e.message : String(e) })
  try { mkdirSync(dir, { recursive: true }) } catch (e) { return fail(e) }
  const src = join(dir, createHash('sha256').update(xml).digest('hex').slice(0, 24) + '.fodt')
  try { if (!existsSync(src)) { writeFileSync(src, xml, 'utf-8'); pruneSources(dir) } } catch (e) { return fail(e) }
  const r = await sofficeConvertFile(src, DOCX_FILTER, { outExt: 'docx' })
  return r.ok ? { ok: true, docx: r.data } : { ok: false, code: r.code, detail: r.detail }
}

/** Egy egyszeru, egyoldalas ODF: a boritolap es a szoveges melleklet kozos kerete. */
function simpleFodt(title: string, body: string, lang: DocLang): string {
  const l = lang === 'en' ? { l: 'en', c: 'GB' } : lang === 'de' ? { l: 'de', c: 'DE' } : { l: 'hu', c: 'HU' }
  return `<?xml version="1.0" encoding="UTF-8"?>
<office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" xmlns:dc="http://purl.org/dc/elements/1.1/" office:version="1.3" office:mimetype="application/vnd.oasis.opendocument.text">
<office:meta><dc:title>${xmlEscape(title)}</dc:title></office:meta>
<office:font-face-decls><style:font-face style:name="Liberation Serif" svg:font-family="'Liberation Serif'" style:font-family-generic="roman" style:font-pitch="variable"/><style:font-face style:name="Liberation Mono" svg:font-family="'Liberation Mono'" style:font-family-generic="modern" style:font-pitch="fixed"/></office:font-face-decls>
<office:styles>
<style:default-style style:family="paragraph"><style:text-properties style:font-name="Liberation Serif" fo:font-size="12pt" fo:language="${l.l}" fo:country="${l.c}"/></style:default-style>
<style:style style:name="CoverLabel" style:family="paragraph"><style:paragraph-properties fo:text-align="center" fo:margin-top="9cm" fo:margin-bottom="0.8cm"/><style:text-properties fo:font-size="28pt" fo:font-weight="bold"/></style:style>
<style:style style:name="CoverTitle" style:family="paragraph"><style:paragraph-properties fo:text-align="center"/><style:text-properties fo:font-size="14pt"/></style:style>
<style:style style:name="Plain" style:family="paragraph"><style:paragraph-properties fo:margin-bottom="0cm"/><style:text-properties style:font-name="Liberation Mono" fo:font-size="10pt"/></style:style>
</office:styles>
<office:automatic-styles><style:page-layout style:name="pm1"><style:page-layout-properties fo:page-width="21cm" fo:page-height="29.7cm" fo:margin-top="2cm" fo:margin-bottom="2cm" fo:margin-left="2.5cm" fo:margin-right="2cm"/></style:page-layout></office:automatic-styles>
<office:master-styles><style:master-page style:name="Standard" style:page-layout-name="pm1"/></office:master-styles>
<office:body><office:text>
${body}
</office:text></office:body></office:document>
`
}

/** Boritolap egy melleklet ele (K-1.25): nagy betuvel a jel ("K1. melleklet"), alatta a leiras. */
export function buildCoverFodt(heading: string, title: string, lang: DocLang): string {
  return simpleFodt(heading, `<text:p text:style-name="CoverLabel">${inline(heading)}</text:p><text:p text:style-name="CoverTitle">${inline(title)}</text:p>`, lang)
}

/** Szoveges melleklet (TXT, MD) PDF-kent: soronkent, valtozatlanul (nem formazzuk at, amit a tulajdonos csatolt). */
export function buildTextFodt(text: string, name: string): string {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n')
  return simpleFodt(name, lines.map((l) => `<text:p text:style-name="Plain">${inline(l)}</text:p>`).join('\n'), 'hu')
}
