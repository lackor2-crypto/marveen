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
import { MISSING_MARK_RE, type BlockKind, type SectionStatus } from './workbench-docmodel.js'

/** Amit a renderelo a modellbol lat: CSAK cim, allapot, blokk-fajta es szoveg. */
export interface RenderOutline {
  sections: { title: string; status: SectionStatus; blocks: { kind: BlockKind; text: string; img?: RenderImage | null }[] }[]
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
function imageBlock(b: { text: string; img?: RenderImage | null }, n: number, draft: boolean): string[] {
  const img = b.img
  if (!img || !img.width || !img.height) {
    const name = String(b.text || '').split('/').pop() || ''
    return [`<text:p text:style-name="Body">${draft ? '<text:span text:style-name="Missing">' : ''}⚠ ${xmlEscape(name)}${draft ? '</text:span>' : ''}</text:p>`]
  }
  // 96 dpi as the natural size, never wider than the text, never taller than most of a page.
  let w = img.width / 96 * 2.54
  let h = img.height / 96 * 2.54
  const k = Math.min(1, IMG_MAX_W_CM / w, IMG_MAX_H_CM / h)
  w = Math.max(0.5, w * k)
  h = Math.max(0.5, h * k)
  return [`<text:p text:style-name="ImageP"><draw:frame draw:style-name="ImgFrame" draw:name="Picture ${n}" text:anchor-type="as-char" svg:width="${w.toFixed(2)}cm" svg:height="${h.toFixed(2)}cm" draw:z-index="1"><draw:image draw:mime-type="${xmlEscape(img.mime)}"><office:binary-data>${img.data.toString('base64')}</office:binary-data></draw:image></draw:frame></text:p>`]
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
function paragraphs(text: string, style: 'Body' | 'Note', draft: boolean): string[] {
  const out: string[] = []
  for (const para of text.split(/\n[ \t]*\n+/)) {
    const lines = para.split('\n')
    lines.forEach((l, i) => {
      out.push(`<text:p text:style-name="${i < lines.length - 1 ? style + 'Line' : style}">${inlineMarked(l, draft)}</text:p>`)
    })
  }
  return out
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

function listBlock(text: string, draft: boolean): string[] {
  const lines = text.split('\n').filter((l) => l.trim())
  const numbered = lines.length > 0 && lines.every((l) => /^\s*\d+[.)]\s+/.test(l))
  const items = lines.map((l) => l.replace(LIST_MARK, '').trim())
  return [`<text:list text:style-name="${numbered ? 'LNum' : 'LBul'}">${items.map((i) => `<text:list-item><text:p text:style-name="ListP">${inlineMarked(i, draft)}</text:p></text:list-item>`).join('')}</text:list>`]
}

/** Tablazat "a | b | c" sorokbol; az elso sor fejlec (oldaltoresnel ismetlodik), a "---|---" elvalaszto kimarad. */
function tableBlock(text: string, n: number, draft: boolean): string[] {
  const rows = text.split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^\|?[\s:|-]+\|?$/.test(l))
    .map((l) => l.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim()))
  if (!rows.length) return []
  const cols = Math.max(1, ...rows.map((r) => r.length))
  const row = (r: string[], head: boolean): string => `<table:table-row>${Array.from({ length: cols }, (_, ci) => `<table:table-cell table:style-name="Cell" office:value-type="string"><text:p text:style-name="${head ? 'TableHead' : 'TableBody'}">${inlineMarked(r[ci] ?? '', draft)}</text:p></table:table-cell>`).join('')}</table:table-row>`
  return [`<table:table table:name="T${n}" table:style-name="Tbl">`
    + `<table:table-column table:number-columns-repeated="${cols}"/>`
    + `<table:table-header-rows>${row(rows[0] as string[], true)}</table:table-header-rows>`
    + rows.slice(1).map((r) => row(r, false)).join('')
    + '</table:table>']
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
export function buildFodt(outline: RenderOutline, opts: RenderOptions): string {
  const docx = opts.target === 'docx'
  // A Word-valtozatban a hiany-jelolesek kiemelve maradnak (a `draft` itt csak a kiemelest jelenti), vizjel nelkul.
  const o = docx ? { ...opts, draft: true } : opts
  const L = LABELS[o.lang]
  const body: string[] = [`<text:p text:style-name="${docx ? 'Title' : 'TitleFirst'}">${inline(o.title)}</text:p>`]
  let tables = 0
  let notes = 0
  let pictures = 0
  for (const s of outline.sections) {
    body.push(`<text:h text:style-name="Heading_20_1" text:outline-level="1">${inline(s.title)}</text:h>`)
    const sec: string[] = []
    for (const b of s.blocks) {
      if (b.kind === 'list') sec.push(...listBlock(b.text, o.draft))
      else if (b.kind === 'table') sec.push(...tableBlock(b.text, ++tables, o.draft))
      else if (b.kind === 'signature') sec.push(...signature(b.text, o.draft))
      else if (b.kind === 'image') sec.push(...imageBlock(b, ++pictures, o.draft))
      else if (b.kind === 'footnote') {
        // Nincs elotte szoveg a fejezetben: kis betus megjegyzeskent all.
        const note = footnoteXml(b.text, notes + 1, o.draft)
        if (attachFootnote(sec, note)) notes++
        else sec.push(...paragraphs(b.text, 'Note', o.draft))
      } else sec.push(...paragraphs(b.text, 'Body', o.draft))
    }
    body.push(...sec)
  }
  if (outline.annexes && outline.annexes.length) {
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
<style:style style:name="AnnexLine" style:family="paragraph" style:parent-style-name="Standard"><style:paragraph-properties fo:margin-left="0.9cm" fo:text-indent="-0.9cm" fo:margin-bottom="0.1cm"/></style:style>
<style:style style:name="ListP" style:family="paragraph" style:parent-style-name="Body"><style:paragraph-properties fo:margin-bottom="0.1cm"/></style:style>
<style:style style:name="Title" style:family="paragraph" style:parent-style-name="Standard"><style:paragraph-properties fo:text-align="center" fo:margin-bottom="0.6cm" fo:keep-with-next="always"/><style:text-properties fo:font-size="16pt" fo:font-weight="bold"/></style:style>
<style:style style:name="Heading_20_1" style:display-name="Heading 1" style:family="paragraph" style:parent-style-name="Standard" style:default-outline-level="1"><style:paragraph-properties fo:margin-top="0.45cm" fo:margin-bottom="0.2cm" fo:keep-with-next="always"/><style:text-properties fo:font-size="13pt" fo:font-weight="bold"/></style:style>
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
<style:style style:name="ImgFrame" style:family="graphic"><style:graphic-properties style:vertical-pos="top" style:vertical-rel="baseline" draw:stroke="none" draw:fill="none"/></style:style>
<style:style style:name="Missing" style:family="text"><style:text-properties fo:background-color="#fff1a8" fo:font-weight="bold"/></style:style>
<style:style style:name="WmFrame" style:family="graphic"><style:graphic-properties draw:stroke="none" draw:fill="none" style:run-through="background" style:wrap="run-through" style:vertical-pos="from-top" style:vertical-rel="page" style:horizontal-pos="center" style:horizontal-rel="page"/></style:style>
<text:list-style style:name="LBul"><text:list-level-style-bullet text:level="1" text:bullet-char="•"><style:list-level-properties text:list-level-position-and-space-mode="label-alignment"><style:list-level-label-alignment text:label-followed-by="listtab" text:list-tab-stop-position="0.9cm" fo:text-indent="-0.5cm" fo:margin-left="0.9cm"/></style:list-level-properties></text:list-level-style-bullet></text:list-style>
<text:list-style style:name="LNum"><text:list-level-style-number text:level="1" style:num-suffix="." style:num-format="1"><style:list-level-properties text:list-level-position-and-space-mode="label-alignment"><style:list-level-label-alignment text:label-followed-by="listtab" text:list-tab-stop-position="0.9cm" fo:text-indent="-0.6cm" fo:margin-left="0.9cm"/></style:list-level-properties></text:list-level-style-number></text:list-style>
<text:notes-configuration text:note-class="footnote" style:num-format="1" text:start-value="0" text:footnotes-position="page" text:start-numbering-at="document"/>
</office:styles>
<office:automatic-styles>
<style:style style:name="TitleFirst" style:family="paragraph" style:parent-style-name="Title" style:master-page-name="First"/>
<style:style style:name="Tbl" style:family="table"><style:table-properties style:width="16.5cm" table:align="margins" fo:margin-bottom="0.3cm"/></style:style>
<style:style style:name="Cell" style:family="table-cell"><style:table-cell-properties fo:padding="0.08cm" fo:border="0.5pt solid #000000"/></style:style>
<style:page-layout style:name="pm1"><style:page-layout-properties fo:page-width="21cm" fo:page-height="29.7cm" fo:margin-top="1.5cm" fo:margin-bottom="1.5cm" fo:margin-left="2.5cm" fo:margin-right="2cm"/><style:header-style><style:header-footer-properties fo:min-height="0.5cm" fo:margin-bottom="0.5cm"/></style:header-style><style:footer-style><style:header-footer-properties fo:min-height="0.8cm" fo:margin-top="0.4cm"/></style:footer-style></style:page-layout>
</office:automatic-styles>
<office:master-styles>
<style:master-page style:name="First" style:page-layout-name="pm1" style:next-style-name="Standard"><style:header>${watermark || '<text:p text:style-name="HeaderMark"/>'}</style:header>${footer}</style:master-page>
<style:master-page style:name="Standard" style:page-layout-name="pm1">${docx ? '' : `<style:header>${watermark}<text:p text:style-name="Header">${inline(o.title)}</text:p></style:header>`}${footer}</style:master-page>
</office:master-styles>
<office:body><office:text>
${body.join('\n')}
</office:text></office:body></office:document>
`
}

/** A renderelt tartalom: ami a PDF-be kerul. Mas mezo (allitas, forras) nem. */
export function toRenderOutline(outline: { sections: { title: string; status: SectionStatus; blocks: { kind: BlockKind; text: string }[] }[] }): RenderOutline {
  return { sections: outline.sections.map((s) => ({ title: s.title, status: s.status, blocks: s.blocks.map((b) => ({ kind: b.kind, text: b.text })) })) }
}

/** A dokumentum tartalmanak ujjlenyomata: ha a vegleges PDF utan valtozik, a vegleges allapot megszunik (K-1.23). */
export function outlineHash(outline: RenderOutline, title: string): string {
  const core = {
    title,
    s: outline.sections.map((s) => ({ t: s.title, st: s.status, b: s.blocks.map((b) => ({ k: b.kind, x: b.text })) })),
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
function simpleFodt(title: string, body: string, lang: 'hu' | 'en'): string {
  const l = lang === 'en' ? { l: 'en', c: 'GB' } : { l: 'hu', c: 'HU' }
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
export function buildCoverFodt(heading: string, title: string, lang: 'hu' | 'en'): string {
  return simpleFodt(heading, `<text:p text:style-name="CoverLabel">${inline(heading)}</text:p><text:p text:style-name="CoverTitle">${inline(title)}</text:p>`, lang)
}

/** Szoveges melleklet (TXT, MD) PDF-kent: soronkent, valtozatlanul (nem formazzuk at, amit a tulajdonos csatolt). */
export function buildTextFodt(text: string, name: string): string {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n')
  return simpleFodt(name, lines.map((l) => `<text:p text:style-name="Plain">${inline(l)}</text:p>`).join('\n'), 'hu')
}
