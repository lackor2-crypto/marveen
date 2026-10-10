// #526, part 3, section C -- number formats of an .xlsx: read as a format code, saved as NEW
// numFmt / xf entries at the end of the stylesheet; the file's own entries are never rewritten.
import { describe, it, expect } from 'vitest'
import { buildZip } from '../web/zip-writer.js'
import { readTable, writeTable, readZip } from '../workbench-table.js'
import { parseStyleBook, xfStyle, sanitizeCellStyle, StyleWriter } from '../workbench-table-style.js'

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
const RNS = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'

const STYLES = `<?xml version="1.0"?><styleSheet ${NS}>`
  + '<numFmts count="2"><numFmt numFmtId="164" formatCode="#,##0.0&quot; Ft&quot;"/><numFmt numFmtId="165" formatCode="yyyy\\.mm\\.dd"/></numFmts>'
  + '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>'
  + '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'
  + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
  + '<cellXfs count="5"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>'
  + '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" applyNumberFormat="1"/>'
  + '<xf numFmtId="165" fontId="0" fillId="0" borderId="0" applyNumberFormat="1"/>'
  + '<xf numFmtId="10" fontId="0" fillId="0" borderId="0" applyNumberFormat="1"/>'
  + '<xf numFmtId="2" fontId="0" fillId="0" borderId="0" applyNumberFormat="1"/></cellXfs></styleSheet>'

function book(styles = STYLES): Buffer {
  const files: Record<string, string> = {
    '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/worksheets/sheet1.xml" ContentType="ws"/></Types>',
    'xl/workbook.xml': `<?xml version="1.0"?><workbook ${NS} ${RNS}><sheets><sheet name="Lap1" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="ws" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/styles.xml': styles,
    'xl/worksheets/sheet1.xml': `<?xml version="1.0"?><worksheet ${NS}><dimension ref="A1:D3"/><sheetData>`
      + '<row r="1"><c r="A1" s="1"><v>1234.5</v></c><c r="B1" s="2"><v>45356</v></c><c r="C1" s="3"><v>0.25</v></c><c r="D1" s="4"><v>3</v></c></row>'
      + '<row r="2"><c r="A2"><v>7</v></c><c r="B2" t="inlineStr"><is><t>szoveg</t></is></c></row>'
      + '<row r="3"><c r="A3" t="inlineStr"><is><t>z</t></is></c></row></sheetData></worksheet>',
  }
  return buildZip(Object.entries(files).map(([name, data]) => ({ name, data })))
}

const part = (buf: Buffer, name: string): string => readZip(buf)!.find((x) => x.name === name)!.data.toString('utf8')
const read = (b: Buffer) => { const r = readTable(b, 'a.xlsx'); if (!r.ok) throw new Error(r.code); return r.table }
const save = (src: Buffer, fmt: unknown) => {
  const t = read(src)
  const out = writeTable(src, 'a.xlsx', [{ ...t.sheets[0]!, fmt } as never])
  if (!out.ok) throw new Error(out.code)
  return out.data
}

describe('reading number formats', () => {
  it('custom and built-in formats come as codes; General is nothing', () => {
    const sb = parseStyleBook(STYLES, null)!
    expect(xfStyle(sb, 0).nf).toBeUndefined()
    expect(xfStyle(sb, 1).nf).toBe('#,##0.0" Ft"')
    expect(xfStyle(sb, 2).nf).toBe('yyyy\\.mm\\.dd')
    expect(xfStyle(sb, 3).nf).toBe('0.00%')
    expect(xfStyle(sb, 4).nf).toBe('0.00')
  })

  it('the table carries nf in the style table; dates still read as ISO text', () => {
    const t = read(book())
    const k = (r: number, c: number) => String(t.sheets[0]!.cellStyles!.find((x) => x[0] === r && x[1] === c)![2])
    expect(t.styleTable![k(0, 0)]!.nf).toBe('#,##0.0" Ft"')
    expect(t.sheets[0]!.rows[0]).toEqual(['1234.5', '2024-03-05', '0.25', '3'])
  })

  it('sanitize: a code is kept, General / control characters are not', () => {
    expect(sanitizeCellStyle({ nf: '0.00%' })).toEqual({ nf: '0.00%' })
    expect(sanitizeCellStyle({ nf: 'General' })).toEqual({})
    expect(sanitizeCellStyle({ nf: '0\u0001' })).toEqual({})
    expect(sanitizeCellStyle({ nf: 5 })).toEqual({})
  })
})

describe('saving number formats', () => {
  it('a new custom format is a NEW numFmt (id after the last) and a NEW xf; old entries stay', () => {
    const out = save(book(), [[1, 0, { nf: '0.000" kg"' }]])
    const st = part(out, 'xl/styles.xml')
    expect(st).toContain('<numFmts count="3">')
    expect(st).toContain('<numFmt numFmtId="166" formatCode="0.000&quot; kg&quot;"/>')
    expect(st).toContain('<numFmt numFmtId="164" formatCode="#,##0.0&quot; Ft&quot;"/>')
    expect(st).toContain('<cellXfs count="6">')
    expect(/<xf numFmtId="166"[^>]*applyNumberFormat="1"/.test(st)).toBe(true)
    const sx = part(out, 'xl/worksheets/sheet1.xml')
    expect(sx).toContain('<c r="A2" s="5"')
    expect(sx).toContain('<c r="A1" s="1"')
    const back = read(out)
    const key = back.sheets[0]!.cellStyles!.find((c) => c[0] === 1 && c[1] === 0)![2]
    expect(back.styleTable![String(key)]!.nf).toBe('0.000" kg"')
  })

  it('a built-in code is written as its id, not as a new numFmt', () => {
    const out = save(book(), [[1, 0, { nf: '0%' }]])
    const st = part(out, 'xl/styles.xml')
    expect(st).toContain('<numFmts count="2">')
    expect(/<xf numFmtId="9"[^>]*applyNumberFormat="1"/.test(st)).toBe(true)
  })

  it('a code the file already has is reused', () => {
    const out = save(book(), [[1, 0, { nf: 'yyyy\\.mm\\.dd' }]])
    const st = part(out, 'xl/styles.xml')
    expect(st).toContain('<numFmts count="2">')
    expect(/<xf numFmtId="165"[^>]*>/.test(st.slice(st.indexOf('</cellXfs>') - 120))).toBe(true)
    expect(read(out).styleTable![String(read(out).sheets[0]!.cellStyles!.find((c) => c[0] === 1 && c[1] === 0)![2])]!.nf).toBe('yyyy\\.mm\\.dd')
  })

  it('a file without <numFmts> gets the part, ahead of the fonts', () => {
    const out = save(book(STYLES.replace(/<numFmts[\s\S]*<\/numFmts>/, '').replace('numFmtId="164"', 'numFmtId="0"').replace('numFmtId="165"', 'numFmtId="0"')), [[1, 0, { nf: '0.0000' }]])
    const st = part(out, 'xl/styles.xml')
    expect(st).toMatch(/<numFmts count="1"><numFmt numFmtId="164" formatCode="0\.0000"\/><\/numFmts><fonts/)
  })

  it('General on a formatted cell points it at numFmtId 0', () => {
    const out = save(book(), [[0, 2, {}]])
    const st = part(out, 'xl/styles.xml')
    expect(st).toContain('<cellXfs count="6">')
    expect(st).toMatch(/<xf numFmtId="0"[^>]*applyNumberFormat="1"[^>]*><\/xf><\/cellXfs>/)
  })

  it('an unchanged format changes nothing', () => {
    const src = book()
    const t = read(src)
    const style = t.styleTable![String(t.sheets[0]!.cellStyles![0]![2])]!
    expect(writeTable(src, 'a.xlsx', [{ ...t.sheets[0]!, fmt: [[0, 0, style]] } as never])).toEqual({ ok: false, code: 'table_no_change' })
  })
})

describe('a date format on a cell the editor sends as ISO text', () => {
  it('a date format set on a text cell makes the cell a date serial', () => {
    const src = book()
    const t = read(src)
    const rows = t.sheets[0]!.rows.map((r) => r.slice())
    rows[1]![0] = '2024-03-05'
    const out = writeTable(src, 'a.xlsx', [{ ...t.sheets[0]!, rows, fmt: [[1, 0, { nf: 'yyyy-mm-dd' }]] } as never])
    if (!out.ok) throw new Error(out.code)
    const sx = part(out.data, 'xl/worksheets/sheet1.xml')
    expect(sx).toMatch(/<c r="A2" s="5"><v>45356<\/v><\/c>/)
  })

  it('the format taken away from a date cell leaves the typed text a plain value', () => {
    const src = book()
    const t = read(src)
    const rows = t.sheets[0]!.rows.map((r) => r.slice())
    rows[0]![1] = '45356'
    const out = writeTable(src, 'a.xlsx', [{ ...t.sheets[0]!, rows, fmt: [[0, 1, {}]] } as never])
    if (!out.ok) throw new Error(out.code)
    expect(part(out.data, 'xl/worksheets/sheet1.xml')).toMatch(/<c r="B1" s="5"><v>45356<\/v><\/c>/)
  })
})

describe('StyleWriter number formats', () => {
  it('isDateXf tells file formats and appended ones apart', () => {
    const w = new StyleWriter(parseStyleBook(STYLES, null)!)
    expect(w.isDateXf(1)).toBe(false)
    expect(w.isDateXf(2)).toBe(true)
    expect(w.isDateXf(null)).toBe(false)
    const i = w.apply(0, { nf: 'yyyy-mm-dd hh:mm' })!
    expect(w.isDateXf(i)).toBe(true)
    const j = w.apply(0, { nf: '0.5%' })!
    expect(w.isDateXf(j)).toBe(false)
  })
})
