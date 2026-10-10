/**
 * Inline formatting of a document block (bold, italic, underline, strike) and its alignment.
 *
 * The block's `text` stays the plain text every other part of the system works on (claims,
 * checks, translation, search). The formatting rides next to it as `rich`, a tiny HTML subset
 * (<b> <i> <u> <s> <br> and one <span style> for font, size, colour and highlight), and `align`. `rich` is only trusted while its plain text equals the
 * block's `text`: when something else rewrites the text (an agent, a label renumbering), the
 * formatting is simply ignored instead of being painted on the wrong words.
 */

export const BLOCK_ALIGNS = ['l', 'c', 'r', 'j'] as const
export type BlockAlign = (typeof BLOCK_ALIGNS)[number]

export function isBlockAlign(v: unknown): v is BlockAlign {
  return typeof v === 'string' && (BLOCK_ALIGNS as readonly string[]).includes(v)
}

const ENT: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' }

function decode(s: string): string {
  return s.replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (m) => ENT[m] ?? m)
}

function encode(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export interface RichRun {
  text: string; b: boolean; i: boolean; u: boolean; s: boolean
  /** Font family (one of RICH_FONTS), '' = the document's own. */
  f: string
  /** Font size in pt (6..96, halves), 0 = the document's own. */
  z: number
  /** Text colour #rrggbb, '' = the document's own. */
  c: string
  /** Highlight (background) colour #rrggbb, '' = none. */
  h: string
}

/** The font families the editor offers. Anything else is dropped: the list is also what the renderer is known to map. */
export const RICH_FONTS = ['Times New Roman', 'Arial', 'Courier New', 'Georgia', 'Verdana', 'Calibri'] as const

function fontOf(raw: string): string {
  const first = raw.split(',')[0]?.replace(/["']/g, '').trim().toLowerCase() ?? ''
  if (!first) return ''
  const alias: Record<string, string> = { 'liberation serif': 'Times New Roman', 'liberation sans': 'Arial', 'liberation mono': 'Courier New', serif: 'Times New Roman', 'sans-serif': 'Arial', monospace: 'Courier New' }
  const hit = (RICH_FONTS as readonly string[]).find((n) => n.toLowerCase() === first)
  return hit ?? alias[first] ?? ''
}

function sizeOf(raw: string): number {
  const m = /^\s*([\d.]+)\s*(pt|px)?\s*$/i.exec(raw)
  if (!m) return 0
  let v = Number(m[1])
  if ((m[2] ?? 'pt').toLowerCase() === 'px') v = v * 0.75
  if (!Number.isFinite(v)) return 0
  v = Math.round(v * 2) / 2
  return v >= 6 && v <= 96 ? v : 0
}

function colorOf(raw: string): string {
  const v = raw.trim().toLowerCase()
  let m = /^#([0-9a-f]{6})$/.exec(v)
  if (m) return '#' + m[1]
  m = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(v)
  if (m) return '#' + m[1]! + m[1]! + m[2]! + m[2]! + m[3]! + m[3]!
  m = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(v)
  if (m) {
    if (m[4] !== undefined && Number(m[4]) === 0) return ''
    const hex = (n: string): string => Math.min(255, Number(n)).toString(16).padStart(2, '0')
    return '#' + hex(m[1]!) + hex(m[2]!) + hex(m[3]!)
  }
  return ''
}

interface RunProps { f: string; z: number; c: string; h: string }

function styleProps(style: string): Partial<RunProps> {
  const out: Partial<RunProps> = {}
  for (const decl of style.split(';')) {
    const at = decl.indexOf(':')
    if (at < 0) continue
    const k = decl.slice(0, at).trim().toLowerCase()
    const v = decl.slice(at + 1).trim()
    if (k === 'font-family') { const f = fontOf(v); if (f) out.f = f }
    else if (k === 'font-size') { const z = sizeOf(v); if (z) out.z = z }
    else if (k === 'color') { const c = colorOf(v); if (c) out.c = c }
    else if (k === 'background-color' || k === 'background') { const h = colorOf(v); if (h) out.h = h }
  }
  return out
}

function attrProps(tag: string, attrs: string): Partial<RunProps> {
  const out: Partial<RunProps> = {}
  const st = /\bstyle\s*=\s*"([^"]*)"|\bstyle\s*=\s*'([^']*)'/i.exec(attrs)
  if (st) Object.assign(out, styleProps(decode(st[1] ?? st[2] ?? '')))
  if (tag === 'font') {
    const face = /\bface\s*=\s*"([^"]*)"|\bface\s*=\s*'([^']*)'/i.exec(attrs)
    if (face) { const f = fontOf(decode(face[1] ?? face[2] ?? '')); if (f) out.f = f }
    const col = /\bcolor\s*=\s*"([^"]*)"|\bcolor\s*=\s*'([^']*)'/i.exec(attrs)
    if (col) { const c = colorOf(decode(col[1] ?? col[2] ?? '')); if (c) out.c = c }
  }
  return out
}

const TAG_RE = /<(\/?)(b|strong|i|em|u|s|strike|del|br|span|font)\b([^>]*)>|<[^>]*>/gi
const CANON: Record<string, 'b' | 'i' | 'u' | 's' | 'br'> = {
  b: 'b', strong: 'b', i: 'i', em: 'i', u: 'u', s: 's', strike: 's', del: 's', br: 'br',
}

/** The runs of a rich string: consecutive characters sharing one set of marks. Unknown tags are dropped. */
export function richRuns(input: string): RichRun[] {
  const runs: RichRun[] = []
  const on = { b: 0, i: 0, u: 0, s: 0 }
  const stack: RunProps[] = []
  let cur: RunProps = { f: '', z: 0, c: '', h: '' }
  let last = 0
  const push = (raw: string): void => {
    const text = decode(raw)
    if (!text) return
    const r: RichRun = { text, b: on.b > 0, i: on.i > 0, u: on.u > 0, s: on.s > 0, f: cur.f, z: cur.z, c: cur.c, h: cur.h }
    const p = runs[runs.length - 1]
    if (p && p.b === r.b && p.i === r.i && p.u === r.u && p.s === r.s && p.f === r.f && p.z === r.z && p.c === r.c && p.h === r.h) p.text += text
    else runs.push(r)
  }
  const src = String(input ?? '')
  for (const m of src.matchAll(TAG_RE)) {
    push(src.slice(last, m.index ?? 0))
    last = (m.index ?? 0) + m[0].length
    const tag = m[2]?.toLowerCase()
    if (!tag) continue
    const closing = m[1] === '/'
    if (tag === 'span' || tag === 'font') {
      if (closing) { cur = stack.pop() ?? cur; continue }
      if (/\/\s*>$/.test(m[0])) continue
      stack.push(cur)
      cur = { ...cur, ...attrProps(tag, m[3] ?? '') }
      continue
    }
    const name = CANON[tag]
    if (!name) continue
    if (name === 'br') { push('\n'); continue }
    on[name] = Math.max(0, on[name] + (closing ? -1 : 1))
  }
  push(src.slice(last))
  return runs
}

/** The plain text of a rich string (what the block's `text` must equal). */
export function richToPlain(input: string): string {
  return richRuns(input).map((r) => r.text).join('')
}

/** The style attribute of a run's character properties ('' when it has none). Fixed order: the client writes the same. */
export function runStyle(r: Pick<RichRun, 'f' | 'z' | 'c' | 'h'>): string {
  const parts: string[] = []
  if (r.f) parts.push(`font-family:${r.f}`)
  if (r.z) parts.push(`font-size:${r.z}pt`)
  if (r.c) parts.push(`color:${r.c}`)
  if (r.h) parts.push(`background-color:${r.h}`)
  return parts.join(';')
}

const hasFormat = (r: RichRun): boolean => r.b || r.i || r.u || r.s || !!(r.f || r.z || r.c || r.h)

/** Canonical rich string: <b><i><u><s>, one outer <span style> for font / size / colours, <br>; '' when nothing is formatted. */
export function sanitizeRich(input: unknown): string {
  const runs = richRuns(String(input ?? ''))
  if (!runs.some(hasFormat)) return ''
  return runs.map((r) => {
    let out = encode(r.text).replace(/\n/g, '<br>')
    if (r.s) out = `<s>${out}</s>`
    if (r.u) out = `<u>${out}</u>`
    if (r.i) out = `<i>${out}</i>`
    if (r.b) out = `<b>${out}</b>`
    const st = runStyle(r)
    if (st) out = `<span style="${st}">${out}</span>`
    return out
  }).join('')
}

/** Does this rich string describe exactly this plain text? */
export function richMatches(rich: string | null | undefined, text: string): boolean {
  if (!rich) return false
  return richToPlain(rich).replace(/\r\n/g, '\n').trim() === String(text ?? '').replace(/\r\n/g, '\n').trim()
}

// ---- paragraph formatting ---------------------------------------------------------------------

/** Line spacing, space after the paragraph, indent and heading level of one block. */
export interface ParaFmt { ls?: number; sa?: number; ind?: number; h?: 1 | 2 | 3 }

export const LINE_SPACINGS = [1, 1.15, 1.5, 2, 2.5, 3] as const

/** A paragraph format from client input (object or JSON text). Unknown or out-of-range values are dropped; null when empty. */
export function sanitizePfmt(input: unknown): ParaFmt | null {
  let v: unknown = input
  if (typeof v === 'string') { try { v = JSON.parse(v) } catch { return null } }
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const out: ParaFmt = {}
  const ls = Number(o['ls'])
  if ((LINE_SPACINGS as readonly number[]).includes(ls) && ls !== 1) out.ls = ls
  const sa = Number(o['sa'])
  if (o['sa'] !== undefined && o['sa'] !== null && o['sa'] !== '' && Number.isFinite(sa) && sa >= 0 && sa <= 72) out.sa = Math.round(sa)
  const ind = Number(o['ind'])
  if (Number.isFinite(ind) && ind >= 1 && ind <= 8) out.ind = Math.round(ind)
  const h = Number(o['h'])
  if (h === 1 || h === 2 || h === 3) out.h = h
  return Object.keys(out).length ? out : null
}

/** Stored (JSON text) -> object, or null. */
export function parsePfmt(stored: string | null | undefined): ParaFmt | null {
  return stored ? sanitizePfmt(stored) : null
}

/** Canonical stored text (fixed key order), or null when there is nothing to store. */
export function pfmtToStored(p: ParaFmt | null): string | null {
  if (!p) return null
  const o: ParaFmt = {}
  if (p.ls !== undefined) o.ls = p.ls
  if (p.sa !== undefined) o.sa = p.sa
  if (p.ind !== undefined) o.ind = p.ind
  if (p.h !== undefined) o.h = p.h
  return Object.keys(o).length ? JSON.stringify(o) : null
}
