/**
 * PPTX IMPORT (#501): a PowerPoint file becomes a presentation deck, one canvas per slide.
 * The reverse of `workbench-deck-pptx.ts`: text stays text, shapes stay shapes, pictures
 * stay pictures (saved through `saveImage`), speaker notes come along. What cannot be read
 * (charts, SmartArt, vector pictures) is named in `warnings`, never dropped silently.
 *
 * Pure apart from `saveImage`: no disk, no database. The XML is read with a small tag scanner,
 * the same way the table reader reads xlsx, so there is no extra dependency.
 */
import { readZip, xmlUnescape } from './workbench-table.js'
import { DECK_MAX_SLIDES, DECK_PIXELS, parseDeck, type DeckDoc, type DeckSize } from './workbench-deck.js'
import { CANVAS_MAX_OBJECTS, CANVAS_TEXT_MAX } from './workbench-graphic.js'

export type PptxImportResult =
  | { ok: true; deck: DeckDoc; warnings: string[] }
  | { ok: false; code: 'pptx_unreadable' | 'pptx_empty' | 'deck_invalid'; detail: string }

type Raw = Record<string, unknown>

const ZIP_MAX_ENTRY = 40 * 1024 * 1024

const attr = (tag: string, name: string): string | null => {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag)
  return m ? xmlUnescape(m[1]) : null
}

function relsOf(files: Map<string, Buffer>, part: string): Map<string, string> {
  const dir = part.slice(0, part.lastIndexOf('/') + 1)
  const base = part.slice(part.lastIndexOf('/') + 1)
  const buf = files.get(`${dir}_rels/${base}.rels`)
  const out = new Map<string, string>()
  if (!buf) return out
  for (const m of buf.toString('utf8').matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attr(m[0], 'Id')
    const target = attr(m[0], 'Target')
    if (id && target) out.set(id, resolvePath(dir, target))
  }
  return out
}

function resolvePath(dir: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1)
  const parts = (dir + target).split('/')
  const out: string[] = []
  for (const p of parts) {
    if (p === '..') out.pop()
    else if (p && p !== '.') out.push(p)
  }
  return out.join('/')
}

/** The theme colours by scheme name (tx1, bg1, accent1 ...). */
function themeColors(files: Map<string, Buffer>): Record<string, string> {
  const out: Record<string, string> = {}
  const name = [...files.keys()].find((k) => /^ppt\/theme\/theme\d+\.xml$/.test(k))
  if (!name) return out
  const xml = (files.get(name) as Buffer).toString('utf8')
  for (const slot of ['dk1', 'lt1', 'dk2', 'lt2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink']) {
    const m = new RegExp(`<a:${slot}>([\\s\\S]*?)</a:${slot}>`).exec(xml)
    if (!m) continue
    const c = /srgbClr val="([0-9a-fA-F]{6})"/.exec(m[1]) ?? /lastClr="([0-9a-fA-F]{6})"/.exec(m[1])
    if (c) out[slot] = `#${c[1].toLowerCase()}`
  }
  out['tx1'] = out['dk1'] ?? '#000000'
  out['bg1'] = out['lt1'] ?? '#ffffff'
  out['tx2'] = out['dk2'] ?? out['tx1']
  out['bg2'] = out['lt2'] ?? out['bg1']
  return out
}

function colorIn(xml: string, theme: Record<string, string>): string | null {
  const s = /<a:srgbClr\b[^>]*val="([0-9a-fA-F]{6})"/.exec(xml)
  if (s) return `#${s[1].toLowerCase()}`
  const t = /<a:schemeClr\b[^>]*val="([a-z0-9]+)"/.exec(xml)
  if (t) return theme[t[1]] ?? null
  return null
}

interface Box { x: number; y: number; w: number; h: number }

function boxOf(xml: string): { box: Box; rot: number } | null {
  const x = /<a:xfrm\b([^>]*)>\s*<a:off\b[^>]*\bx="(-?\d+)"[^>]*\by="(-?\d+)"[^>]*\/>\s*<a:ext\b[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"/.exec(xml)
  if (!x) return null
  const rot = Number(/\brot="(-?\d+)"/.exec(x[1])?.[1] ?? 0) / 60000
  return { box: { x: Number(x[2]), y: Number(x[3]), w: Number(x[4]), h: Number(x[5]) }, rot }
}

const phKey = (xml: string): string | null => {
  const m = /<p:ph\b[^>]*>/.exec(xml)
  if (!m) return null
  return `${attr(m[0], 'type') ?? 'body'}:${attr(m[0], 'idx') ?? '0'}`
}

/** Placeholder boxes of a layout (a slide's title/body usually inherit their position from it). */
function layoutBoxes(xml: string): Map<string, { box: Box; rot: number }> {
  const out = new Map<string, { box: Box; rot: number }>()
  for (const m of xml.matchAll(/<p:sp\b[\s\S]*?<\/p:sp>/g)) {
    const k = phKey(m[0])
    const b = boxOf(m[0])
    if (k && b) {
      out.set(k, b)
      const type = k.split(':')[0]
      if (!out.has(type)) out.set(type, b)
    }
  }
  return out
}

function textOf(sp: string, theme: Record<string, string>, scale: number): Raw | null {
  const body = /<p:txBody>([\s\S]*?)<\/p:txBody>/.exec(sp)
  if (!body) return null
  const paras: string[] = []
  let size = 0
  let bold = false
  let italic = false
  let color: string | null = null
  let align = 'left'
  let font = 'sans'
  let first = true
  for (const p of body[1].matchAll(/<a:p>([\s\S]*?)<\/a:p>|<a:p\/>/g)) {
    const inner = p[1] ?? ''
    if (first) {
      const al = /<a:pPr\b[^>]*\balgn="(\w+)"/.exec(inner)?.[1]
      if (al === 'ctr') align = 'center'
      else if (al === 'r') align = 'right'
    }
    let line = ''
    for (const t of inner.matchAll(/<a:r>([\s\S]*?)<\/a:r>|<a:br\s*\/>|<a:fld\b[\s\S]*?<\/a:fld>/g)) {
      if (t[0].startsWith('<a:br')) { line += '\n'; continue }
      const run = t[1] ?? t[0]
      const txt = /<a:t>([\s\S]*?)<\/a:t>|<a:t\/>/.exec(run)
      if (!txt) continue
      line += xmlUnescape(txt[1] ?? '')
      if (first || !size) {
        const rpr = /<a:rPr\b([^>]*?)(\/>|>[\s\S]*?<\/a:rPr>)/.exec(run)
        if (rpr) {
          const sz = Number(attr(rpr[0], 'sz'))
          if (sz > 0 && !size) size = sz
          if (/\bb="1"/.test(rpr[1])) bold = true
          if (/\bi="1"/.test(rpr[1])) italic = true
          color = color ?? colorIn(rpr[0], theme)
          const face = /<a:latin\b[^>]*typeface="([^"]*)"/.exec(rpr[0])?.[1] ?? ''
          if (/courier|consolas|mono/i.test(face)) font = 'mono'
          else if (/times|georgia|cambria|garamond|serif/i.test(face) && !/sans/i.test(face)) font = 'serif'
        }
      }
    }
    paras.push(line)
    first = false
  }
  const text = paras.join('\n').replace(/\n+$/, '')
  if (!text.trim()) return null
  return {
    type: 'text', text: text.slice(0, CANVAS_TEXT_MAX),
    fontSize: Math.max(8, Math.round((size > 0 ? size / 100 : 18) * 12700 * scale)),
    bold, italic, align, font, color: color ?? '#111111',
  }
}

/** Slide order: presentation.xml's sldIdLst through its relationships. */
function slideParts(files: Map<string, Buffer>): string[] {
  const pres = files.get('ppt/presentation.xml')
  if (!pres) return []
  const rels = relsOf(files, 'ppt/presentation.xml')
  const out: string[] = []
  for (const m of pres.toString('utf8').matchAll(/<p:sldId\b[^>]*>/g)) {
    const t = rels.get(attr(m[0], 'r:id') ?? '')
    if (t && files.has(t)) out.push(t)
  }
  return out
}

export function importPptx(
  buf: Buffer,
  saveImage: (name: string, bytes: Buffer) => string | null,
): PptxImportResult {
  const zip = readZip(buf)
  if (!zip) return { ok: false, code: 'pptx_unreadable', detail: 'the file is not a readable .pptx (zip) file' }
  const files = new Map<string, Buffer>()
  for (const z of zip) if (z.data.length <= ZIP_MAX_ENTRY) files.set(z.name, z.data)
  const parts = slideParts(files)
  if (!parts.length) return { ok: false, code: 'pptx_empty', detail: 'the file has no slides' }

  const pres = (files.get('ppt/presentation.xml') as Buffer).toString('utf8')
  const sz = /<p:sldSz\b[^>]*>/.exec(pres)
  const cx = Number(sz ? attr(sz[0], 'cx') : 0) || 12192000
  const cy = Number(sz ? attr(sz[0], 'cy') : 0) || 6858000
  const size: DeckSize = cx / cy >= 1.6 ? '16:9' : '4:3'
  const px = DECK_PIXELS[size]
  const scale = px.width / cx
  const theme = themeColors(files)
  const warnings: string[] = []
  if (parts.length > DECK_MAX_SLIDES) warnings.push(`the file has ${parts.length} slides, only the first ${DECK_MAX_SLIDES} were imported`)
  const skipped = new Set<string>()

  const slides: Raw[] = []
  parts.slice(0, DECK_MAX_SLIDES).forEach((part, si) => {
    const xml = (files.get(part) as Buffer).toString('utf8')
    const rels = relsOf(files, part)
    const layoutPart = [...rels.values()].find((t) => t.startsWith('ppt/slideLayouts/'))
    const lay = layoutPart && files.has(layoutPart) ? layoutBoxes((files.get(layoutPart) as Buffer).toString('utf8')) : new Map()
    const objects: Raw[] = []
    const put = (o: Raw): void => { if (objects.length < CANVAS_MAX_OBJECTS) objects.push({ id: `s${si + 1}o${objects.length + 1}`, ...o }) }
    const place = (o: Raw, b: { box: Box; rot: number }): Raw => {
      const r: Raw = {
        ...o, x: Math.round(b.box.x * scale), y: Math.round(b.box.y * scale),
        width: Math.max(1, Math.round(b.box.w * scale)), height: Math.max(1, Math.round(b.box.h * scale)),
      }
      if (b.rot) r['rotation'] = b.rot
      return r
    }

    const bg = /<p:bg>([\s\S]*?)<\/p:bg>/.exec(xml)
    const background = (bg && colorIn(bg[1], theme)) || '#ffffff'

    for (const m of xml.matchAll(/<p:(sp|pic|cxnSp|graphicFrame)\b[\s\S]*?<\/p:\1>/g)) {
      const el = m[0]
      const kind = m[1]
      if (kind === 'graphicFrame') {
        skipped.add(/<a:tbl>/.test(el) ? 'tables' : 'charts or diagrams')
        continue
      }
      const ph = phKey(el)
      const b = boxOf(el) ?? (ph ? lay.get(ph) ?? lay.get(ph.split(':')[0]) ?? null : null)
      if (!b) continue
      if (kind === 'pic') {
        const rid = /<a:blip\b[^>]*r:embed="([^"]+)"/.exec(el)?.[1]
        const target = rid ? rels.get(rid) : undefined
        const data = target ? files.get(target) : undefined
        if (!target || !data) continue
        const ext = (/\.([a-z0-9]+)$/i.exec(target)?.[1] ?? '').toLowerCase()
        if (!['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) { skipped.add(`${ext || 'unknown'} pictures`); continue }
        const src = saveImage(`slide${si + 1}-${target.split('/').pop()}`, data)
        if (!src) { skipped.add('pictures that could not be saved'); continue }
        put(place({ type: 'image', src, fit: 'contain', alt: attr(/<p:cNvPr\b[^>]*>/.exec(el)?.[0] ?? '', 'descr') ?? '' }, b))
        continue
      }
      const spPr = /<p:spPr\b[\s\S]*?<\/p:spPr>|<p:spPr\/>/.exec(el)?.[0] ?? ''
      const prst = /<a:prstGeom\b[^>]*prst="(\w+)"/.exec(spPr)?.[1] ?? 'rect'
      const noFill = /<a:noFill\/>/.test(spPr.replace(/<a:ln\b[\s\S]*?<\/a:ln>/g, ''))
      const fillXml = spPr.replace(/<a:ln\b[\s\S]*?<\/a:ln>/g, '')
      const fill = noFill ? null : colorIn(/<a:solidFill>[\s\S]*?<\/a:solidFill>/.exec(fillXml)?.[0] ?? '', theme)
      const ln = /<a:ln\b([^>]*)>([\s\S]*?)<\/a:ln>/.exec(spPr)
      const stroke = ln && !/<a:noFill\/>/.test(ln[2]) ? colorIn(ln[2], theme) : null
      const strokeWidth = ln ? Math.max(1, Math.round((Number(attr(ln[0], 'w')) || 12700) * scale)) : 0
      if (kind === 'cxnSp' || prst === 'line' || prst === 'straightConnector1') {
        put(place({ type: 'line', stroke: stroke ?? '#111111', strokeWidth: strokeWidth || 3 }, { box: { ...b.box, y: b.box.y + b.box.h / 2, h: 1 }, rot: b.rot }))
        continue
      }
      if (fill || stroke) {
        if (prst === 'ellipse') put(place({ type: 'ellipse', fill: fill ?? 'none', stroke: stroke ?? 'none', strokeWidth }, b))
        else put(place({ type: 'rect', fill: fill ?? 'none', radius: /roundRect/.test(prst) ? Math.round(Math.min(b.box.w, b.box.h) * scale * 0.12) : 0 }, b))
      }
      const t = textOf(el, theme, scale)
      if (t) put(place(t, b))
    }

    let notes = ''
    const np = [...rels.values()].find((t) => t.startsWith('ppt/notesSlides/'))
    if (np && files.has(np)) {
      const nx = (files.get(np) as Buffer).toString('utf8')
      for (const sp of nx.matchAll(/<p:sp\b[\s\S]*?<\/p:sp>/g)) {
        if (!/<p:ph\b[^>]*type="body"/.test(sp[0])) continue
        notes = [...sp[0].matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)]
          .map((p) => [...p[1].matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((t) => xmlUnescape(t[1])).join(''))
          .join('\n').trim()
      }
    }
    slides.push({ id: `d${si + 1}`, notes, canvas: { version: 1, width: px.width, height: px.height, background, objects } })
  })
  for (const s of skipped) warnings.push(`${s} are not imported`)

  const parsed = parseDeck({ version: 1, size, slides })
  if (!parsed.ok) return { ok: false, code: 'deck_invalid', detail: parsed.detail }
  return { ok: true, deck: parsed.doc, warnings }
}
