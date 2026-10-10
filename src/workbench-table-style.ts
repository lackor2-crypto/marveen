/**
 * Cell formatting of an .xlsx (#526, part 3, section A): font (bold, italic, underline,
 * strike, size, name, colour), fill colour, horizontal / vertical alignment and wrapping;
 * section B adds the cell borders (the four sides, line style and colour).
 *
 * Reading: a cell's `s` attribute indexes `cellXfs` in styles.xml; the xf points at a
 * font and a fill. That is turned into a small, editor-neutral CellStyle.
 *
 * Section C adds the number format (`nf`, the format code: "0.00", "0%", "yyyy-mm-dd", ...).
 *
 * Writing: the save NEVER rewrites an existing xf (other cells share it). A cell whose
 * style was changed in the editor gets a NEW xf appended at the end of `cellXfs` -- a copy
 * of the one it had, with only the changed parts replaced (a new font / fill appended when
 * needed). A cell nobody touched keeps its `s`, byte for byte.
 *
 * The editor sends the style a cell has NOW (all supported properties). Each property is
 * compared with what the READ side reported for the cell's original xf: equal -> the
 * original (possibly a theme colour the editor cannot show) stays as it was.
 */

/** The line styles of an .xlsx border, in the order of Univer's BorderStyleTypes (1..13). */
export const BORDER_STYLES = [
  'thin', 'hair', 'dotted', 'dashed', 'dashDot', 'dashDotDot', 'double', 'medium',
  'mediumDashed', 'mediumDashDot', 'mediumDashDotDot', 'slantDashDot', 'thick',
] as const
export type BorderStyleName = (typeof BORDER_STYLES)[number]

/** One side of a cell: the line style and its colour ("#RRGGBB"; absent = black). */
export interface BorderEdge {
  s: BorderStyleName
  c?: string
}

/** The four sides of a cell: top, right, bottom, left. A side that is absent has no line. */
export interface CellBorder {
  t?: BorderEdge
  r?: BorderEdge
  b?: BorderEdge
  l?: BorderEdge
}

const SIDES = ['t', 'r', 'b', 'l'] as const
const SIDE_XML: Record<(typeof SIDES)[number], string> = { t: 'top', r: 'right', b: 'bottom', l: 'left' }

export interface CellStyle {
  b?: boolean
  i?: boolean
  u?: boolean
  /** strike-through */
  s?: boolean
  /** font size in points */
  fs?: number
  /** font name */
  ff?: string
  /** font colour, "#RRGGBB" */
  fc?: string
  /** fill colour, "#RRGGBB" */
  bg?: string
  /** horizontal alignment: left, centre, right, justify */
  ha?: 'l' | 'c' | 'r' | 'j'
  /** vertical alignment: top, middle, bottom */
  va?: 't' | 'm' | 'b'
  /** wrap text */
  wr?: boolean
  /** borders */
  bd?: CellBorder
  /** number format code ("0.00", "0%", "yyyy-mm-dd"); absent = General */
  nf?: string
}

// ---- number formats (#526, part 3, section C) ----------------------------------------

/** The built-in number formats whose display is a date or a time. */
export const BUILTIN_DATE_FMTS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 30, 36, 45, 46, 47, 50, 57])

/** Quoted text, [colour] / [$-locale] and escaped characters left out, is there a date or time part. */
export function isDateFormatCode(code: string): boolean {
  const c = code.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '').replace(/\\./g, '')
  return /[dmyhs]/i.test(c) && !/^[#0.,%\s-]*$/.test(c)
}

/**
 * The built-in formats as a code the editor can show. The date ones are the locale's short
 * date in Excel; they read as ISO here, the way the table shows dates everywhere else.
 */
const BUILTIN_NUMFMT: Record<number, string> = {
  1: '0', 2: '0.00', 3: '#,##0', 4: '#,##0.00',
  5: '"$"#,##0_);\\("$"#,##0\\)', 6: '"$"#,##0_);[Red]\\("$"#,##0\\)',
  7: '"$"#,##0.00_);\\("$"#,##0.00\\)', 8: '"$"#,##0.00_);[Red]\\("$"#,##0.00\\)',
  9: '0%', 10: '0.00%', 11: '0.00E+00', 12: '# ?/?', 13: '# ??/??',
  14: 'yyyy-mm-dd', 15: 'd-mmm-yy', 16: 'd-mmm', 17: 'mmm-yy', 18: 'h:mm AM/PM', 19: 'h:mm:ss AM/PM',
  20: 'h:mm', 21: 'h:mm:ss', 22: 'yyyy-mm-dd h:mm',
  37: '#,##0_);\\(#,##0\\)', 38: '#,##0_);[Red]\\(#,##0\\)', 39: '#,##0.00_);\\(#,##0.00\\)', 40: '#,##0.00_);[Red]\\(#,##0.00\\)',
  45: 'mm:ss', 46: '[h]:mm:ss', 47: 'mm:ss.0', 48: '##0.0E+0', 49: '@',
}
/** The ones a code is written back as (a custom entry is added for every other code). */
const BUILTIN_WRITABLE = [1, 2, 3, 4, 9, 10, 11, 12, 13, 20, 21, 37, 38, 39, 40, 45, 46, 48, 49]

/** One spelling of "no number format": General, empty, absent. */
const nfKey = (v: string | undefined | null): string | null => (!v || v.trim() === '' || v.trim().toLowerCase() === 'general' ? null : v)

const HA_TO_XML: Record<string, string> = { l: 'left', c: 'center', r: 'right', j: 'justify' }
const HA_FROM_XML: Record<string, CellStyle['ha']> = { left: 'l', center: 'c', centerContinuous: 'c', right: 'r', justify: 'j', distributed: 'j' }
const VA_TO_XML: Record<string, string> = { t: 'top', m: 'center', b: 'bottom' }
const VA_FROM_XML: Record<string, CellStyle['va']> = { top: 't', center: 'm', bottom: 'b', justify: 'm', distributed: 'm' }

const INDEXED = [
  '000000', 'FFFFFF', 'FF0000', '00FF00', '0000FF', 'FFFF00', 'FF00FF', '00FFFF',
  '000000', 'FFFFFF', 'FF0000', '00FF00', '0000FF', 'FFFF00', 'FF00FF', '00FFFF',
  '800000', '008000', '000080', '808000', '800080', '008080', 'C0C0C0', '808080',
  '9999FF', '993366', 'FFFFCC', 'CCFFFF', '660066', 'FF8080', '0066CC', 'CCCCFF',
  '000080', 'FF00FF', 'FFFF00', '00FFFF', '800080', '800000', '008080', '0000FF',
  '00CCFF', 'CCFFFF', 'CCFFCC', 'FFFF99', '99CCFF', 'FF99CC', 'CC99FF', 'FFCC99',
  '3366FF', '33CCCC', '99CC00', 'FFCC00', 'FF9900', 'FF6600', '666699', '969696',
  '003366', '339966', '003300', '333300', '993300', '993366', '333399', '333333',
  '000000', 'FFFFFF',
]

// The Office theme: lt1, dk1, lt2, dk2, accent1..6 -- the order `theme="n"` counts in.
const DEFAULT_THEME = ['FFFFFF', '000000', 'E7E6E6', '44546A', '4472C4', 'ED7D31', 'A5A5A5', 'FFC000', '5B9BD5', '70AD47']

function attrsOf(s: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of s.matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) out[m[1]!] = m[2]!
  return out
}

function unescapeXml(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function rgbToHls(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255
  const mx = Math.max(r, g, b)
  const mn = Math.min(r, g, b)
  const l = (mx + mn) / 2
  if (mx === mn) return [0, l, 0]
  const d = mx - mn
  const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn)
  let h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4
  h /= 6
  return [h, l, s]
}

function hlsToRgb(h: number, l: number, s: number): [number, number, number] {
  if (s === 0) return [l, l, l]
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const f = (t: number): number => {
    if (t < 0) t += 1
    if (t > 1) t -= 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }
  return [f(h + 1 / 3), f(h), f(h - 1 / 3)]
}

function tinted(hex: string, tint: number): string {
  if (!tint) return hex
  const n = parseInt(hex, 16)
  const [h, l0, s] = rgbToHls((n >> 16) & 255, (n >> 8) & 255, n & 255)
  const l = tint < 0 ? l0 * (1 + tint) : l0 * (1 - tint) + tint
  const [r, g, b] = hlsToRgb(h, Math.min(1, Math.max(0, l)), s)
  const to = (x: number): string => Math.round(x * 255).toString(16).padStart(2, '0')
  return (to(r) + to(g) + to(b)).toUpperCase()
}

export interface StyleBook {
  xml: string
  prefix: string
  fonts: string[]
  fills: string[]
  borders: string[]
  /** The file has no <borders> part: a virtual default border stands at index 0 and the part is made on save. */
  bordersMissing: boolean
  xfs: string[]
  theme: string[]
  /** The file's own number formats (id -> code). */
  numFmts: Map<number, string>
  /** The file has a <numFmts> part (if not, it is made on save, ahead of the fonts). */
  numFmtsPart: boolean
}

const section = (xml: string, tag: string): { open: string; body: string; close: string; start: number; end: number; pre: string } | null => {
  const m = new RegExp(`<((?:\\w+:)?)${tag}\\b([^>]*)>([\\s\\S]*?)</\\1${tag}>`).exec(xml)
  if (!m) return null
  return { open: `<${m[1]}${tag}${m[2]}>`, body: m[3]!, close: `</${m[1]}${tag}>`, start: m.index, end: m.index + m[0].length, pre: m[1]! }
}

function elements(body: string, tag: string): string[] {
  return [...body.matchAll(new RegExp(`<(?:\\w+:)?${tag}\\b[^>]*?(?:/>|>[\\s\\S]*?</(?:\\w+:)?${tag}>)`, 'g'))].map((m) => m[0])
}

/** The parts of styles.xml the formatting needs, or null when the file has no usable stylesheet. */
export function parseStyleBook(stylesXml: string | null, themeXml: string | null): StyleBook | null {
  if (!stylesXml) return null
  const fonts = section(stylesXml, 'fonts')
  const fills = section(stylesXml, 'fills')
  const xfs = section(stylesXml, 'cellXfs')
  const borders = section(stylesXml, 'borders')
  const nfs = section(stylesXml, 'numFmts')
  const numFmts = new Map<number, string>()
  if (nfs) {
    for (const e of elements(nfs.body, 'numFmt')) {
      const a = attrsOf(e)
      if (a['numFmtId'] != null && a['formatCode'] != null && Number.isInteger(Number(a['numFmtId']))) numFmts.set(Number(a['numFmtId']), unescapeXml(a['formatCode']))
    }
  }
  if (!fonts || !fills || !xfs) return null
  const theme = DEFAULT_THEME.slice()
  if (themeXml) {
    const scheme = /<(?:\w+:)?clrScheme\b[^>]*>([\s\S]*?)<\/(?:\w+:)?clrScheme>/.exec(themeXml)
    if (scheme) {
      const names = ['lt1', 'dk1', 'lt2', 'dk2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6']
      names.forEach((n, i) => {
        const m = new RegExp(`<(?:\\w+:)?${n}\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?${n}>`).exec(scheme[1]!)
        if (!m) return
        const rgb = /srgbClr\s+val="([0-9A-Fa-f]{6})"/.exec(m[1]!)?.[1] || /lastClr="([0-9A-Fa-f]{6})"/.exec(m[1]!)?.[1]
        if (rgb) theme[i] = rgb.toUpperCase()
      })
    }
  }
  return {
    xml: stylesXml, prefix: xfs.pre, fonts: elements(fonts.body, 'font'), fills: elements(fills.body, 'fill'),
    borders: borders ? elements(borders.body, 'border') : [`<${xfs.pre}border><${xfs.pre}left/><${xfs.pre}right/><${xfs.pre}top/><${xfs.pre}bottom/><${xfs.pre}diagonal/></${xfs.pre}border>`],
    bordersMissing: !borders, xfs: elements(xfs.body, 'xf'), theme, numFmts, numFmtsPart: !!nfs,
  }
}

function colorOf(sb: StyleBook, tag: string): string | undefined {
  const a = attrsOf(tag)
  if (a['auto'] === '1') return undefined
  let hex: string | undefined
  if (a['rgb'] && /^[0-9A-Fa-f]{8}$/.test(a['rgb'])) hex = a['rgb'].slice(2).toUpperCase()
  else if (a['theme'] != null && sb.theme[Number(a['theme'])]) hex = sb.theme[Number(a['theme'])]
  else if (a['indexed'] != null && INDEXED[Number(a['indexed'])]) hex = INDEXED[Number(a['indexed'])]
  if (!hex) return undefined
  const tint = Number(a['tint'])
  return '#' + (Number.isFinite(tint) && tint ? tinted(hex, tint) : hex)
}

function fontStyle(sb: StyleBook, font: string | undefined): CellStyle {
  const out: CellStyle = {}
  if (!font) return out
  const has = (tag: string): boolean => {
    const m = new RegExp(`<(?:\\w+:)?${tag}\\b([^>]*)/?>`).exec(font)
    return !!m && attrsOf(m[1]!)['val'] !== '0' && attrsOf(m[1]!)['val'] !== 'false'
  }
  if (has('b')) out.b = true
  if (has('i')) out.i = true
  if (has('strike')) out.s = true
  const u = /<(?:\w+:)?u\b([^>]*)\/?>/.exec(font)
  if (u && (attrsOf(u[1]!)['val'] || 'single') !== 'none') out.u = true
  const sz = /<(?:\w+:)?sz\b([^>]*)\/?>/.exec(font)
  if (sz) { const n = Number(attrsOf(sz[1]!)['val']); if (Number.isFinite(n) && n > 0) out.fs = n }
  const nm = /<(?:\w+:)?name\b([^>]*)\/?>/.exec(font)
  if (nm && attrsOf(nm[1]!)['val']) out.ff = unescapeXml(attrsOf(nm[1]!)['val']!)
  const col = /<(?:\w+:)?color\b([^>]*)\/?>/.exec(font)
  if (col) { const c = colorOf(sb, col[1]!); if (c && c !== '#000000') out.fc = c }
  return out
}

function fillColor(sb: StyleBook, fill: string | undefined): string | undefined {
  if (!fill) return undefined
  const pf = /<(?:\w+:)?patternFill\b([^>]*)>/.exec(fill)
  if (!pf) return undefined
  if (attrsOf(pf[1]!)['patternType'] !== 'solid') return undefined
  const fg = /<(?:\w+:)?fgColor\b([^>]*)\/?>/.exec(fill)
  return fg ? colorOf(sb, fg[1]!) : undefined
}

/** The four sides of a <border> element; undefined when it has no line at all. */
function borderOf(sb: StyleBook, border: string | undefined): CellBorder | undefined {
  if (!border) return undefined
  const out: CellBorder = {}
  for (const k of SIDES) {
    const tag = SIDE_XML[k]
    const m = new RegExp(`<(?:\\w+:)?${tag}\\b([^>]*?)(?:/>|>([\\s\\S]*?)</(?:\\w+:)?${tag}>)`).exec(border)
    if (!m) continue
    const style = attrsOf(m[1]!)['style']
    if (!style || !(BORDER_STYLES as readonly string[]).includes(style)) continue
    const edge: BorderEdge = { s: style as BorderStyleName }
    const col = m[2] ? /<(?:\w+:)?color\b([^>]*?)\/?>/.exec(m[2]) : null
    const c = col ? colorOf(sb, col[1]!) : undefined
    // Black is what a line without a colour is: one spelling for both.
    if (c && c !== '#000000') edge.c = c
    out[k] = edge
  }
  return Object.keys(out).length ? out : undefined
}

/** The format code of a number-format id of this file; undefined for General and for a format nothing is known about. */
function numFmtCode(sb: StyleBook, id: number): string | undefined {
  if (!id) return undefined
  const own = sb.numFmts.get(id)
  if (own !== undefined) return nfKey(own) ? own : undefined
  if (BUILTIN_NUMFMT[id] !== undefined) return BUILTIN_NUMFMT[id]
  if (BUILTIN_DATE_FMTS.has(id)) return 'yyyy-mm-dd'
  return undefined
}

/** The supported properties of the cell format `xfIndex` (null/missing = the default look). */
export function xfStyle(sb: StyleBook, xfIndex: number | null): CellStyle {
  const xf = xfIndex != null ? sb.xfs[xfIndex] : undefined
  if (!xf) return {}
  const a = attrsOf(/^<[^>]*>/.exec(xf)![0])
  const out: CellStyle = { ...fontStyle(sb, sb.fonts[Number(a['fontId'] || 0)]) }
  const bg = fillColor(sb, sb.fills[Number(a['fillId'] || 0)])
  if (bg) out.bg = bg
  const bd = borderOf(sb, sb.borders[Number(a['borderId'] || 0)])
  if (bd) out.bd = bd
  const nf = numFmtCode(sb, Number(a['numFmtId'] || 0))
  if (nf) out.nf = nf
  const al = /<(?:\w+:)?alignment\b([^>]*)\/?>/.exec(xf)
  if (al) {
    const aa = attrsOf(al[1]!)
    const h = HA_FROM_XML[aa['horizontal'] || '']
    if (h) out.ha = h
    const v = VA_FROM_XML[aa['vertical'] || '']
    if (v && aa['vertical'] !== 'bottom') out.va = v
    else if (aa['vertical'] === 'bottom') out.va = 'b'
    if (aa['wrapText'] === '1' || aa['wrapText'] === 'true') out.wr = true
  }
  return out
}

const HEX_RE = /^#[0-9A-Fa-f]{6}$/

/** What came from the editor, reduced to the supported properties; null when it is nothing usable. */
export function sanitizeCellStyle(raw: unknown): CellStyle | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const out: CellStyle = {}
  for (const k of ['b', 'i', 'u', 's', 'wr'] as const) if (r[k] === true || r[k] === 1) out[k] = true
  if (typeof r['fs'] === 'number' && Number.isFinite(r['fs']) && r['fs'] >= 1 && r['fs'] <= 409) out.fs = Math.round(r['fs'] * 2) / 2
  if (typeof r['ff'] === 'string' && r['ff'].length > 0 && r['ff'].length <= 64 && !/[\u0000-\u001f<>]/.test(r['ff'])) out.ff = r['ff']
  for (const k of ['fc', 'bg'] as const) {
    const v = r[k]
    if (typeof v === 'string' && HEX_RE.test(v)) out[k] = v.toUpperCase().replace(/^#/, '#')
  }
  if (typeof r['ha'] === 'string' && 'lcrj'.includes(r['ha']) && r['ha'].length === 1) out.ha = r['ha'] as CellStyle['ha']
  if (typeof r['va'] === 'string' && 'tmb'.includes(r['va']) && r['va'].length === 1) out.va = r['va'] as CellStyle['va']
  const bd = sanitizeBorder(r['bd'])
  if (bd) out.bd = bd
  if (typeof r['nf'] === 'string' && r['nf'].length > 0 && r['nf'].length <= 255 && !/[\u0000-\u001f]/.test(r['nf']) && nfKey(r['nf'])) out.nf = r['nf']
  return out
}

/** A border as the editor sends it, reduced to known sides, line styles and colours. */
export function sanitizeBorder(raw: unknown): CellBorder | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out: CellBorder = {}
  for (const k of SIDES) {
    const e = (raw as Record<string, unknown>)[k]
    if (!e || typeof e !== 'object') continue
    const s = (e as Record<string, unknown>)['s']
    if (typeof s !== 'string' || !(BORDER_STYLES as readonly string[]).includes(s)) continue
    const edge: BorderEdge = { s: s as BorderStyleName }
    const c = (e as Record<string, unknown>)['c']
    if (typeof c === 'string' && HEX_RE.test(c) && c.toUpperCase() !== '#000000') edge.c = c.toUpperCase()
    out[k] = edge
  }
  return Object.keys(out).length ? out : undefined
}

/** One spelling of a border for comparing two of them; '' = no border. */
function borderKey(b: CellBorder | undefined): string {
  if (!b) return ''
  return SIDES.filter((k) => b[k]).map((k) => `${k}:${b[k]!.s}:${b[k]!.c || ''}`).join('|')
}

const same = (a: unknown, b: unknown): boolean => (a ?? null) === (b ?? null)

const FONT_ORDER = ['b', 'i', 'strike', 'condense', 'extend', 'outline', 'shadow', 'u', 'vertAlign', 'sz', 'color', 'name', 'family', 'charset', 'scheme']

/** A font element: the original's children, the changed ones replaced, in schema order. */
function buildFont(base: string | undefined, want: CellStyle, was: CellStyle): string {
  const kids = new Map<string, string>()
  const baseXml = base || '<font><sz val="11"/><name val="Calibri"/></font>'
  const inner = baseXml.replace(/^<(?:\w+:)?font\b[^>]*?\/>$/, '').replace(/^<(?:\w+:)?font\b[^>]*>/, '').replace(/<\/(?:\w+:)?font>$/, '')
  for (const m of inner.matchAll(/<(?:\w+:)?(\w+)\b[^>]*?(?:\/>|>[\s\S]*?<\/(?:\w+:)?\1>)/g)) kids.set(m[1]!, m[0])
  const flag = (tag: string, on: boolean | undefined, changed: boolean): void => {
    if (!changed) return
    if (on) kids.set(tag, `<${tag}/>`)
    else kids.delete(tag)
  }
  flag('b', want.b, !same(!!want.b, !!was.b))
  flag('i', want.i, !same(!!want.i, !!was.i))
  flag('strike', want.s, !same(!!want.s, !!was.s))
  if (!same(!!want.u, !!was.u)) {
    if (want.u) kids.set('u', '<u/>')
    else kids.delete('u')
  }
  if (want.fs != null && !same(want.fs, was.fs)) kids.set('sz', `<sz val="${want.fs}"/>`)
  if (want.fc !== undefined && !same(want.fc, was.fc)) kids.set('color', `<color rgb="FF${want.fc.slice(1)}"/>`)
  else if (want.fc === undefined && was.fc !== undefined) kids.delete('color')
  if (want.ff && !same(want.ff, was.ff)) {
    kids.set('name', `<name val="${escapeXml(want.ff)}"/>`)
    kids.delete('scheme') // the theme font would override the name
  }
  const ordered: string[] = []
  for (const k of FONT_ORDER) if (kids.has(k)) { ordered.push(kids.get(k)!); kids.delete(k) }
  for (const v of kids.values()) ordered.push(v)
  return `<font>${ordered.join('')}</font>`
}

/**
 * Appends cell formats to a stylesheet. Existing entries are never changed: every result
 * is a new xf at the end of cellXfs, so a cell that was not touched cannot move.
 */
export class StyleWriter {
  private fonts: string[] = []
  private fills: string[] = []
  private borders: string[] = []
  private xfs: string[] = []
  private memo = new Map<string, number>()
  private fontMemo = new Map<string, number>()
  private fillMemo = new Map<string, number>()
  private borderMemo = new Map<string, number>()

  private xfMemo = new Map<string, number>()
  private numFmts: { id: number; code: string }[] = []
  private numFmtMemo = new Map<string, number>()
  private nextNumFmt: number

  constructor(private sb: StyleBook) {
    this.nextNumFmt = Math.max(163, ...sb.numFmts.keys()) + 1
    for (const id of BUILTIN_WRITABLE) this.numFmtMemo.set(BUILTIN_NUMFMT[id]!, id)
    // What the file already has wins over a built-in spelling of the same code.
    sb.numFmts.forEach((code, id) => { this.numFmtMemo.set(code, id) })
    // What the file already has is reused, never added a second time.
    sb.fonts.forEach((x, i) => { if (!this.fontMemo.has(x)) this.fontMemo.set(x, i) })
    sb.fills.forEach((x, i) => { if (!this.fillMemo.has(x)) this.fillMemo.set(x, i) })
    sb.borders.forEach((x, i) => { if (!this.borderMemo.has(x)) this.borderMemo.set(x, i) })
    sb.xfs.forEach((x, i) => { if (!this.xfMemo.has(x)) this.xfMemo.set(x, i) })
  }

  get dirty(): boolean { return this.xfs.length > 0 }

  /** The number-format id for a code: General is 0, a code the file or the built-ins have is reused, any other is appended. */
  private numFmtId(code: string | undefined): number {
    if (!nfKey(code)) return 0
    const hit = this.numFmtMemo.get(code!)
    if (hit !== undefined) return hit
    const id = this.nextNumFmt++
    this.numFmts.push({ id, code: code! })
    this.numFmtMemo.set(code!, id)
    return id
  }

  /** Does the cell format `index` (of the file, or one appended here) show a date or a time? */
  isDateXf(index: number | null): boolean {
    if (index == null) return false
    const xf = index < this.sb.xfs.length ? this.sb.xfs[index] : this.xfs[index - this.sb.xfs.length]
    if (!xf) return false
    const id = Number(attrsOf(/^<[^>]*>/.exec(xf)![0])['numFmtId'] || 0)
    if (!id) return false
    const own = this.sb.numFmts.get(id) ?? this.numFmts.find((n) => n.id === id)?.code
    if (own !== undefined) return isDateFormatCode(own)
    return BUILTIN_DATE_FMTS.has(id)
  }

  /** A new <border> built from the original's, the four sides replaced; the diagonal and the rest stay. */
  private borderXml(baseId: number, want: CellBorder | undefined): string {
    const P = this.sb.prefix
    const base = this.sb.borders[baseId] || ''
    const open = /^<(?:\w+:)?border\b([^>]*?)\/?>/.exec(base)
    const attrsXml = open ? open[1]!.replace(/\/\s*$/, '') : ''
    const kept: string[] = []
    const inner = base.replace(/^<(?:\w+:)?border\b[^>]*?\/>$/, '').replace(/^<(?:\w+:)?border\b[^>]*>/, '').replace(/<\/(?:\w+:)?border>$/, '')
    for (const m of inner.matchAll(/<(?:\w+:)?(\w+)\b[^>]*?(?:\/>|>[\s\S]*?<\/(?:\w+:)?\1>)/g)) {
      if (!['left', 'right', 'top', 'bottom', 'start', 'end', 'diagonal'].includes(m[1]!)) kept.push(m[0])
    }
    const diag = /<(?:\w+:)?diagonal\b[^>]*?(?:\/>|>[\s\S]*?<\/(?:\w+:)?diagonal>)/.exec(inner)?.[0] || `<${P}diagonal/>`
    const side = (k: (typeof SIDES)[number]): string => {
      const e = want?.[k]
      const tag = P + SIDE_XML[k]
      if (!e) return `<${tag}/>`
      return `<${tag} style="${e.s}"><${P}color ${e.c ? `rgb="FF${e.c.slice(1)}"` : 'auto="1"'}/></${tag}>`
    }
    // Schema order: left, right, top, bottom, diagonal, then the rest.
    return `<${P}border${attrsXml}>${side('l')}${side('r')}${side('t')}${side('b')}${diag}${kept.join('')}</${P}border>`
  }

  private addBorder(xml: string): number {
    const hit = this.borderMemo.get(xml)
    if (hit !== undefined) return hit
    const idx = this.sb.borders.length + this.borders.length
    this.borders.push(xml)
    this.borderMemo.set(xml, idx)
    return idx
  }

  /** The `s` for a cell that had xf `baseIndex` (null = none) and now has style `want`; null = unchanged. */
  apply(baseIndex: number | null, want: CellStyle): number | null {
    // A cell without an `s` looks like xf 0.
    const eff = baseIndex ?? 0
    const was = xfStyle(this.sb, eff)
    const keys: (keyof CellStyle)[] = ['b', 'i', 'u', 's', 'fs', 'ff', 'fc', 'bg', 'ha', 'va', 'wr', 'bd', 'nf']
    const norm = (v: unknown): unknown => (v === false || v === undefined ? null : v)
    // The editor does not say a size or a font when the cell has none of its own: absent = keep.
    const differs = keys.filter((k) => {
      if ((k === 'fs' || k === 'ff') && want[k] === undefined) return false
      if (k === 'bd') return borderKey(want.bd) !== borderKey(was.bd)
      if (k === 'nf') return nfKey(want.nf) !== nfKey(was.nf)
      return norm(want[k]) !== norm(was[k])
    })
    if (!differs.length) return null
    const key = `${baseIndex ?? 'x'}|${JSON.stringify(want)}`
    const hit = this.memo.get(key)
    if (hit !== undefined) return hit

    const baseXf = this.sb.xfs[eff]
    const baseAttrs = baseXf ? attrsOf(/^<[^>]*>/.exec(baseXf)![0]) : {}
    const fontKeys: (keyof CellStyle)[] = ['b', 'i', 'u', 's', 'fs', 'ff', 'fc']
    let fontId = Number(baseAttrs['fontId'] || 0)
    if (differs.some((k) => fontKeys.includes(k))) {
      const xml = buildFont(this.sb.fonts[fontId], want, was)
      fontId = this.addFont(xml)
    }
    let fillId = Number(baseAttrs['fillId'] || 0)
    if (differs.includes('bg')) {
      fillId = want.bg
        ? this.addFill(`<fill><patternFill patternType="solid"><fgColor rgb="FF${want.bg.slice(1)}"/><bgColor indexed="64"/></patternFill></fill>`)
        : 0
    }
    let borderId = Number(baseAttrs['borderId'] || 0)
    if (differs.includes('bd')) borderId = this.addBorder(this.borderXml(borderId, sanitizeBorder(want.bd)))
    const numFmtId = differs.includes('nf') ? this.numFmtId(want.nf) : Number(baseAttrs['numFmtId'] || 0)
    const P = this.sb.prefix
    // The alignment: the original's, with the three properties replaced.
    const oldAl = baseXf ? attrsOf(/<(?:\w+:)?alignment\b([^>]*)\/?>/.exec(baseXf)?.[1] || '') : {}
    const al: Record<string, string> = { ...oldAl }
    if (differs.includes('ha')) { if (want.ha) al['horizontal'] = HA_TO_XML[want.ha]!; else delete al['horizontal'] }
    if (differs.includes('va')) { if (want.va) al['vertical'] = VA_TO_XML[want.va]!; else delete al['vertical'] }
    if (differs.includes('wr')) { if (want.wr) al['wrapText'] = '1'; else delete al['wrapText'] }
    const alXml = Object.keys(al).length ? `<${P}alignment ${Object.entries(al).map(([k, v]) => `${k}="${escapeXml(v)}"`).join(' ')}/>` : ''
    const other = baseXf ? baseXf.replace(/^<[^>]*>/, '').replace(/<\/(?:\w+:)?xf>$/, '').replace(/<(?:\w+:)?alignment\b[^>]*\/>/, '').replace(/<(?:\w+:)?alignment\b[^>]*>[\s\S]*?<\/(?:\w+:)?alignment>/, '') : ''
    const at: Record<string, string> = { numFmtId: '0', fontId: '0', fillId: '0', borderId: '0', ...baseAttrs }
    at['fontId'] = String(fontId)
    at['fillId'] = String(fillId)
    at['borderId'] = String(borderId)
    at['numFmtId'] = String(numFmtId)
    if (differs.includes('nf')) at['applyNumberFormat'] = '1'
    if (differs.includes('bd')) at['applyBorder'] = '1'
    at['applyFont'] = '1'
    if (differs.includes('bg')) at['applyFill'] = '1'
    if (alXml) at['applyAlignment'] = '1'
    const xf = `<${P}xf ${Object.entries(at).map(([k, v]) => `${k}="${escapeXml(v)}"`).join(' ')}>${alXml}${other}</${P}xf>`
    const same = this.xfMemo.get(xf)
    if (same !== undefined) { this.memo.set(key, same); return same }
    const idx = this.sb.xfs.length + this.xfs.length
    this.xfs.push(xf)
    this.xfMemo.set(xf, idx)
    this.memo.set(key, idx)
    return idx
  }

  private addFont(xml: string): number {
    const hit = this.fontMemo.get(xml)
    if (hit !== undefined) return hit
    const idx = this.sb.fonts.length + this.fonts.length
    this.fonts.push(xml)
    this.fontMemo.set(xml, idx)
    return idx
  }

  private addFill(xml: string): number {
    const hit = this.fillMemo.get(xml)
    if (hit !== undefined) return hit
    const idx = this.sb.fills.length + this.fills.length
    this.fills.push(xml)
    this.fillMemo.set(xml, idx)
    return idx
  }

  /** The stylesheet with the new fonts, fills and formats appended. */
  xml(): string {
    let x = this.sb.xml
    const grow = (tag: string, add: string[], total: number): void => {
      if (!add.length) return
      const sec = section(x, tag)
      if (!sec) return
      let open = sec.open
      open = /\bcount="\d+"/.test(open) ? open.replace(/\bcount="\d+"/, `count="${total}"`) : open.replace(/>$/, ` count="${total}">`)
      x = x.slice(0, sec.start) + open + sec.body + add.join('') + sec.close + x.slice(sec.end)
    }
    if (this.numFmts.length) {
      const add = this.numFmts.map((n) => `<${this.sb.prefix}numFmt numFmtId="${n.id}" formatCode="${escapeXml(n.code)}"/>`).join('')
      const sec = section(x, 'numFmts')
      if (sec) {
        const total = this.sb.numFmts.size + this.numFmts.length
        const open = /\bcount="\d+"/.test(sec.open) ? sec.open.replace(/\bcount="\d+"/, `count="${total}"`) : sec.open.replace(/>$/, ` count="${total}">`)
        x = x.slice(0, sec.start) + open + sec.body + add + sec.close + x.slice(sec.end)
      } else {
        const part = `<${this.sb.prefix}numFmts count="${this.numFmts.length}">${add}</${this.sb.prefix}numFmts>`
        x = x.replace(/<((?:\w+:)?)fonts\b/, (m) => part + m)
      }
    }
    grow('fonts', this.fonts, this.sb.fonts.length + this.fonts.length)
    grow('fills', this.fills, this.sb.fills.length + this.fills.length)
    if (this.borders.length && this.sb.bordersMissing) {
      // The file had no <borders> part at all: it is made, default border first, ahead of the cell formats.
      const P = this.sb.prefix
      const all = [this.sb.borders[0]!, ...this.borders].join('')
      const part = `<${P}borders count="${this.borders.length + 1}">${all}</${P}borders>`
      x = x.replace(/<((?:\w+:)?)(cellStyleXfs|cellXfs)\b/, (m) => part + m)
    } else grow('borders', this.borders, this.sb.borders.length + this.borders.length)
    grow('cellXfs', this.xfs, this.sb.xfs.length + this.xfs.length)
    return x
  }
}
