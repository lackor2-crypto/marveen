// #526, part 3, section B -- cell borders and merged cells of an .xlsx: read into the editor,
// saved back as NEW border/xf entries at the end of the stylesheet and a rewritten <mergeCells>.
import { describe, it, expect } from 'vitest'
import { buildZip } from '../web/zip-writer.js'
import { readTable, writeTable, readZip, normalizeSheets } from '../workbench-table.js'
import { parseStyleBook, xfStyle, sanitizeCellStyle } from '../workbench-table-style.js'

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
const RNS = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'

const STYLES = `<?xml version="1.0"?><styleSheet ${NS}>`
  + '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>'
  + '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'
  + '<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>'
  + '<border><left style="thin"><color auto="1"/></left><right style="thin"><color auto="1"/></right>'
  + '<top style="double"><color rgb="FFFF0000"/></top><bottom style="thin"><color auto="1"/></bottom><diagonal/></border></borders>'
  + '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>'
  + '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" applyBorder="1"/></cellXfs></styleSheet>'

function book(extra = '', styles = STYLES): Buffer {
  const files: Record<string, string> = {
    '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/worksheets/sheet1.xml" ContentType="ws"/></Types>',
    'xl/workbook.xml': `<?xml version="1.0"?><workbook ${NS} ${RNS}><sheets><sheet name="Lap1" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="ws" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/styles.xml': styles,
    'xl/worksheets/sheet1.xml': `<?xml version="1.0"?><worksheet ${NS}><dimension ref="A1:C3"/><sheetData>`
      + '<row r="1"><c r="A1" s="1" t="inlineStr"><is><t>keret</t></is></c><c r="B1" t="inlineStr"><is><t>b</t></is></c><c r="C1" t="inlineStr"><is><t>c</t></is></c></row>'
      + '<row r="2"><c r="A2" t="inlineStr"><is><t>x</t></is></c><c r="B2" t="inlineStr"><is><t>y</t></is></c></row>'
      + `<row r="3"><c r="A3" t="inlineStr"><is><t>z</t></is></c></row></sheetData>${extra}</worksheet>`,
  }
  return buildZip(Object.entries(files).map(([name, data]) => ({ name, data })))
}

const part = (buf: Buffer, name: string): string => readZip(buf)!.find((x) => x.name === name)!.data.toString('utf8')
const read = (b: Buffer) => { const r = readTable(b, 'a.xlsx'); if (!r.ok) throw new Error(r.code); return r.table }

describe('reading borders', () => {
  it('turns a border into four sides; auto colour is black (omitted), a colour is kept', () => {
    const sb = parseStyleBook(STYLES, null)!
    expect(xfStyle(sb, 0)).toEqual({ fs: 11, ff: 'Calibri' })
    expect(xfStyle(sb, 1).bd).toEqual({ l: { s: 'thin' }, r: { s: 'thin' }, t: { s: 'double', c: '#FF0000' }, b: { s: 'thin' } })
  })

  it('a file without a <borders> part still reads', () => {
    const sb = parseStyleBook(STYLES.replace(/<borders[\s\S]*<\/borders>/, ''), null)!
    expect(sb.bordersMissing).toBe(true)
    expect(xfStyle(sb, 0).bd).toBeUndefined()
  })

  it('sanitize keeps known sides and styles only', () => {
    const s = sanitizeCellStyle({ bd: { t: { s: 'thin', c: '#abcdef' }, x: { s: 'thin' }, b: { s: 'nope' } } })!
    expect(s.bd).toEqual({ t: { s: 'thin', c: '#ABCDEF' } })
  })
})

describe('saving borders', () => {
  it('a drawn border becomes a NEW border and a NEW xf; old entries and other cells stay', () => {
    const src = book()
    const t = read(src)
    const sheet = { ...t.sheets[0]!, fmt: [[0, 1, { bd: { b: { s: 'medium', c: '#0000FF' } } }]] }
    const out = writeTable(src, 'a.xlsx', [sheet as never])
    if (!out.ok) throw new Error(out.code)
    const st = part(out.data, 'xl/styles.xml')
    expect(st).toContain('<borders count="3">')
    expect(st).toContain('<cellXfs count="3">')
    expect(st).toContain(STYLES.slice(STYLES.indexOf('<borders'), STYLES.indexOf('</borders>')).replace('<borders count="2">', ''))
    expect(st).toContain('<bottom style="medium"><color rgb="FF0000FF"/></bottom>')
    const sx = part(out.data, 'xl/worksheets/sheet1.xml')
    expect(sx).toContain('<c r="B1" s="2"')
    expect(sx).toContain('<c r="A1" s="1"')
    expect(sx).toContain('<c r="A2"')
    expect(/<xf [^>]*borderId="2"[^>]*applyBorder="1"/.test(st)).toBe(true)
    // round trip
    const back = read(out.data)
    const key = back.sheets[0]!.cellStyles!.find((c) => c[1] === 1)![2]
    expect(back.styleTable![String(key)]!.bd).toEqual({ b: { s: 'medium', c: '#0000FF' } })
  })

  it('an unchanged border changes nothing', () => {
    const src = book()
    const t = read(src)
    const same = t.styleTable![String(t.sheets[0]!.cellStyles![0]![2])]!
    expect(writeTable(src, 'a.xlsx', [{ ...t.sheets[0]!, fmt: [[0, 0, same]] } as never])).toEqual({ ok: false, code: 'table_no_change' })
  })

  it('removing the border points the cell at a border without lines', () => {
    const src = book()
    const t = read(src)
    const noBd = { ...t.styleTable![String(t.sheets[0]!.cellStyles![0]![2])]! }
    delete noBd.bd
    const out = writeTable(src, 'a.xlsx', [{ ...t.sheets[0]!, fmt: [[0, 0, noBd]] } as never])
    if (!out.ok) throw new Error(out.code)
    const sx = part(out.data, 'xl/worksheets/sheet1.xml')
    expect(sx).not.toContain('<c r="A1" s="1"')
    const back = read(out.data)
    const k = back.sheets[0]!.cellStyles!.find((c) => c[0] === 0 && c[1] === 0)![2]
    expect(back.styleTable![String(k)]!.bd).toBeUndefined()
  })

  it('a file with no <borders> part gets one, default border first', () => {
    const src = book('', STYLES.replace(/<borders[\s\S]*<\/borders>/, '').replace(' borderId="1" applyBorder="1"', ''))
    const t = read(src)
    const out = writeTable(src, 'a.xlsx', [{ ...t.sheets[0]!, fmt: [[1, 0, { bd: { t: { s: 'thin' } } }]] } as never])
    if (!out.ok) throw new Error(out.code)
    const st = part(out.data, 'xl/styles.xml')
    expect(st).toMatch(/<borders count="2"><border><left\/><right\/><top\/><bottom\/><diagonal\/><\/border><border>/)
    expect(st.indexOf('<borders')).toBeLessThan(st.indexOf('<cellXfs'))
  })
})

describe('merged cells', () => {
  const EXTRA = '<mergeCells count="1"><mergeCell ref="B1:C2"/></mergeCells>'

  it('reads <mergeCells>', () => {
    expect(read(book(EXTRA)).sheets[0]!.merges).toEqual([[0, 1, 1, 2]])
    expect(read(book()).sheets[0]!.merges).toBeUndefined()
  })

  it('validates what the editor sends', () => {
    const ok = (m: unknown) => normalizeSheets([{ name: 'S', rows: [['a']], merges: m }] as never)
    expect(ok([[0, 0, 1, 1]]).ok).toBe(true)
    expect(ok([[0, 0, 1, 1], [1, 1, 2, 2]]).ok).toBe(false)
    expect(ok([[1, 1, 0, 0]]).ok).toBe(false)
    expect(ok([[0, 0, 0]]).ok).toBe(false)
    expect(ok('x').ok).toBe(false)
  })

  it('a new merge is written, in schema order, and the others are untouched', () => {
    const src = book('<pageMargins left="1" right="1" top="1" bottom="1" header="0" footer="0"/>')
    const t = read(src)
    const out = writeTable(src, 'a.xlsx', [{ ...t.sheets[0]!, merges: [[0, 1, 1, 2]] } as never])
    if (!out.ok) throw new Error(out.code)
    const sx = part(out.data, 'xl/worksheets/sheet1.xml')
    expect(sx).toContain('</sheetData><mergeCells count="1"><mergeCell ref="B1:C2"/></mergeCells><pageMargins')
    expect(sx).toContain('<c r="A1" s="1"')
  })

  it('unmerging removes the element; an unchanged list is no change', () => {
    const src = book(EXTRA)
    const t = read(src)
    expect(writeTable(src, 'a.xlsx', [{ ...t.sheets[0]!, merges: [[0, 1, 1, 2]] } as never])).toEqual({ ok: false, code: 'table_no_change' })
    const out = writeTable(src, 'a.xlsx', [{ ...t.sheets[0]!, merges: [] } as never])
    if (!out.ok) throw new Error(out.code)
    expect(part(out.data, 'xl/worksheets/sheet1.xml')).not.toContain('mergeCell')
  })

  it('a changed list replaces the old one', () => {
    const src = book(EXTRA)
    const t = read(src)
    const out = writeTable(src, 'a.xlsx', [{ ...t.sheets[0]!, merges: [[0, 0, 0, 1], [2, 0, 2, 2]] } as never])
    if (!out.ok) throw new Error(out.code)
    const sx = part(out.data, 'xl/worksheets/sheet1.xml')
    expect(sx).toContain('<mergeCells count="2"><mergeCell ref="A1:B1"/><mergeCell ref="A3:C3"/></mergeCells>')
    expect(read(out.data).sheets[0]!.merges).toEqual([[0, 0, 0, 1], [2, 0, 2, 2]])
  })

  it('a row inserted above moves the file merge along; the editor list and the shifted file agree', () => {
    const src = book(EXTRA)
    const t = read(src)
    const sh = t.sheets[0]!
    const moved = { ...sh, from: 0, rows: [['new', '', ''], ...sh.rows], rowsFrom: [null, 0, 1, 2], colsFrom: [0, 1, 2], merges: [[1, 1, 2, 2]] }
    const out = writeTable(src, 'a.xlsx', [moved as never])
    if (!out.ok) throw new Error(out.code)
    const sx = part(out.data, 'xl/worksheets/sheet1.xml')
    expect(sx).toContain('<mergeCell ref="B2:C3"/>')
    expect(sx.match(/<mergeCell /g)!.length).toBe(1)
  })

  it('after a move the editor list is the truth: a merge the editor dropped is gone', () => {
    const src = book(EXTRA)
    const t = read(src)
    const sh = t.sheets[0]!
    const moved = { ...sh, from: 0, rows: [['new', '', ''], ...sh.rows], rowsFrom: [null, 0, 1, 2], colsFrom: [0, 1, 2], merges: [] }
    const out = writeTable(src, 'a.xlsx', [moved as never])
    if (!out.ok) throw new Error(out.code)
    expect(part(out.data, 'xl/worksheets/sheet1.xml')).not.toContain('mergeCell')
  })
})
