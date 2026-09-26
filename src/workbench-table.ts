/**
 * MUNKAPAD: TABLAZAT-SZERKESZTES (kanban #406, 15. pont).
 *
 * "Peldaul koltsegvetes vagy lista Excel-fajlban, nem csak megnezni." A
 * Munkapad egy .xlsx / .xlsm / .csv / .tsv fajlt racskent mutat meg, a cellak
 * helyben irhatok, es a mentes -- mint minden mas szerkesztes itt -- UJ fajlt
 * ir a projekt mappajaba es UJ verziot nyit ra. Az eredeti fajl erintetlen.
 *
 * MIERT SAJAT OLVASO/IRO: friss telepitesen nincs LibreOffice, es egy kulso
 * csomag behuzasa fuggoseget tenne a friss telepites es egy mukodo funkcio
 * koze. Az .xlsx egy zip, benne XML: ami egy koltsegvetes szerkesztesehez
 * kell, az itt ~400 sor.
 *
 * HOGYAN NEM VESZ EL A FORMAZAS: az .xlsx-et nem ujrairjuk, hanem FOLTOZZUK.
 * Minden mas resz (stilusok, oszlopszelessegek, osszevont cellak, diagramok,
 * makrok) bajtra ugyanaz marad; a munkalapokon belul is csak a MEGVALTOZOTT
 * cella XML-je uj -- a valtozatlan cella az eredeti XML-jevel kerul vissza
 * (keplet, tipus, stilus egyutt). A megvaltozott cella a stilusat megtartja.
 *
 * Amit SZANDEKOSAN nem csinal: sort/oszlopot kozepre beszurni vagy kozeprol
 * torolni egy .xlsx-ben. Ahhoz minden hivatkozo kepletet at kellene irni, es
 * egy felig atirt keplet csendben rossz szamot adna -- ez rosszabb, mint ha
 * nem lehetne. Uj sor/oszlop a vegere, torles a vegerol megy; a .csv-ben
 * (ott nincs keplet) barhova.
 */
import { inflateRawSync } from 'node:zlib'
import { extname } from 'node:path'
import { readFileSync } from 'node:fs'
import { buildZip } from './web/zip-writer.js'
import { buildPreview } from './workbench-preview.js'
import { resolveLifePath } from './life-explorer.js'
import { getWorkItem } from './workbench.js'

export type TableFormat = 'xlsx' | 'csv'

export interface TableSheet {
  name: string
  /** A cellak szovegkent, ahogy a felhasznalo latja: keplet "=..." alakban,
   *  datum-formatumu szam "EEEE-HH-NN" alakban. Teglalap alaku. */
  rows: string[][]
}

export interface TableData {
  format: TableFormat
  sheets: TableSheet[]
  /** Csak .csv: az elvalaszto, amit a fajlban talaltunk (es mentesnel tartunk). */
  delimiter?: string
  /** Van-e keplet a fajlban (a felulet ezt kimondja: a mentes utan az Excel
   *  ujraszamol). */
  has_formulas: boolean
}

/** Ekkora fajlt meg megnyitunk szerkesztesre. Egy koltsegvetes ennek toredeke. */
export const TABLE_MAX_BYTES = 20 * 1024 * 1024
/** A bongeszoben minden cella egy beviteli mezo: ennel tobb mar nem kezelheto
 *  kenyelmesen egy telefonon sem. Nagyobb tablazat: letoltes, Excel. */
export const TABLE_MAX_CELLS = 40_000
export const TABLE_MAX_ROWS = 5_000
export const TABLE_MAX_COLS = 200
export const TABLE_CELL_MAX = 32_767 // az Excel sajat cella-hatara

const TABLE_EXTS = new Set(['xlsx', 'xlsm', 'csv', 'tsv'])

export function tableExt(name: string): string {
  return extname(String(name || '')).slice(1).toLowerCase()
}

export function isTableFile(name: string): boolean {
  return TABLE_EXTS.has(tableExt(name))
}

export function tableFormatOf(name: string): TableFormat | null {
  const e = tableExt(name)
  if (e === 'xlsx' || e === 'xlsm') return 'xlsx'
  if (e === 'csv' || e === 'tsv') return 'csv'
  return null
}

export type TableResult<T> = ({ ok: true } & T) | { ok: false; code: string; detail?: string | null }

// ---- zip olvasas -------------------------------------------------------------

interface ZipItem { name: string; data: Buffer }

/** A zip MINDEN bejegyzese, a central directory sorrendjeben. Hibas zipnel null. */
export function readZip(buf: Buffer): ZipItem[] | null {
  const EOCD = 0x06054b50
  const CDH = 0x02014b50
  const LFH = 0x04034b50
  if (buf.length < 22) return null
  let eocd = -1
  const from = Math.max(0, buf.length - 22 - 0xffff)
  for (let i = buf.length - 22; i >= from; i--) {
    if (buf.readUInt32LE(i) === EOCD) { eocd = i; break }
  }
  if (eocd < 0) return null
  const count = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)
  const out: ZipItem[] = []
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CDH) return null
    const flags = buf.readUInt16LE(p + 8)
    const method = buf.readUInt16LE(p + 10)
    const compSize = buf.readUInt32LE(p + 20)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOff = buf.readUInt32LE(p + 42)
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen)
    p += 46 + nameLen + extraLen + commentLen
    if (flags & 1) return null // titkositott
    if (localOff + 30 > buf.length || buf.readUInt32LE(localOff) !== LFH) return null
    const start = localOff + 30 + buf.readUInt16LE(localOff + 26) + buf.readUInt16LE(localOff + 28)
    const raw = buf.subarray(start, start + compSize)
    if (raw.length !== compSize) return null
    let data: Buffer
    if (method === 0) data = Buffer.from(raw)
    else if (method === 8) { try { data = inflateRawSync(raw) } catch { return null } }
    else return null
    if (name.endsWith('/')) continue // mappa-bejegyzes: a fajlok utja viszi
    out.push({ name, data })
  }
  return out
}

// ---- XML segedek -------------------------------------------------------------

export function xmlUnescape(s: string): string {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&')
    // Az OOXML a vezerlokaraktereket _xHHHH_ alakban irja.
    .replace(/_x([0-9A-Fa-f]{4})_/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)))
}

export function xmlEscape(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    // Az XML 1.0-ban nem allhato vezerlokaraktereket kihagyjuk (a tab/CR/LF marad).
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
}

function attrs(s: string): Record<string, string> {
  const out: Record<string, string> = {}
  const re = /([\w:.-]+)\s*=\s*"([^"]*)"|([\w:.-]+)\s*=\s*'([^']*)'/g
  let m: RegExpExecArray | null
  while ((m = re.exec(s))) out[m[1] ?? m[3]!] = xmlUnescape(m[2] ?? m[4] ?? '')
  return out
}

/** Az osszes <t> szovege egy elemen belul (a fonetikus <rPh> resz nelkul). */
function textOf(xml: string): string {
  const clean = xml.replace(/<(\w+:)?rPh\b[\s\S]*?<\/(\w+:)?rPh>/g, '')
  let out = ''
  const re = /<(?:\w+:)?t\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:\w+:)?t>)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(clean))) out += xmlUnescape(m[1] || '')
  return out
}

// ---- cellacimek ---------------------------------------------------------------

export function colName(i: number): string {
  let n = i + 1
  let s = ''
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26) }
  return s
}

function colIndex(letters: string): number {
  let n = 0
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

function parseRef(ref: string): { r: number; c: number } | null {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/.exec(ref || '')
  if (!m) return null
  return { c: colIndex(m[1]!), r: Number(m[2]) - 1 }
}

/** Megosztott keplet (t="shared") kovetojenek sajat keplete: a relativ
 *  hivatkozasokat eltoljuk. Idezett szovegben es lapnevben nem nyulunk semmihez. */
export function shiftFormula(formula: string, dr: number, dc: number): string {
  if (!dr && !dc) return formula
  const parts = formula.split(/("(?:[^"]|"")*"|'(?:[^']|'')*')/)
  return parts.map((part, i) => {
    if (i % 2 === 1) return part // idezett resz
    return part.replace(/(^|[^A-Za-z0-9_.])(\$?)([A-Za-z]{1,3})(\$?)(\d{1,7})(?![A-Za-z0-9_(])/g,
      (all, pre: string, cAbs: string, col: string, rAbs: string, row: string) => {
        const c = colIndex(col)
        if (c > 16383) return all
        const nc = cAbs ? c : c + dc
        const nr = rAbs ? Number(row) : Number(row) + dr
        if (nc < 0 || nr < 1) return all
        return `${pre}${cAbs}${colName(nc)}${rAbs}${nr}`
      })
  }).join('')
}

// ---- datumok -------------------------------------------------------------------

const BUILTIN_DATE_FMTS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 30, 36, 45, 46, 47, 50, 57])

function isDateFormatCode(code: string): boolean {
  // Idezett szoveg, [szin]/[$-locale] es escape-elt karakterek nelkul nezzuk.
  const c = code.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '').replace(/\\./g, '')
  return /[dmyhs]/i.test(c) && !/^[#0.,%\s-]*$/.test(c)
}

/** Az Excel napszama (1900-as rendszer) -> "EEEE-HH-NN" / "EEEE-HH-NN OO:PP". */
export function serialToIso(serial: number): string {
  const ms = Math.round((serial - 25569) * 86400 * 1000)
  const d = new Date(ms)
  if (!Number.isFinite(d.getTime())) return String(serial)
  const iso = d.toISOString()
  const frac = serial - Math.floor(serial)
  if (Math.abs(frac) < 1e-9) return iso.slice(0, 10)
  return iso.slice(0, 10) + ' ' + iso.slice(11, 16)
}

export function isoToSerial(s: string): number | null {
  const m = /^(\d{4})[-.](\d{1,2})[-.](\d{1,2})\.?(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s.trim())
  if (!m) return null
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] || 0), Number(m[5] || 0), Number(m[6] || 0))
  const back = new Date(t)
  if (back.getUTCMonth() !== Number(m[2]) - 1 || back.getUTCDate() !== Number(m[3])) return null
  const serial = t / 86400000 + 25569
  return Math.round(serial * 1e6) / 1e6
}

// ---- xlsx: szerkezet ---------------------------------------------------------------

interface XCell {
  /** Az eredeti cella teljes XML-je (valtozatlan cellanal ez megy vissza). */
  xml: string
  s: string | null
  display: string
  isDateStyle: boolean
  formula: boolean
}

interface XRow { attrs: string; cells: Map<number, XCell> }

interface XSheet {
  name: string
  path: string
  prefix: string
  rows: Map<number, XRow>
  nRows: number
  nCols: number
}

interface XBook {
  entries: ZipItem[]
  sheets: XSheet[]
  hasFormulas: boolean
}

function entry(entries: ZipItem[], name: string): ZipItem | undefined {
  return entries.find((e) => e.name === name)
}

function resolveTarget(target: string): string {
  if (target.startsWith('/')) return target.slice(1)
  const parts = ('xl/' + target).split('/')
  const out: string[] = []
  for (const p of parts) { if (p === '..') out.pop(); else if (p && p !== '.') out.push(p) }
  return out.join('/')
}

const SHEET_DATA_RE = /<((?:\w+:)?)sheetData\b[^>]*?(?:\/>|>[\s\S]*?<\/\1sheetData>)/

function parseXlsx(buf: Buffer): TableResult<{ book: XBook }> {
  const entries = readZip(buf)
  if (!entries) return { ok: false, code: 'table_bad_file' }
  const wb = entry(entries, 'xl/workbook.xml')
  const rels = entry(entries, 'xl/_rels/workbook.xml.rels')
  if (!wb || !rels) return { ok: false, code: 'table_bad_file' }
  const wbXml = wb.data.toString('utf8')
  const relMap = new Map<string, string>()
  for (const m of rels.data.toString('utf8').matchAll(/<(?:\w+:)?Relationship\b([^>]*)\/?>/g)) {
    const a = attrs(m[1]!)
    if (a['Id'] && a['Target']) relMap.set(a['Id'], resolveTarget(a['Target']))
  }

  const shared: string[] = []
  const ss = entry(entries, 'xl/sharedStrings.xml')
  if (ss) for (const m of ss.data.toString('utf8').matchAll(/<(?:\w+:)?si\b[^>]*>([\s\S]*?)<\/(?:\w+:)?si>|<(?:\w+:)?si\s*\/>/g)) shared.push(textOf(m[1] || ''))

  // Melyik stilus datum? cellXfs sorrendje = a cella `s` szama.
  const dateStyles = new Set<number>()
  const st = entry(entries, 'xl/styles.xml')
  if (st) {
    const sx = st.data.toString('utf8')
    const custom = new Map<number, string>()
    for (const m of sx.matchAll(/<(?:\w+:)?numFmt\b([^>]*)\/?>/g)) {
      const a = attrs(m[1]!)
      if (a['numFmtId']) custom.set(Number(a['numFmtId']), a['formatCode'] || '')
    }
    const xfs = /<(\w+:)?cellXfs\b[^>]*>([\s\S]*?)<\/\1cellXfs>/.exec(sx)
    if (xfs) {
      let i = 0
      for (const m of xfs[2]!.matchAll(/<(?:\w+:)?xf\b([^>]*?)(?:\/>|>)/g)) {
        const id = Number(attrs(m[1]!)['numFmtId'] || 0)
        if (BUILTIN_DATE_FMTS.has(id) || (custom.has(id) && isDateFormatCode(custom.get(id)!))) dateStyles.add(i)
        i++
      }
    }
  }
  const date1904 = /date1904\s*=\s*"(1|true)"/.test(wbXml)

  const sheets: XSheet[] = []
  let hasFormulas = false
  for (const m of wbXml.matchAll(/<(?:\w+:)?sheet\b([^>]*)\/?>/g)) {
    const a = attrs(m[1]!)
    const rid = a['r:id'] || Object.entries(a).find(([k]) => k.endsWith(':id'))?.[1] || ''
    const path = relMap.get(rid)
    const file = path ? entry(entries, path) : undefined
    if (!path || !file) continue // diagramlap vagy hianyzo resz: nem tablazat
    const xml = file.data.toString('utf8')
    const sd = SHEET_DATA_RE.exec(xml)
    if (!sd) continue
    const prefix = sd[1] || ''
    const rows = new Map<number, XRow>()
    let nRows = 0
    let nCols = 0
    let rowSeq = 0
    const sharedF = new Map<string, { f: string; r: number; c: number }>()
    const rowRe = /<(?:\w+:)?row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?row>)/g
    for (const rm of sd[0].matchAll(rowRe)) {
      const ra = attrs(rm[1]!)
      const r = ra['r'] ? Number(ra['r']) - 1 : rowSeq
      rowSeq = r + 1
      const row: XRow = { attrs: rm[1]!, cells: new Map() }
      let colSeq = 0
      for (const cm of (rm[2] || '').matchAll(/<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g)) {
        const ca = attrs(cm[1]!)
        const pos = ca['r'] ? parseRef(ca['r']) : { r, c: colSeq }
        if (!pos) continue
        colSeq = pos.c + 1
        const inner = cm[2] || ''
        const fm = /<(?:\w+:)?f\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?f>)/.exec(inner)
        const vm = /<(?:\w+:)?v\b[^>]*>([\s\S]*?)<\/(?:\w+:)?v>/.exec(inner)
        const v = vm ? xmlUnescape(vm[1]!) : ''
        const t = ca['t'] || 'n'
        const s = ca['s'] ?? null
        const isDate = s != null && dateStyles.has(Number(s))
        let display: string
        if (fm) {
          hasFormulas = true
          const fa = attrs(fm[1] || '')
          let f = xmlUnescape(fm[2] || '')
          if (fa['t'] === 'shared' && fa['si'] != null) {
            if (f) sharedF.set(fa['si'], { f, r: pos.r, c: pos.c })
            else {
              const base = sharedF.get(fa['si'])
              if (base) f = shiftFormula(base.f, pos.r - base.r, pos.c - base.c)
            }
          }
          display = f ? '=' + f : v
        } else if (t === 's') display = shared[Number(v)] ?? ''
        else if (t === 'inlineStr') display = textOf(inner)
        else if (t === 'b') display = v === '1' ? 'TRUE' : v === '0' ? 'FALSE' : v
        else if (t === 'n' && isDate && v !== '' && Number.isFinite(Number(v))) display = serialToIso(Number(v) + (date1904 ? 1462 : 0))
        else display = v
        row.cells.set(pos.c, { xml: cm[0], s, display, isDateStyle: isDate, formula: !!fm })
        nCols = Math.max(nCols, pos.c + 1)
        nRows = Math.max(nRows, r + 1)
      }
      rows.set(r, row)
    }
    sheets.push({ name: a['name'] || `Sheet${sheets.length + 1}`, path, prefix, rows, nRows, nCols })
  }
  if (!sheets.length) return { ok: false, code: 'table_no_sheets' }
  return { ok: true, book: { entries, sheets, hasFormulas } }
}

function gridOf(sh: XSheet): string[][] {
  const out: string[][] = []
  for (let r = 0; r < sh.nRows; r++) {
    const row = sh.rows.get(r)
    const line: string[] = []
    for (let c = 0; c < sh.nCols; c++) line.push(row?.cells.get(c)?.display ?? '')
    out.push(line)
  }
  return out
}

function checkSize(sheets: { rows: string[][] }[]): string | null {
  let cells = 0
  for (const s of sheets) {
    if (s.rows.length > TABLE_MAX_ROWS) return 'table_too_big'
    for (const r of s.rows) { if (r.length > TABLE_MAX_COLS) return 'table_too_big'; cells += r.length }
  }
  return cells > TABLE_MAX_CELLS ? 'table_too_big' : null
}

// ---- csv ------------------------------------------------------------------------

export function detectDelimiter(text: string, ext: string): string {
  if (ext === 'tsv') return '\t'
  const firstLines = text.split(/\r?\n/).slice(0, 5).join('\n')
  let best = ','
  let bestN = -1
  for (const d of [',', ';', '\t', '|']) {
    let n = 0
    let q = false
    for (const ch of firstLines) { if (ch === '"') q = !q; else if (!q && ch === d) n++ }
    if (n > bestN) { best = d; bestN = n }
  }
  return bestN > 0 ? best : (ext === 'tsv' ? '\t' : ',')
}

export function parseCsv(text: string, delim: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let q = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++ } else q = false }
      else cell += ch
    } else if (ch === '"' && cell === '') q = true
    else if (ch === delim) { row.push(cell); cell = '' }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(cell); rows.push(row); row = []; cell = ''
    } else cell += ch
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row) }
  return rows
}

export function writeCsv(rows: string[][], delim: string, eol: string): string {
  const needs = (s: string) => s.includes(delim) || s.includes('"') || s.includes('\n') || s.includes('\r') || /^\s|\s$/.test(s)
  return rows.map((r) => r.map((c) => (needs(c) ? '"' + c.replace(/"/g, '""') + '"' : c)).join(delim)).join(eol) + eol
}

function rectangular(rows: string[][]): string[][] {
  const w = rows.reduce((m, r) => Math.max(m, r.length), 0)
  return rows.map((r) => (r.length < w ? r.concat(Array(w - r.length).fill('')) : r))
}

// ---- olvasas ------------------------------------------------------------------------

export function readTable(buf: Buffer, name: string): TableResult<{ table: TableData }> {
  const fmt = tableFormatOf(name)
  if (!fmt) return { ok: false, code: 'table_unsupported' }
  if (buf.length > TABLE_MAX_BYTES) return { ok: false, code: 'table_too_big' }
  if (fmt === 'csv') {
    let text = buf.toString('utf8')
    // Nem UTF-8 (pl. regi Windowsos Excel-export): inkabb kimondjuk, mint hogy
    // elrontott ekezetekkel irjuk vissza.
    if (text.includes('�')) return { ok: false, code: 'table_not_utf8' }
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
    const delimiter = detectDelimiter(text, tableExt(name))
    const rows = rectangular(parseCsv(text, delimiter))
    const table: TableData = { format: 'csv', delimiter, sheets: [{ name: '', rows: rows.length ? rows : [['']] }], has_formulas: false }
    const big = checkSize(table.sheets)
    return big ? { ok: false, code: big } : { ok: true, table }
  }
  const p = parseXlsx(buf)
  if (!p.ok) return p
  const sheets = p.book.sheets.map((s) => ({ name: s.name, rows: gridOf(s) }))
  for (const s of sheets) if (!s.rows.length) s.rows = [['']]
  const big = checkSize(sheets)
  if (big) return { ok: false, code: big }
  return { ok: true, table: { format: 'xlsx', sheets, has_formulas: p.book.hasFormulas } }
}

// ---- iras ----------------------------------------------------------------------------

/** A felulettol jott racs ellenorzese: teglalap, szovegek, hatarokon belul. */
export function normalizeSheets(raw: unknown): TableResult<{ sheets: TableSheet[] }> {
  if (!Array.isArray(raw) || !raw.length) return { ok: false, code: 'table_bad_input' }
  const sheets: TableSheet[] = []
  for (const s of raw) {
    if (!s || typeof s !== 'object' || !Array.isArray((s as { rows?: unknown }).rows)) return { ok: false, code: 'table_bad_input' }
    const rows: string[][] = []
    for (const r of (s as { rows: unknown[] }).rows) {
      if (!Array.isArray(r)) return { ok: false, code: 'table_bad_input' }
      const line = r.map((c) => (c == null ? '' : String(c)))
      if (line.some((c) => c.length > TABLE_CELL_MAX)) return { ok: false, code: 'table_cell_too_long' }
      rows.push(line)
    }
    sheets.push({ name: String((s as { name?: unknown }).name ?? ''), rows: rectangular(rows) })
  }
  const big = checkSize(sheets)
  return big ? { ok: false, code: big } : { ok: true, sheets }
}

const NUM_RE = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/
const HU_NUM_RE = /^[-+]?\d+,\d+$/

function cellXml(ref: string, value: string, prefix: string, s: string | null, isDateStyle: boolean, lang: 'hu' | 'en'): string {
  const sAttr = s != null ? ` s="${xmlEscape(s)}"` : ''
  const P = prefix
  if (value === '') return s != null ? `<${P}c r="${ref}"${sAttr}/>` : ''
  if (value.length > 1 && value.startsWith('=')) {
    return `<${P}c r="${ref}"${sAttr}><${P}f>${xmlEscape(value.slice(1))}</${P}f></${P}c>`
  }
  const trimmed = value.trim()
  if (isDateStyle) {
    const serial = isoToSerial(trimmed)
    if (serial != null) return `<${P}c r="${ref}"${sAttr}><${P}v>${serial}</${P}v></${P}c>`
  }
  if (NUM_RE.test(trimmed) && Number.isFinite(Number(trimmed))) {
    return `<${P}c r="${ref}"${sAttr}><${P}v>${Number(trimmed)}</${P}v></${P}c>`
  }
  if (lang === 'hu' && HU_NUM_RE.test(trimmed)) {
    return `<${P}c r="${ref}"${sAttr}><${P}v>${Number(trimmed.replace(',', '.'))}</${P}v></${P}c>`
  }
  if (value === 'TRUE' || value === 'FALSE') {
    return `<${P}c r="${ref}"${sAttr} t="b"><${P}v>${value === 'TRUE' ? 1 : 0}</${P}v></${P}c>`
  }
  return `<${P}c r="${ref}"${sAttr} t="inlineStr"><${P}is><${P}t xml:space="preserve">${xmlEscape(value)}</${P}t></${P}is></${P}c>`
}

/** Egy kepletes cella a tarolt (regi) eredmenye NELKUL. A LibreOffice
 *  alapbeallitasban NEM szamol ujra betolteskor, hanem a tarolt eredmenyt
 *  mutatja -- egy atirt cella utan az elavult lenne. Eredmeny nelkul minden
 *  olvaso kiszamolja. (A `t` is megy: az a regi eredmeny tipusa volt.) */
function withoutCachedValue(xml: string): string {
  return xml
    .replace(/<((?:\w+:)?)v\b[^>]*>[\s\S]*?<\/\1v>|<(?:\w+:)?v\s*\/>/g, '')
    .replace(/^(<(?:\w+:)?c\b[^>]*?)\st\s*=\s*"[^"]*"/, '$1')
}

function sheetDataXml(sh: XSheet, grid: string[][], lang: 'hu' | 'en', recalc = false): { xml: string; changed: boolean } {
  const P = sh.prefix
  const nRows = grid.length
  const nCols = grid.reduce((m, r) => Math.max(m, r.length), 0)
  // Valtozas = egy cella mas lett, vagy egy meglevo cella kiesett a racsbol
  // (torolt sor/oszlop). Egy ures sor hozzaadasa magaban nem valtozas.
  let changed = false
  for (const [r, row] of sh.rows) for (const c of row.cells.keys()) if (r >= nRows || c >= nCols) changed = true
  const out: string[] = []
  const rowNums = new Set<number>()
  for (let r = 0; r < nRows; r++) rowNums.add(r)
  // Az ures, de formazott (pl. sormagassagos) sorok is maradnak, ha a racson belul vannak.
  for (const r of [...rowNums].sort((a, b) => a - b)) {
    const orig = sh.rows.get(r)
    const cells: string[] = []
    for (let c = 0; c < nCols; c++) {
      const want = grid[r]?.[c] ?? ''
      const o = orig?.cells.get(c)
      if (o && o.display === want) { cells.push(recalc && o.formula ? withoutCachedValue(o.xml) : o.xml); continue }
      if (!o && want === '') continue
      changed = true
      const x = cellXml(colName(c) + (r + 1), want, P, o ? o.s : null, o ? o.isDateStyle : false, lang)
      if (x) cells.push(x)
    }
    if (!cells.length && !orig) continue
    const keep = (orig?.attrs || '').replace(/\s(r|spans)\s*=\s*"[^"]*"/g, '')
    out.push(cells.length
      ? `<${P}row r="${r + 1}"${keep}>${cells.join('')}</${P}row>`
      : `<${P}row r="${r + 1}"${keep}/>`)
  }
  return { xml: `<${P}sheetData>${out.join('')}</${P}sheetData>`, changed }
}

/** A mentett .xlsx: az eredeti, csak a megvaltozott cellakkal foltozva. */
function writeXlsx(original: Buffer, sheets: TableSheet[], lang: 'hu' | 'en'): TableResult<{ data: Buffer }> {
  const p = parseXlsx(original)
  if (!p.ok) return p
  const book = p.book
  // A lapok szama es neve nem valtozhat: a racsot lapnev szerint illesztjuk
  // vissza, egy atrendezett lista mas lapra irna.
  if (sheets.length !== book.sheets.length || sheets.some((s, i) => s.name !== book.sheets[i]!.name)) {
    return { ok: false, code: 'table_sheets_changed' }
  }
  const replaced = new Map<string, Buffer>()
  const changedSheets = book.sheets.map((sh, i) => sheetDataXml(sh, sheets[i]!.rows, lang).changed)
  if (!changedSheets.some(Boolean)) return { ok: false, code: 'table_no_change' }
  for (let i = 0; i < book.sheets.length; i++) {
    const sh = book.sheets[i]!
    const grid = sheets[i]!.rows
    // Egy atirt cella MAS lapok kepleteit is erintheti: minden kepletes lap
    // tarolt eredmenyei mennek, nem csak a szerkesztette.
    const hasFormula = [...sh.rows.values()].some((r) => [...r.cells.values()].some((c) => c.formula))
    if (!changedSheets[i] && !hasFormula) continue
    const { xml } = sheetDataXml(sh, grid, lang, true)
    const file = entry(book.entries, sh.path)!
    let sx = file.data.toString('utf8').replace(SHEET_DATA_RE, () => xml)
    const nRows = grid.length
    const nCols = grid.reduce((m, r) => Math.max(m, r.length), 0)
    const dim = nRows && nCols ? `A1:${colName(Math.max(0, nCols - 1))}${Math.max(1, nRows)}` : 'A1'
    sx = sx.replace(/<((?:\w+:)?)dimension\b[^>]*\/>/, (_m, pre: string) => `<${pre}dimension ref="${dim}"/>`)
    replaced.set(sh.path, Buffer.from(sx, 'utf8'))
  }

  // A calcChain a regi kepletek listaja: valtozas utan az Excel "javitani"
  // akarna. Kivesszuk, es teljes ujraszamolast kerunk megnyitaskor -- ez a
  // szokasos, biztonsagos ut.
  const calc = book.entries.find((e) => e.name === 'xl/calcChain.xml')
  const out: { name: string; data: Buffer }[] = []
  for (const e of book.entries) {
    if (calc && e === calc) continue
    let data = replaced.get(e.name) || e.data
    if (e.name === '[Content_Types].xml' && calc) {
      data = Buffer.from(data.toString('utf8').replace(/<Override\b[^>]*PartName="\/xl\/calcChain\.xml"[^>]*\/>/g, ''), 'utf8')
    } else if (e.name === 'xl/_rels/workbook.xml.rels' && calc) {
      data = Buffer.from(data.toString('utf8').replace(/<Relationship\b[^>]*Target="[^"]*calcChain\.xml"[^>]*\/>/g, ''), 'utf8')
    } else if (e.name === 'xl/workbook.xml') {
      let w = data.toString('utf8')
      const cp = /<((?:\w+:)?)calcPr\b([^>]*?)\/>/.exec(w)
      if (cp) {
        const rest = cp[2]!.replace(/\sfullCalcOnLoad\s*=\s*"[^"]*"/, '')
        w = w.replace(cp[0], `<${cp[1]}calcPr${rest} fullCalcOnLoad="1"/>`)
      } else {
        const pre = /<((?:\w+:)?)workbook\b/.exec(w)?.[1] || ''
        w = w.replace(new RegExp(`</${pre}workbook>`), `<${pre}calcPr fullCalcOnLoad="1"/></${pre}workbook>`)
      }
      data = Buffer.from(w, 'utf8')
    }
    out.push({ name: e.name, data })
  }
  // A [Content_Types].xml-nek elol kell allnia (nehany olvaso ezt varja).
  out.sort((a, b) => (a.name === '[Content_Types].xml' ? -1 : b.name === '[Content_Types].xml' ? 1 : 0))
  return { ok: true, data: buildZip(out) }
}

export function writeTable(original: Buffer, name: string, sheets: TableSheet[], opts: { delimiter?: string; lang?: 'hu' | 'en' } = {}): TableResult<{ data: Buffer }> {
  const fmt = tableFormatOf(name)
  if (!fmt) return { ok: false, code: 'table_unsupported' }
  const lang = opts.lang === 'en' ? 'en' : 'hu'
  if (fmt === 'csv') {
    if (sheets.length !== 1) return { ok: false, code: 'table_bad_input' }
    let text = original.toString('utf8')
    const bom = text.charCodeAt(0) === 0xfeff
    if (bom) text = text.slice(1)
    const delim = opts.delimiter && [',', ';', '\t', '|'].includes(opts.delimiter) ? opts.delimiter : detectDelimiter(text, tableExt(name))
    const eol = /\r\n/.test(text) ? '\r\n' : '\n'
    const before = rectangular(parseCsv(text, delim))
    const rows = sheets[0]!.rows
    if (JSON.stringify(before) === JSON.stringify(rows)) return { ok: false, code: 'table_no_change' }
    return { ok: true, data: Buffer.from((bom ? '﻿' : '') + writeCsv(rows, delim, eol), 'utf8') }
  }
  return writeXlsx(original, sheets, lang)
}

// ---- ures munkafuzet ---------------------------------------------------------------

/** Egy ures, egy lapos .xlsx -- az "Uj tablazat" gomb kiindulasa. Minimalis,
 *  de az Excel, a LibreOffice es a Google Tablazatok is megnyitja. */
export function blankXlsx(sheetName: string, header: string[] = []): Buffer {
  const name = xmlEscape(String(sheetName || 'Sheet1').replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Sheet1')
  const cells = header.map((h, i) => `<c r="${colName(i)}1" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(h)}</t></is></c>`).join('')
  const sheet = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + `<dimension ref="A1${header.length > 1 ? ':' + colName(header.length - 1) + '1' : ''}"/>`
    + '<sheetData>' + (cells ? `<row r="1">${cells}</row>` : '') + '</sheetData></worksheet>'
  const files = [
    { name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
      + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
      + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
      + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
      + '</Types>' },
    { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
      + '</Relationships>' },
    { name: 'xl/workbook.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
      + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
      + `<sheets><sheet name="${name}" sheetId="1" r:id="rId1"/></sheets></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
      + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
      + '</Relationships>' },
    { name: 'xl/styles.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
      + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
      + '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>'
      + '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'
      + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
      + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
      + '<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>'
      + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
      + '</styleSheet>' },
    { name: 'xl/worksheets/sheet1.xml', data: sheet },
  ]
  return buildZip(files.map((f) => ({ name: f.name, data: Buffer.from(f.data, 'utf8') })))
}

// ---- a munkadarab tablazat-forrasa -----------------------------------------------

export interface TableSource {
  rel: string
  name: string
  data: Buffer
  version_id: string | null
  version_no: number | null
  /** A MOSTANI verzio-e: regit csak nezni lehet, menteni a mostanira lehet. */
  current: boolean
}

/**
 * A munkadarab (kert vagy mostani) verziojanak tablazat-fajlja. A "nem latok
 * oda" okait (nincs Raktar, nincs projektmappa, eltunt a fajl) az elonezet
 * SAJAT kodjaival adja vissza -- ugyanaz a mondat, mint az elonezet panelen.
 */
export function loadTableSource(itemId: string, wantedVersion?: unknown): TableResult<{ source: TableSource }> {
  const item = getWorkItem(itemId)
  if (!item) return { ok: false, code: 'not_found' }
  const p = buildPreview(itemId, wantedVersion)
  if (!p.rel || !p.name) {
    return { ok: false, code: p.reason && p.reason !== 'no_source' ? 'preview_' + p.reason : 'table_unsupported' }
  }
  if (!isTableFile(p.name)) return { ok: false, code: 'table_unsupported' }
  if (p.reason === 'too_large') return { ok: false, code: 'table_too_big' }
  if (!p.available && p.reason !== 'needs_conversion') return { ok: false, code: 'preview_' + (p.reason || 'unreadable') }
  const abs = resolveLifePath(p.rel)
  if (!abs) return { ok: false, code: 'preview_unreachable' }
  let data: Buffer
  try { data = readFileSync(abs) } catch (e) {
    return { ok: false, code: 'preview_unreadable', detail: e instanceof Error ? e.message : String(e) }
  }
  if (data.length > TABLE_MAX_BYTES) return { ok: false, code: 'table_too_big' }
  return {
    ok: true,
    source: {
      rel: p.rel, name: p.name, data,
      version_id: p.version_id, version_no: p.version_no,
      current: !p.version_id || p.version_id === item.current_version_id,
    },
  }
}
