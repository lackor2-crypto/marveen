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
  /**
   * Which sheet of the OPENED file this is (its position there), or null for a sheet
   * made in the editor (#526). Absent on every sheet = the old contract: same sheets,
   * same names, same order.
   */
  from?: number | null
  /**
   * #526, part 2: where each row / column of `rows` came from in the opened sheet (its
   * position there), or null for one inserted in the editor. Absent = nothing moved.
   */
  rowsFrom?: (number | null)[]
  colsFrom?: (number | null)[]
  /**
   * Read side only: rows and columns of this sheet cannot be inserted, removed or moved,
   * because it holds things placed by position that the save does not follow (pictures,
   * charts, table objects, comments, protection).
   */
  structure_locked?: boolean
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
  /** The sheet's own `<sheet .../>` element in workbook.xml, and what it says. */
  tag: string
  rid: string
  sheetId: number
  /** Its position among ALL `<sheet>` elements of the workbook (chart sheets included): what `localSheetId` counts. */
  wbIndex: number
  /** Holds position-bound objects the save does not follow (see TableSheet.structure_locked). */
  objects: boolean
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
  let wbIndex = -1
  for (const m of wbXml.matchAll(/<(?:\w+:)?sheet\b([^>]*)\/?>/g)) {
    wbIndex++
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
    const dir = path.slice(0, path.lastIndexOf('/') + 1)
    const ownRels = entry(entries, `${dir}_rels/${path.slice(dir.length)}.rels`)?.data.toString('utf8') || ''
    // Hyperlinks and printer settings do not sit at a cell position the save has to follow.
    const boundRel = [...ownRels.matchAll(/<(?:\w+:)?Relationship\b[^>]*\bType="([^"]*)"/g)].some((r) => !/\/(hyperlink|printerSettings)$/.test(r[1]!))
    const objects = boundRel || /<(?:\w+:)?(drawing|legacyDrawing|legacyDrawingHF|tableParts|picture|oleObjects|controls|sheetProtection)\b/.test(xml)
    sheets.push({ name: a['name'] || `Sheet${sheets.length + 1}`, path, prefix, rows, nRows, nCols, tag: m[0], rid, sheetId: Number(a['sheetId']) || 0, wbIndex, objects })
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
  const sheets: TableSheet[] = p.book.sheets.map((s) => ({ name: s.name, rows: gridOf(s), ...(s.objects ? { structure_locked: true } : {}) }))
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
    const sheet: TableSheet = { name: String((s as { name?: unknown }).name ?? ''), rows: rectangular(rows) }
    if ('from' in (s as object)) {
      const f = (s as { from?: unknown }).from
      if (f === null) sheet.from = null
      else if (typeof f === 'number' && Number.isInteger(f) && f >= 0) sheet.from = f
      else return { ok: false, code: 'table_bad_input' }
    }
    for (const key of ['rowsFrom', 'colsFrom'] as const) {
      const v = (s as Record<string, unknown>)[key]
      if (v === undefined) continue
      if (!Array.isArray(v) || v.length > Math.max(TABLE_MAX_ROWS, TABLE_MAX_COLS)) return { ok: false, code: 'table_bad_input' }
      if (v.some((x) => x !== null && !(typeof x === 'number' && Number.isInteger(x) && x >= 0))) return { ok: false, code: 'table_bad_input' }
      sheet[key] = v as (number | null)[]
    }
    sheets.push(sheet)
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

// ---- sorok es oszlopok beszurasa, torlese, athelyezese (#526, 2. resz) ----------------
//
// The editor tags every row and column of the opened sheet with its position; the tag
// travels with the row through inserts, removals, moves and undo. So the save does not
// replay operations: it is told, for each row and column it gets, where that one came from.

/** One axis of a sheet: where each new index came from, and where each old index went. */
export interface AxisMap {
  /** new index -> original index, or null (inserted). Past the end: nothing moved. */
  from: (number | null)[]
  /** original index -> new index; an original that is not here was removed. */
  to: Map<number, number>
  /** Originals below this were all accounted for (kept or removed). */
  bound: number
  /** What is added to an original index at or past `bound`. */
  delta: number
  identity: boolean
}

export function axisMap(from: (number | null)[] | undefined, origLen: number): AxisMap {
  const src = from || []
  const to = new Map<number, number>()
  let maxO = -1
  let lastNew = -1
  const clean: (number | null)[] = []
  src.forEach((o, i) => {
    // The same origin twice (a copied tag): the first one is the row, the other is new.
    if (o == null || to.has(o)) { clean.push(null); return }
    to.set(o, i)
    clean.push(o)
    if (o > maxO) maxO = o
    lastNew = i
  })
  const bound = Math.max(origLen, maxO + 1)
  // A map that was SENT names every original row it still has (the editor tags rows whether or
  // not they hold anything), so an original that is missing from it was removed -- also at the
  // end, where the merges and rules of that row have to go with it. No map at all (the plain
  // grid) means nothing moved.
  let identity = from === undefined || clean.length >= origLen
  for (let i = 0; i < clean.length && identity; i++) if (clean[i] !== null ? clean[i] !== i : i < origLen) identity = false
  return { from: clean, to, bound, delta: identity ? 0 : lastNew + 1 - bound, identity }
}

const originOf = (m: AxisMap, i: number): number | null => (i < m.from.length ? m.from[i]! : m.identity ? i : i - m.delta >= m.bound ? i - m.delta : null)

/** Where the original span [a, b] is now, or null when all of it was removed. Inserts inside it widen it. */
export function mapSpan(m: AxisMap, a: number, b: number): [number, number] | null {
  if (m.identity) return [a, b]
  let lo = Infinity
  let hi = -Infinity
  for (let o = a; o <= Math.min(b, m.bound - 1); o++) {
    const n = m.to.get(o)
    if (n === undefined) continue
    if (n < lo) lo = n
    if (n > hi) hi = n
  }
  if (b >= m.bound) {
    const s2 = Math.max(a, m.bound) + m.delta
    const e2 = b + m.delta
    if (e2 >= 0) { if (s2 < lo) lo = Math.max(0, s2); if (e2 > hi) hi = e2 }
  }
  return lo === Infinity ? null : [lo, hi]
}

export interface SheetMaps { rows: AxisMap; cols: AxisMap }

const MAX_ROW = 1048575
const MAX_COL = 16383

/** One A1 reference or range ("B2", "$A$1:C9", "A:C", "2:5") moved by the maps; null = all of it is gone. */
export function mapRef(ref: string, maps: SheetMaps): string | null {
  const m = /^(\$?)([A-Za-z]{1,3})?(\$?)(\d{1,7})?(?::(\$?)([A-Za-z]{1,3})?(\$?)(\d{1,7})?)?$/.exec(ref)
  if (!m) return ref
  const [, ca1, c1, ra1, r1, ca2, c2, ra2, r2] = m
  const single = c2 === undefined && r2 === undefined
  const cA = c1 ? colIndex(c1) : 0
  const cB = single ? cA : c2 ? colIndex(c2) : c1 ? cA : MAX_COL
  const rA = r1 ? Number(r1) - 1 : 0
  const rB = single ? rA : r2 ? Number(r2) - 1 : r1 ? rA : MAX_ROW
  const cs = c1 || c2 ? mapSpan(maps.cols, Math.min(cA, c1 ? cB : cA), c1 ? Math.max(cA, cB) : MAX_COL) : [0, MAX_COL] as [number, number]
  const rs = r1 || r2 ? mapSpan(maps.rows, Math.min(rA, r1 ? rB : rA), r1 ? Math.max(rA, rB) : MAX_ROW) : [0, MAX_ROW] as [number, number]
  if (!cs || !rs) return null
  const col = (i: number, abs: string | undefined) => (c1 || c2 ? `${abs || ''}${colName(Math.min(i, MAX_COL))}` : '')
  const row = (i: number, abs: string | undefined) => (r1 || r2 ? `${abs || ''}${Math.min(i, MAX_ROW) + 1}` : '')
  const first = col(cs[0], ca1) + row(rs[0], ra1)
  if (single) return first
  return `${first}:${col(cs[1], ca2 ?? ca1)}${row(rs[1], ra2 ?? ra1)}`
}

/**
 * Every reference in a formula TEXT moved by the maps of the sheet it points at. A reference
 * without a sheet belongs to `own`; a removed cell becomes #REF!, as in Excel.
 */
export function mapFormulaRefs(formula: string, own: string | null, mapsOf: (sheet: string) => SheetMaps | null): string {
  return formula.split(/("(?:[^"]|"")*")/).map((part, i) => {
    if (i % 2) return part
    return part.replace(
      /(^|[^\p{L}\p{N}_.$'!])((?:'(?:[^']|'')+'|[\p{L}_][\p{L}\p{N}_.]*)!)?(\$?[A-Za-z]{1,3}\$?\d{1,7}(?::\$?[A-Za-z]{1,3}\$?\d{1,7})?|\$?[A-Za-z]{1,3}:\$?[A-Za-z]{1,3}|\$?\d{1,7}:\$?\d{1,7})(?![\p{L}\p{N}_(!])/gu,
      (all, pre: string, sheet: string | undefined, ref: string) => {
        const name = sheet ? (sheet.startsWith("'") ? sheet.slice(1, -2).replace(/''/g, "'") : sheet.slice(0, -1)) : own
        const maps = name == null ? null : mapsOf(name)
        if (!maps || (maps.rows.identity && maps.cols.identity)) return all
        const moved = mapRef(ref, maps)
        return `${pre}${sheet || ''}${moved ?? '#REF!'}`
      })
  }).join('')
}

/** The parts of a sheet that sit at a cell position, moved with the rows and columns. */
function shiftSheetParts(sx: string, maps: SheetMaps, own: string): string {
  const refAttr = (xml: string, tag: string, attr: string): string =>
    xml.replace(new RegExp(`<((?:\\w+:)?)${tag}\\b([^>]*?)\\b${attr}="([^"]*)"([^>]*?)(/>|>[\\s\\S]*?</\\1${tag}>)`, 'g'),
      (_m, p: string, a: string, val: string, b: string, rest: string) => {
        const moved = val.split(/\s+/).filter(Boolean).map((r) => mapRef(r, maps)).filter((r): r is string => r !== null)
        return moved.length ? `<${p}${tag}${a}${attr}="${moved.join(' ')}"${b}${rest}` : ''
      })
  let out = sx
  out = refAttr(out, 'mergeCell', 'ref')
  out = refAttr(out, 'conditionalFormatting', 'sqref')
  out = refAttr(out, 'dataValidation', 'sqref')
  out = refAttr(out, 'hyperlink', 'ref')
  out = refAttr(out, 'autoFilter', 'ref')
  // Rules and validations carry formulas of their own.
  out = out.replace(/(<((?:\w+:)?)(formula[12]?)\b[^>]*>)([\s\S]*?)(<\/\2\3>)/g, (_m, open: string, _p: string, _t: string, body: string, close: string) =>
    open + xmlEscape(mapFormulaRefs(xmlUnescape(body), own, (n) => (n === own ? maps : null))) + close)
  // An emptied container would be invalid: it goes with its last child.
  out = out.replace(/<((?:\w+:)?)(mergeCells|hyperlinks|dataValidations)\b[^>]*>\s*<\/\1\2>/g, '')
  out = out.replace(/(<(?:\w+:)?(mergeCells|dataValidations)\b[^>]*?)\scount="\d+"/g, '$1')
  // Column widths and styles: each <col> covers a span of columns.
  if (!maps.cols.identity) {
    out = out.replace(/<((?:\w+:)?)col\b([^>]*?)\/>/g, (all, p: string, at: string) => {
      const a = attrs(at)
      if (!a['min'] || !a['max']) return all
      const span = mapSpan(maps.cols, Number(a['min']) - 1, Math.min(Number(a['max']) - 1, MAX_COL))
      if (!span) return ''
      const rest = at.replace(/\s(min|max)\s*=\s*"[^"]*"/g, '')
      return `<${p}col min="${span[0] + 1}" max="${span[1] + 1}"${rest}/>`
    })
    out = out.replace(/<((?:\w+:)?)cols\b[^>]*>\s*<\/\1cols>/g, '')
  }
  return out
}

const IDENTITY_AXIS: AxisMap = { from: [], to: new Map(), bound: 0, delta: 0, identity: true }
const IDENTITY_MAPS: SheetMaps = { rows: IDENTITY_AXIS, cols: IDENTITY_AXIS }

function sheetDataXml(sh: XSheet, grid: string[][], lang: 'hu' | 'en', recalc = false, maps: SheetMaps = IDENTITY_MAPS): { xml: string; changed: boolean } {
  const P = sh.prefix
  const nRows = grid.length
  const nCols = grid.reduce((m, r) => Math.max(m, r.length), 0)
  const still = maps.rows.identity && maps.cols.identity
  // Valtozas = egy cella mas lett, vagy egy meglevo cella kiesett a racsbol
  // (torolt sor/oszlop). Egy ures sor hozzaadasa magaban nem valtozas.
  let changed = !still
  for (const [r, row] of sh.rows) for (const c of row.cells.keys()) if (r >= nRows || c >= nCols) changed = true
  const out: string[] = []
  // Az ures, de formazott (pl. sormagassagos) sorok is maradnak, ha a racson belul vannak.
  for (let r = 0; r < nRows; r++) {
    const ro = originOf(maps.rows, r)
    const orig = ro == null ? undefined : sh.rows.get(ro)
    const cells: string[] = []
    for (let c = 0; c < nCols; c++) {
      const want = grid[r]?.[c] ?? ''
      const co = originOf(maps.cols, c)
      const o = co == null ? undefined : orig?.cells.get(co)
      // In place and unchanged: the cell goes back exactly as it was.
      if (o && o.display === want && ro === r && co === c) { cells.push(recalc && o.formula ? withoutCachedValue(o.xml) : o.xml); continue }
      if (!o && want === '') continue
      if (!o || o.display !== want) changed = true
      // Moved, or changed: written again at its new place, with the style it had.
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
  if (sheets.some((sh) => sh.from !== undefined)) return writeXlsxSheets(book, sheets, lang)
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

// ---- munkalapok: uj, atnevezett, torolt, atrendezett (#526) -------------------------
//
// Owner, 2026-10-09: "a fulet [...] elnevezest nem lehet megvaltoztatni. [...] lehessen
// itt is megcsinalni." The save still PATCHES the opened file: a sheet that stays keeps
// its own part (formatting, widths, merges), only its changed cells are rewritten. What
// is new: the list of sheets in workbook.xml may change.

/** Why Excel would refuse this sheet name, or null when it is fine. */
export function sheetNameProblem(name: string): 'empty' | 'long' | 'chars' | 'quote' | null {
  const n = String(name ?? '')
  if (!n.trim()) return 'empty'
  if (n.length > 31) return 'long'
  if (/[\\/?*[\]:]/.test(n)) return 'chars'
  if (n.startsWith("'") || n.endsWith("'")) return 'quote'
  return null
}

/** A sheet name as a formula writes it: quoted unless it is a plain word. */
function sheetRef(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_.]*$/.test(name) ? name : `'${name.replace(/'/g, "''")}'`
}

function reEscape(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

/**
 * Point every reference to a renamed sheet at its new name, in formula TEXT (not XML).
 * Both spellings are matched: 'Old name'!A1 and Old!A1. Text inside a string literal
 * ("...") is left alone.
 */
export function renameSheetInFormula(formula: string, renames: Map<string, string>): string {
  if (!renames.size) return formula
  return formula.split(/("(?:[^"]|"")*")/).map((part, i) => {
    if (i % 2) return part
    let out = part
    for (const [from, to] of renames) {
      const quoted = new RegExp(`'${reEscape(from.replace(/'/g, "''"))}'!`, 'gi')
      out = out.replace(quoted, () => `${sheetRef(to)}!`)
      // Unquoted: Excel writes a name made of letters, digits, _ and . without quotes --
      // accented letters included (Összesítő!A1).
      if (/^[\p{L}_][\p{L}\p{N}_.]*$/u.test(from)) {
        const bare = new RegExp(`(^|[^\\p{L}\\p{N}_.'\\]])${reEscape(from)}!`, 'giu')
        out = out.replace(bare, (_m, pre: string) => `${pre}${sheetRef(to)}!`)
      }
    }
    return out
  }).join('')
}

function renameInSheetXml(xml: string, renames: Map<string, string>): string {
  if (!renames.size) return xml
  return xml.replace(/(<((?:\w+:)?)f\b[^>]*>)([\s\S]*?)(<\/\2f>)/g, (_m, open: string, _p: string, body: string, close: string) =>
    open + xmlEscape(renameSheetInFormula(xmlUnescape(body), renames)) + close)
}

function newSheetXml(grid: string[][], lang: 'hu' | 'en'): string {
  const rows: string[] = []
  let nCols = 0
  let nRows = 0
  grid.forEach((row, r) => {
    const cells = row.map((v, c) => cellXml(colName(c) + (r + 1), v, '', null, false, lang)).filter(Boolean)
    if (!cells.length) return
    rows.push(`<row r="${r + 1}">${cells.join('')}</row>`)
    nRows = r + 1
    row.forEach((v, c) => { if (v !== '' && c + 1 > nCols) nCols = c + 1 })
  })
  const dim = nRows && nCols ? `A1:${colName(nCols - 1)}${nRows}` : 'A1'
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + `<dimension ref="${dim}"/><sheetData>${rows.join('')}</sheetData></worksheet>`
}

function writeXlsxSheets(book: XBook, sheets: TableSheet[], lang: 'hu' | 'en'): TableResult<{ data: Buffer }> {
  // -- what was asked, checked before anything is built
  const seenFrom = new Set<number>()
  const seenName = new Set<string>()
  for (const sh of sheets) {
    if (sh.from === undefined) return { ok: false, code: 'table_bad_input' }
    if (sh.from !== null) {
      if (sh.from >= book.sheets.length || seenFrom.has(sh.from)) return { ok: false, code: 'table_sheets_changed' }
      seenFrom.add(sh.from)
    }
    const bad = sheetNameProblem(sh.name)
    if (bad) return { ok: false, code: 'table_sheet_name_' + bad, detail: sh.name }
    const key = sh.name.toLowerCase()
    if (seenName.has(key)) return { ok: false, code: 'table_sheet_name_twice', detail: sh.name }
    seenName.add(key)
  }
  if (!sheets.length) return { ok: false, code: 'table_bad_input' }

  const wbEntry = entry(book.entries, 'xl/workbook.xml')!
  const relsEntry = entry(book.entries, 'xl/_rels/workbook.xml.rels')!
  const ctEntry = entry(book.entries, '[Content_Types].xml')
  if (!ctEntry) return { ok: false, code: 'table_bad_file' }
  let wbXml = wbEntry.data.toString('utf8')
  let relsXml = relsEntry.data.toString('utf8')
  let ctXml = ctEntry.data.toString('utf8')

  const removed = book.sheets.filter((_s, i) => !seenFrom.has(i))
  const renames = new Map<string, string>()
  for (const sh of sheets) if (sh.from != null && book.sheets[sh.from]!.name !== sh.name) renames.set(book.sheets[sh.from]!.name, sh.name)
  const added = sheets.filter((sh) => sh.from === null)
  const keptOrder = sheets.filter((sh) => sh.from != null).map((sh) => sh.from as number)
  const reordered = keptOrder.some((f, i) => i > 0 && f < keptOrder[i - 1]!)
  const structural = removed.length > 0 || renames.size > 0 || added.length > 0 || reordered

  // -- the sheets that stay: patched as before, formulas pointed at renamed sheets
  const replaced = new Map<string, Buffer>()
  let cellsChanged = false
  // Rows and columns that were inserted, removed or moved, per ORIGINAL sheet name.
  const mapsBySheet = new Map<string, SheetMaps>()
  for (const sh of sheets) {
    if (sh.from == null) continue
    const x = book.sheets[sh.from]!
    const maps: SheetMaps = { rows: axisMap(sh.rowsFrom, x.nRows), cols: axisMap(sh.colsFrom, x.nCols) }
    if (maps.rows.identity && maps.cols.identity) continue
    // What sits at a cell position and is not followed by this save would end up under the wrong rows.
    if (x.objects) return { ok: false, code: 'table_structure_objects', detail: sh.name }
    mapsBySheet.set(x.name, maps)
  }
  for (const sh of sheets) {
    if (sh.from == null) continue
    const x = book.sheets[sh.from]!
    const maps = mapsBySheet.get(x.name) || IDENTITY_MAPS
    const res = sheetDataXml(x, sh.rows, lang, true, maps)
    if (res.changed) cellsChanged = true
    const hasFormula = [...x.rows.values()].some((r) => [...r.cells.values()].some((c) => c.formula))
    const file = entry(book.entries, x.path)!
    let sx = file.data.toString('utf8')
    if (maps !== IDENTITY_MAPS) sx = shiftSheetParts(sx, maps, x.name)
    if (res.changed || hasFormula) {
      sx = sx.replace(SHEET_DATA_RE, () => res.xml)
      const nRows = sh.rows.length
      const nCols = sh.rows.reduce((m, r) => Math.max(m, r.length), 0)
      const dim = nRows && nCols ? `A1:${colName(Math.max(0, nCols - 1))}${Math.max(1, nRows)}` : 'A1'
      sx = sx.replace(/<((?:\w+:)?)dimension\b[^>]*\/>/, (_m, pre: string) => `<${pre}dimension ref="${dim}"/>`)
    }
    sx = renameInSheetXml(sx, renames)
    if (sx !== file.data.toString('utf8')) replaced.set(x.path, Buffer.from(sx, 'utf8'))
  }
  if (!structural && !cellsChanged) return { ok: false, code: 'table_no_change' }

  // -- new sheets: a part, a relationship, a content type and a <sheet> element each
  const usedPaths = new Set(book.entries.map((e) => e.name.toLowerCase()))
  const usedRids = new Set([...relsXml.matchAll(/\bId="([^"]+)"/g)].map((m) => m[1]!))
  let maxSheetId = 0
  for (const m of wbXml.matchAll(/<(?:\w+:)?sheet\b[^>]*\bsheetId="(\d+)"/g)) maxSheetId = Math.max(maxSheetId, Number(m[1]))
  const pre = /<((?:\w+:)?)sheets\b/.exec(wbXml)?.[1] || ''
  // The prefix the file itself uses for the relationships namespace (usually "r").
  const relNs = /xmlns:(\w+)="http:\/\/schemas\.openxmlformats\.org\/officeDocument\/2006\/relationships"/.exec(wbXml)?.[1] || 'r'
  if (!new RegExp(`xmlns:${relNs}=`).test(wbXml)) {
    wbXml = wbXml.replace(/<((?:\w+:)?)workbook\b/, (m) => `${m} xmlns:${relNs}="http://schemas.openxmlformats.org/officeDocument/2006/relationships"`)
  }
  const newParts: { name: string; data: Buffer }[] = []
  const tagOf = new Map<TableSheet, string>()
  let n = 1
  let ridN = 1
  for (const sh of added) {
    while (usedPaths.has(`xl/worksheets/sheet${n}.xml`)) n++
    const path = `xl/worksheets/sheet${n}.xml`
    usedPaths.add(path)
    while (usedRids.has(`rId${ridN}`)) ridN++
    const rid = `rId${ridN}`
    usedRids.add(rid)
    maxSheetId++
    newParts.push({ name: path, data: Buffer.from(newSheetXml(sh.rows, lang), 'utf8') })
    relsXml = relsXml.replace(/<\/((?:\w+:)?)Relationships>/, (_m, p: string) =>
      `<${p}Relationship Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${n}.xml"/></${p}Relationships>`)
    ctXml = ctXml.replace(/<\/((?:\w+:)?)Types>/, (_m, p: string) =>
      `<${p}Override PartName="/${path}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></${p}Types>`)
    tagOf.set(sh, `<${pre}sheet name="${xmlEscape(sh.name)}" sheetId="${maxSheetId}" ${relNs}:id="${rid}"/>`)
  }

  // -- removed sheets: the part, its own relationships file, its relationship and content type
  const dropParts = new Set<string>()
  for (const x of removed) {
    dropParts.add(x.path)
    const dir = x.path.slice(0, x.path.lastIndexOf('/') + 1)
    dropParts.add(`${dir}_rels/${x.path.slice(dir.length)}.rels`)
    relsXml = relsXml.replace(new RegExp(`<(?:\\w+:)?Relationship\\b[^>]*\\bId="${reEscape(x.rid)}"[^>]*/>`), '')
    ctXml = ctXml.replace(new RegExp(`<(?:\\w+:)?Override\\b[^>]*PartName="/${reEscape(x.path)}"[^>]*/>`, 'i'), '')
  }

  // -- workbook.xml: the <sheets> list in the asked order; sheets we do not show (chart sheets) keep their place at the end
  const allTags = [...wbXml.matchAll(/<(?:\w+:)?sheet\b[^>]*\/?>(?:\s*<\/(?:\w+:)?sheet>)?/g)].map((m) => m[0])
  const ours = new Set(book.sheets.map((x) => x.tag))
  const foreign = allTags.filter((tg) => !ours.has(tg))
  const newTags = sheets.map((sh) => {
    if (sh.from == null) return tagOf.get(sh)!
    const x = book.sheets[sh.from]!
    return x.name === sh.name ? x.tag : x.tag.replace(/\bname="[^"]*"/, () => `name="${xmlEscape(sh.name)}"`)
  }).concat(foreign)
  wbXml = wbXml.replace(/(<((?:\w+:)?)sheets\b[^>]*>)[\s\S]*?(<\/\2sheets>)/, (_m, open: string, _p: string, close: string) => open + newTags.join('') + close)

  // -- names scoped to a sheet count the sheets by position: follow the new positions, drop the removed sheet's
  const oldIndexOfTag = new Map(allTags.map((tg, i) => [tg, i] as [string, number]))
  const newIndexOfOld = new Map<number, number>()
  sheets.forEach((sh, i) => { if (sh.from != null) newIndexOfOld.set(oldIndexOfTag.get(book.sheets[sh.from]!.tag)!, i) })
  foreign.forEach((tg, i) => newIndexOfOld.set(oldIndexOfTag.get(tg)!, sheets.length + i))
  wbXml = wbXml.replace(/<((?:\w+:)?)definedName\b([^>]*)>([\s\S]*?)<\/\1definedName>/g, (m, p: string, at: string, body: string) => {
    const local = /\blocalSheetId="(\d+)"/.exec(at)
    let a2 = at
    if (local) {
      const to = newIndexOfOld.get(Number(local[1]))
      if (to === undefined) return ''
      a2 = at.replace(/\blocalSheetId="\d+"/, `localSheetId="${to}"`)
    }
    const moved = mapsBySheet.size ? mapFormulaRefs(xmlUnescape(body), null, (n) => mapsBySheet.get(n) || null) : xmlUnescape(body)
    return `<${p}definedName${a2}>${xmlEscape(renameSheetInFormula(moved, renames))}</${p}definedName>`
  })
  wbXml = wbXml.replace(/<((?:\w+:)?)definedNames\b[^>]*>\s*<\/\1definedNames>/, '')
  // The tab that was open may be gone.
  const total = newTags.length
  wbXml = wbXml.replace(/\b(activeTab|firstSheet)="(\d+)"/g, (m, k: string, v: string) => (Number(v) < total ? m : `${k}="0"`))

  // -- full recalculation on open, and no stale calculation chain (as in the plain save)
  const calc = book.entries.find((e) => e.name === 'xl/calcChain.xml')
  if (calc) {
    ctXml = ctXml.replace(/<Override\b[^>]*PartName="\/xl\/calcChain\.xml"[^>]*\/>/g, '')
    relsXml = relsXml.replace(/<Relationship\b[^>]*Target="[^"]*calcChain\.xml"[^>]*\/>/g, '')
  }
  const cp = /<((?:\w+:)?)calcPr\b([^>]*?)\/>/.exec(wbXml)
  if (cp) wbXml = wbXml.replace(cp[0], `<${cp[1]}calcPr${cp[2]!.replace(/\sfullCalcOnLoad\s*=\s*"[^"]*"/, '')} fullCalcOnLoad="1"/>`)
  else {
    const wp = /<((?:\w+:)?)workbook\b/.exec(wbXml)?.[1] || ''
    wbXml = wbXml.replace(new RegExp(`</${wp}workbook>`), `<${wp}calcPr fullCalcOnLoad="1"/></${wp}workbook>`)
  }

  const out: { name: string; data: Buffer }[] = []
  for (const e of book.entries) {
    if ((calc && e === calc) || dropParts.has(e.name)) continue
    const data = e.name === 'xl/workbook.xml' ? Buffer.from(wbXml, 'utf8')
      : e.name === 'xl/_rels/workbook.xml.rels' ? Buffer.from(relsXml, 'utf8')
        : e.name === '[Content_Types].xml' ? Buffer.from(ctXml, 'utf8')
          : replaced.get(e.name) || e.data
    out.push({ name: e.name, data })
  }
  for (const part of newParts) out.push(part)
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
