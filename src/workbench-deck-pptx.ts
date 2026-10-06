/**
 * PPTX EXPORT of a presentation deck (v4 spec phase 5). A native, EDITABLE
 * PowerPoint file: text stays text, shapes stay shapes, pictures stay pictures,
 * speaker notes go to the notes pages. Nothing is flattened to a picture, so the
 * owner can keep working on the file in PowerPoint, Keynote or LibreOffice.
 *
 * Pure: the pictures come in through `loadImage`, the result is a Buffer. The PDF
 * export converts this same file with LibreOffice, so the PDF shows what the PPTX
 * shows.
 */
import { buildZip, type ZipEntry } from './web/zip-writer.js'
import type { CanvasObject, CanvasText } from './workbench-graphic.js'
import { isCardSize, type DeckDoc, type DeckSlide } from './workbench-deck.js'

const EMU = 9525 // one slide pixel (96 dpi)
/** A slide is 1920 px wide, 20 inches at 96 dpi. PowerPoint's own 16:9 slide is 13.33 inches (4:3: 10 inches
 *  for 1440 px), so everything is scaled by 2/3: sizes and fonts together, the look is the same and the file
 *  opens at the size the owner expects. */
const FIT = 2 / 3
/** Business cards are drawn at 300 dpi: one pixel is 914400 / 300 EMU, so the page is the real card size. */
const FIT_CARD = (914400 / 300) / EMU
/** The scale of the deck being built right now (set at the start of buildDeckPptx; the build is synchronous). */
let fit = FIT

export interface PptxImage { bytes: Buffer; mime: string }
export interface PptxResult { bytes: Buffer; warnings: string[] }

const esc = (s: unknown): string => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  // control characters are not allowed in XML 1.0
  // eslint-disable-next-line no-control-regex
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')

const emu = (px: number): number => Math.round(px * EMU * fit)

const FONT: Record<CanvasText['font'], string> = { sans: 'Arial', serif: 'Georgia', mono: 'Courier New' }

/** `#rgb` / `#rrggbb` -> `RRGGBB`; anything else (none, transparent) -> null. */
function hex(c: string): string | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(c).trim())
  if (!m) return null
  const h = m[1].length === 3 ? m[1].split('').map((x) => x + x).join('') : m[1]
  return h.toUpperCase()
}

function fill(c: string, opacity = 1): string {
  const h = hex(c)
  if (!h) return '<a:noFill/>'
  const alpha = opacity < 1 ? `<a:alpha val="${Math.round(opacity * 100000)}"/>` : ''
  return `<a:solidFill><a:srgbClr val="${h}">${alpha}</a:srgbClr></a:solidFill>`
}

function line(c: string, widthPx: number, opacity = 1): string {
  const h = hex(c)
  if (!h || widthPx <= 0) return '<a:ln><a:noFill/></a:ln>'
  return `<a:ln w="${emu(widthPx)}" cap="rnd">${fill(c, opacity)}</a:ln>`
}

function xfrm(o: { x: number; y: number; width: number; height: number; rotation?: number }, flat = false): string {
  const rot = o.rotation ? ` rot="${Math.round((((o.rotation % 360) + 360) % 360) * 60000)}"` : ''
  const y = flat ? o.y + o.height / 2 : o.y
  const h = flat ? 0 : o.height
  return `<a:xfrm${rot}><a:off x="${emu(o.x)}" y="${emu(y)}"/><a:ext cx="${emu(o.width)}" cy="${emu(h)}"/></a:xfrm>`
}

/** Width and height of a PNG, JPEG or GIF without a library; null when not known. */
export function imageSize(b: Buffer): { w: number; h: number } | null {
  if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }
  if (b.length > 10 && b.toString('latin1', 0, 3) === 'GIF') return { w: b.readUInt16LE(6), h: b.readUInt16LE(8) }
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i += 1; continue }
      const marker = b[i + 1]
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) }
      i += 2 + b.readUInt16BE(i + 2)
    }
  }
  return null
}

const IMAGE_EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/jpg': 'jpeg', 'image/gif': 'gif' }

interface SlideCtx {
  shapes: string[]
  rels: { id: string; type: string; target: string }[]
  media: { name: string; data: Buffer }[]
  nextShape: number
  warnings: string[]
  slideNo: number
  loadImage: (src: string) => PptxImage | null
  mediaCount: { n: number }
}

function textShape(o: CanvasText, id: number): string {
  const algn = o.align === 'center' ? 'ctr' : o.align === 'right' ? 'r' : 'l'
  const rpr = `lang="hu-HU" sz="${Math.max(100, Math.round(o.fontSize * 75 * fit))}" b="${o.bold ? 1 : 0}" i="${o.italic ? 1 : 0}" dirty="0"`
  const font = `<a:latin typeface="${FONT[o.font]}"/><a:cs typeface="${FONT[o.font]}"/>`
  const paras = String(o.text).split('\n').map((l) => l === ''
    ? `<a:p><a:pPr algn="${algn}"/><a:endParaRPr ${rpr}>${fill(o.color, o.opacity)}${font}</a:endParaRPr></a:p>`
    : `<a:p><a:pPr algn="${algn}"/><a:r><a:rPr ${rpr}>${fill(o.color, o.opacity)}${font}</a:rPr><a:t>${esc(l)}</a:t></a:r></a:p>`).join('')
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${esc(o.id)}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>`
    + `<p:spPr>${xfrm(o)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>`
    + `<p:txBody><a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0" rtlCol="0" anchor="t"><a:noAutofit/></a:bodyPr><a:lstStyle/>${paras}</p:txBody></p:sp>`
}

function addObject(c: SlideCtx, o: CanvasObject): void {
  const id = c.nextShape++
  if (o.type === 'text') { c.shapes.push(textShape(o, id)); return }
  if (o.type === 'rect' || o.type === 'ellipse') {
    const geom = o.type === 'ellipse'
      ? '<a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom>'
      : o.radius > 0
        ? `<a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val ${Math.round(Math.min(50000, (o.radius / Math.max(1, Math.min(o.width, o.height))) * 100000))}"/></a:avLst></a:prstGeom>`
        : '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>'
    const ln = o.type === 'ellipse' ? line(o.stroke, o.strokeWidth, o.opacity) : '<a:ln><a:noFill/></a:ln>'
    c.shapes.push(`<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${esc(o.id)}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm(o)}${geom}${fill(o.fill, o.opacity)}${ln}</p:spPr></p:sp>`)
    return
  }
  if (o.type === 'line') {
    c.shapes.push(`<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="${id}" name="${esc(o.id)}"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr><p:spPr>${xfrm(o, true)}<a:prstGeom prst="line"><a:avLst/></a:prstGeom>${line(o.stroke, o.strokeWidth, o.opacity)}</p:spPr></p:cxnSp>`)
    return
  }
  // picture
  const img = c.loadImage(o.src)
  const ext = img ? IMAGE_EXT[img.mime.toLowerCase()] : undefined
  if (!img || !ext) {
    c.warnings.push(img ? `slide ${c.slideNo}: the picture ${o.src} is a ${img.mime} file, which PowerPoint cannot hold here (use PNG, JPEG or GIF); a grey box stands in its place` : `slide ${c.slideNo}: the picture ${o.src} was not found; a grey box stands in its place`)
    c.shapes.push(`<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${esc(o.id)}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm(o)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${fill('#e6e6e6')}${line('#b00020', 2)}</p:spPr>`
      + `<p:txBody><a:bodyPr lIns="45720" tIns="45720" rIns="45720" bIns="45720" anchor="ctr"/><a:lstStyle/><a:p><a:r><a:rPr lang="hu-HU" sz="1400"><a:solidFill><a:srgbClr val="B00020"/></a:solidFill></a:rPr><a:t>${esc(o.src)}</a:t></a:r></a:p></p:txBody></p:sp>`)
    return
  }
  c.mediaCount.n += 1
  const name = `image${c.mediaCount.n}.${ext}`
  c.media.push({ name, data: img.bytes })
  const rid = `rId${c.rels.length + 2}`
  c.rels.push({ id: rid, type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image', target: `../media/${name}` })
  // contain: shrink the box to the picture's proportions, centred; cover: crop the picture to fill the box
  let box = { x: o.x, y: o.y, width: o.width, height: o.height }
  let crop = ''
  const dim = imageSize(img.bytes)
  if (dim && dim.w > 0 && dim.h > 0) {
    const ir = dim.w / dim.h
    const br = o.width / o.height
    if (o.fit === 'contain') {
      if (ir > br) { const h = o.width / ir; box = { x: o.x, y: o.y + (o.height - h) / 2, width: o.width, height: h } } else { const w = o.height * ir; box = { x: o.x + (o.width - w) / 2, y: o.y, width: w, height: o.height } }
    } else if (ir > br) {
      const cut = Math.round(((1 - br / ir) / 2) * 100000)
      crop = `<a:srcRect l="${cut}" r="${cut}"/>`
    } else {
      const cut = Math.round(((1 - ir / br) / 2) * 100000)
      crop = `<a:srcRect t="${cut}" b="${cut}"/>`
    }
  }
  const alpha = o.opacity < 1 ? `<a:alphaModFix amt="${Math.round(o.opacity * 100000)}"/>` : ''
  c.shapes.push(`<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="${esc(o.id)}" descr="${esc(o.alt || o.src)}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>`
    + `<p:blipFill><a:blip r:embed="${rid}">${alpha}</a:blip>${crop}<a:stretch><a:fillRect/></a:stretch></p:blipFill>`
    + `<p:spPr>${xfrm({ ...box, rotation: o.rotation })}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`)
}

const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const rels = (list: { id: string; type: string; target: string }[]): string =>
  `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${list.map((r) => `<Relationship Id="${r.id}" Type="${r.type}" Target="${esc(r.target)}"/>`).join('')}</Relationships>`

const GROUP = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>'

function slideXml(s: DeckSlide, c: SlideCtx): string {
  const bg = hex(s.canvas.background) ?? 'FFFFFF'
  for (const o of s.canvas.objects) if (!o.hidden) addObject(c, o)
  return `${XML}<p:sld ${NS}><p:cSld name="${esc(s.id)}"><p:bg><p:bgPr><a:solidFill><a:srgbClr val="${bg}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree>${GROUP}${c.shapes.join('')}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`
}

function notesXml(text: string): string {
  const paras = text.split('\n').map((l) => `<a:p><a:r><a:rPr lang="hu-HU" dirty="0"/><a:t>${esc(l)}</a:t></a:r></a:p>`).join('')
  return `${XML}<p:notes ${NS}><p:cSld><p:spTree>${GROUP}`
    + '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp>'
    + `<p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${paras}</p:txBody></p:sp>`
    + '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>'
}

const THEME = `${XML}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Marvin"><a:themeElements>`
  + '<a:clrScheme name="Marvin"><a:dk1><a:srgbClr val="111111"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="333333"/></a:dk2><a:lt2><a:srgbClr val="EEEEEE"/></a:lt2>'
  + '<a:accent1><a:srgbClr val="2F6FDE"/></a:accent1><a:accent2><a:srgbClr val="D9534F"/></a:accent2><a:accent3><a:srgbClr val="5CB85C"/></a:accent3><a:accent4><a:srgbClr val="F0AD4E"/></a:accent4><a:accent5><a:srgbClr val="8E5CC6"/></a:accent5><a:accent6><a:srgbClr val="17A2B8"/></a:accent6>'
  + '<a:hlink><a:srgbClr val="2F6FDE"/></a:hlink><a:folHlink><a:srgbClr val="8E5CC6"/></a:folHlink></a:clrScheme>'
  + '<a:fontScheme name="Marvin"><a:majorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>'
  + '<a:fmtScheme name="Marvin"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>'
  + '<a:lnStyleLst><a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="28575"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>'
  + '<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>'
  + '<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme>'
  + '</a:themeElements></a:theme>'

const CLRMAP = '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>'

/** Build the PPTX of a deck. `loadImage` gives the bytes of a picture by its canvas `src` (null = not found). */
export function buildDeckPptx(deck: DeckDoc, loadImage: (src: string) => PptxImage | null, modified?: Date): PptxResult {
  const warnings: string[] = []
  fit = isCardSize(deck.size) ? FIT_CARD : FIT
  const slideCount = deck.slides.length
  if (!slideCount) throw new Error('deck_empty')
  const w = deck.slides[0].canvas.width
  const h = deck.slides[0].canvas.height
  const entries: ZipEntry[] = []
  const mediaCount = { n: 0 }
  const exts = new Set<string>()
  const hasNotes = deck.slides.some((s) => s.notes.trim())

  deck.slides.forEach((s, i) => {
    const n = i + 1
    const ctx: SlideCtx = { shapes: [], rels: [], media: [], nextShape: 2, warnings, slideNo: n, loadImage, mediaCount }
    ctx.rels.push({ id: 'rId1', type: `${REL}/slideLayout`, target: '../slideLayouts/slideLayout1.xml' })
    const xml = slideXml(s, ctx)
    const slideRels = ctx.rels.slice()
    if (s.notes.trim()) {
      slideRels.push({ id: `rId${slideRels.length + 1}`, type: `${REL}/notesSlide`, target: `../notesSlides/notesSlide${n}.xml` })
      entries.push({ name: `ppt/notesSlides/notesSlide${n}.xml`, data: notesXml(s.notes) })
      entries.push({ name: `ppt/notesSlides/_rels/notesSlide${n}.xml.rels`, data: rels([{ id: 'rId1', type: `${REL}/notesMaster`, target: '../notesMasters/notesMaster1.xml' }, { id: 'rId2', type: `${REL}/slide`, target: `../slides/slide${n}.xml` }]) })
    }
    entries.push({ name: `ppt/slides/slide${n}.xml`, data: xml })
    entries.push({ name: `ppt/slides/_rels/slide${n}.xml.rels`, data: rels(slideRels) })
    for (const m of ctx.media) { entries.push({ name: `ppt/media/${m.name}`, data: m.data }); exts.add(m.name.split('.').pop() as string) }
  })

  const slideIds = deck.slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 3}"/>`).join('')
  const presRels = [
    { id: 'rId1', type: `${REL}/slideMaster`, target: 'slideMasters/slideMaster1.xml' },
    { id: 'rId2', type: `${REL}/theme`, target: 'theme/theme1.xml' },
    ...deck.slides.map((_, i) => ({ id: `rId${i + 3}`, type: `${REL}/slide`, target: `slides/slide${i + 1}.xml` })),
  ]
  if (hasNotes) presRels.push({ id: `rId${slideCount + 3}`, type: `${REL}/notesMaster`, target: 'notesMasters/notesMaster1.xml' })
  entries.push({
    name: 'ppt/presentation.xml',
    data: `${XML}<p:presentation ${NS} saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>`
      + (hasNotes ? `<p:notesMasterIdLst><p:notesMasterId r:id="rId${slideCount + 3}"/></p:notesMasterIdLst>` : '')
      + `<p:sldIdLst>${slideIds}</p:sldIdLst><p:sldSz cx="${emu(w)}" cy="${emu(h)}"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`,
  })
  entries.push({ name: 'ppt/_rels/presentation.xml.rels', data: rels(presRels) })
  entries.push({ name: 'ppt/theme/theme1.xml', data: THEME })
  entries.push({
    name: 'ppt/slideMasters/slideMaster1.xml',
    data: `${XML}<p:sldMaster ${NS}><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree>${GROUP}</p:spTree></p:cSld>${CLRMAP}<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>`,
  })
  entries.push({ name: 'ppt/slideMasters/_rels/slideMaster1.xml.rels', data: rels([{ id: 'rId1', type: `${REL}/slideLayout`, target: '../slideLayouts/slideLayout1.xml' }, { id: 'rId2', type: `${REL}/theme`, target: '../theme/theme1.xml' }]) })
  entries.push({
    name: 'ppt/slideLayouts/slideLayout1.xml',
    data: `${XML}<p:sldLayout ${NS} type="blank" preserve="1"><p:cSld name="Blank"><p:spTree>${GROUP}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`,
  })
  entries.push({ name: 'ppt/slideLayouts/_rels/slideLayout1.xml.rels', data: rels([{ id: 'rId1', type: `${REL}/slideMaster`, target: '../slideMasters/slideMaster1.xml' }]) })
  if (hasNotes) {
    entries.push({
      name: 'ppt/notesMasters/notesMaster1.xml',
      data: `${XML}<p:notesMaster ${NS}><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree>${GROUP}`
        + '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg" idx="2"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="685800" y="1143000"/><a:ext cx="5486400" cy="3086100"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln w="12700"><a:solidFill><a:prstClr val="black"/></a:solidFill></a:ln></p:spPr></p:sp>'
        + '<p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" sz="quarter" idx="3"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="685800" y="4400550"/><a:ext cx="5486400" cy="3600450"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="hu-HU"/></a:p></p:txBody></p:sp>'
        + `</p:spTree></p:cSld>${CLRMAP}<p:notesStyle><a:lvl1pPr marL="0" algn="l"><a:defRPr sz="1200"/></a:lvl1pPr></p:notesStyle></p:notesMaster>`,
    })
    entries.push({ name: 'ppt/notesMasters/_rels/notesMaster1.xml.rels', data: rels([{ id: 'rId1', type: `${REL}/theme`, target: '../theme/theme2.xml' }]) })
    entries.push({ name: 'ppt/theme/theme2.xml', data: THEME })
  }
  entries.push({ name: '_rels/.rels', data: rels([{ id: 'rId1', type: `${REL}/officeDocument`, target: 'ppt/presentation.xml' }]) })
  const overrides = [
    ['/ppt/presentation.xml', 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml'],
    ['/ppt/slideMasters/slideMaster1.xml', 'application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml'],
    ['/ppt/slideLayouts/slideLayout1.xml', 'application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml'],
    ['/ppt/theme/theme1.xml', 'application/vnd.openxmlformats-officedocument.theme+xml'],
    ...deck.slides.map((_, i) => [`/ppt/slides/slide${i + 1}.xml`, 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml']),
    ...(hasNotes ? [['/ppt/notesMasters/notesMaster1.xml', 'application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml'], ['/ppt/theme/theme2.xml', 'application/vnd.openxmlformats-officedocument.theme+xml']] : []),
    ...deck.slides.flatMap((s, i) => (s.notes.trim() ? [[`/ppt/notesSlides/notesSlide${i + 1}.xml`, 'application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml']] : [])),
  ]
  const defaults = [['rels', 'application/vnd.openxmlformats-package.relationships+xml'], ['xml', 'application/xml'], ...[...exts].map((e) => [e, `image/${e}`])]
  entries.unshift({
    name: '[Content_Types].xml',
    data: `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${defaults.map(([e, t]) => `<Default Extension="${e}" ContentType="${t}"/>`).join('')}${overrides.map(([p, t]) => `<Override PartName="${p}" ContentType="${t}"/>`).join('')}</Types>`,
  })
  return { bytes: buildZip(entries, modified), warnings }
}
