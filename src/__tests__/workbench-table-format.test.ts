// #526, part 3, section A -- font and fill formatting of an .xlsx: read into the editor,
// saved back as NEW formats at the end of the stylesheet, nothing else touched.
import { describe, it, expect } from 'vitest'
import { buildZip } from '../web/zip-writer.js'
import { readTable, writeTable, readZip, normalizeSheets, blankXlsx } from '../workbench-table.js'
import { parseStyleBook, xfStyle, StyleWriter, sanitizeCellStyle } from '../workbench-table-style.js'

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
const RNS = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'

const STYLES = `<?xml version="1.0"?><styleSheet ${NS}>`
  + '<fonts count="3"><font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font>'
  + '<font><b/><sz val="14"/><color rgb="FFFF0000"/><name val="Arial"/></font>'
  + '<font><i/><u/><sz val="11"/><name val="Calibri"/></font></fonts>'
  + '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>'
  + '<fill><patternFill patternType="solid"><fgColor rgb="FFFFFF00"/><bgColor indexed="64"/></patternFill></fill></fills>'
  + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
  + '<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>'
  + '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" applyFont="1" applyFill="1"><alignment horizontal="center" wrapText="1"/></xf>'
  + '<xf numFmtId="14" fontId="2" fillId="0" borderId="0" applyNumberFormat="1"/></cellXfs></styleSheet>'

function book(): Buffer {
  const files: Record<string, string> = {
    '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/worksheets/sheet1.xml" ContentType="ws"/></Types>',
    'xl/workbook.xml': `<?xml version="1.0"?><workbook ${NS} ${RNS}><sheets><sheet name="Lap1" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="ws" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/styles.xml': STYLES,
    'xl/worksheets/sheet1.xml': `<?xml version="1.0"?><worksheet ${NS}><dimension ref="A1:C2"/><sheetData>`
      + '<row r="1"><c r="A1" s="1" t="inlineStr"><is><t>Cím</t></is></c><c r="B1" t="inlineStr"><is><t>sima</t></is></c><c r="C1" s="2"><v>45000</v></c></row>'
      + '<row r="2"><c r="A2" t="inlineStr"><is><t>x</t></is></c></row></sheetData></worksheet>',
  }
  return buildZip(Object.entries(files).map(([name, data]) => ({ name, data })))
}

const part = (buf: Buffer, name: string): string => readZip(buf)!.find((x) => x.name === name)!.data.toString('utf8')

describe('reading the formats of a file', () => {
  it('turns font and fill of an xf into the editor style', () => {
    const sb = parseStyleBook(STYLES, null)!
    expect(xfStyle(sb, 0)).toEqual({ fs: 11, ff: 'Calibri' })
    expect(xfStyle(sb, 1)).toEqual({ b: true, fs: 14, ff: 'Arial', fc: '#FF0000', bg: '#FFFF00', ha: 'c', wr: true })
    expect(xfStyle(sb, 2)).toEqual({ i: true, u: true, fs: 11, ff: 'Calibri', nf: 'yyyy-mm-dd' })
  })

  it('readTable lists the formatted cells and the styles they use', () => {
    const r = readTable(book(), 'a.xlsx')
    if (!r.ok) throw new Error(r.code)
    expect(r.table.formatting).toBe(true)
    const sh = r.table.sheets[0]!
    expect(sh.cellStyles).toEqual([[0, 0, 1], [0, 2, 2]])
    expect(r.table.styleTable!['1']!.b).toBe(true)
  })

  it('a theme colour with a tint is resolved against the theme', () => {
    const x = STYLES.replace('<color rgb="FFFF0000"/>', '<color theme="4" tint="0.5"/>')
    const sb = parseStyleBook(x, null)!
    expect(xfStyle(sb, 1).fc).toMatch(/^#[0-9A-F]{6}$/)
    expect(xfStyle(sb, 1).fc).not.toBe('#4472C4')
  })
})

describe('saving formats', () => {
  const sheetsFrom = (buf: Buffer): ReturnType<typeof readTable> extends infer R ? R : never => readTable(buf, 'a.xlsx') as never

  it('a changed cell gets a NEW xf; the old xfs, fonts and fills are untouched and others keep their s', () => {
    const src = book()
    const r = readTable(src, 'a.xlsx')
    if (!r.ok) throw new Error(r.code)
    const sheet = { ...r.table.sheets[0]!, fmt: [[0, 1, { b: true, bg: '#00FF00', ha: 'r' as const, fs: 11, ff: 'Calibri' }]] as [number, number, never][] }
    const out = writeTable(src, 'a.xlsx', [sheet as never])
    if (!out.ok) throw new Error(out.code)
    const styles = part(out.data, 'xl/styles.xml')
    expect(styles).toContain('<cellXfs count="4">')
    expect(styles).toContain('<fonts count="4">')
    expect(styles).toContain('<fills count="4">')
    // the original entries are still there byte for byte
    const oldFonts = STYLES.slice(STYLES.indexOf('>', STYLES.indexOf('<fonts')) + 1, STYLES.indexOf('</fonts>'))
    expect(styles).toContain(oldFonts)
    expect(styles).toContain('<font><b/><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font>')
    const sx = part(out.data, 'xl/worksheets/sheet1.xml')
    expect(sx).toContain('<c r="B1" s="3"')
    expect(sx).toContain('<c r="A1" s="1"')
    expect(sx).toContain('<c r="C1" s="2"')
    const newXf = /<xf [^>]*fontId="3"[^>]*fillId="3"[^>]*>[\s\S]*?<\/xf>/.exec(styles)![0]
    expect(newXf).toContain('horizontal="right"')
    // the new font is bold, and Calibri's theme scheme stays (the name did not change)
    expect(/<font><b\/>[\s\S]*?<\/font>$/.test(/<fonts[\s\S]*<\/fonts>/.exec(styles)![0].replace('</fonts>', '').split('<font>').pop()!.replace(/^/, '<font>'))).toBe(true)
    // read back
    const back = sheetsFrom(out.data)
    if (!back.ok) throw new Error(back.code)
    expect(back.table.styleTable![String(back.table.sheets[0]!.cellStyles!.find((c) => c[1] === 1)![2])]).toMatchObject({ b: true, bg: '#00FF00', ha: 'r' })
  })

  it('a style equal to the original changes nothing', () => {
    const src = book()
    const r = readTable(src, 'a.xlsx')
    if (!r.ok) throw new Error(r.code)
    const same = r.table.styleTable!['1']!
    const sheet = { ...r.table.sheets[0]!, fmt: [[0, 0, same]] }
    const out = writeTable(src, 'a.xlsx', [sheet as never])
    expect(out).toEqual({ ok: false, code: 'table_no_change' })
  })

  it('clearing the fill points the cell at fill 0; two cells with the same change share one xf', () => {
    const src = book()
    const r = readTable(src, 'a.xlsx')
    if (!r.ok) throw new Error(r.code)
    const noFill = { ...r.table.styleTable!['1']! }
    delete noFill.bg
    const sheet = { ...r.table.sheets[0]!, fmt: [[0, 0, noFill], [1, 0, { i: true }]] as never }
    const out = writeTable(src, 'a.xlsx', [sheet as never])
    if (!out.ok) throw new Error(out.code)
    const styles = part(out.data, 'xl/styles.xml')
    expect(styles).toContain('<fills count="3">') // no new fill
    expect(/<xf [^>]*fillId="0"[^>]*applyFill="1"/.test(styles.slice(styles.indexOf('<cellXfs')))).toBe(true)
  })

  it('a blank workbook (minimal stylesheet) takes formatting too', () => {
    const blank = blankXlsx('Lap', ['A', 'B'])
    const r = readTable(blank, 'n.xlsx')
    if (!r.ok) throw new Error(r.code)
    // a minimal stylesheet is fine; header cells get bold
    const sheet = { ...r.table.sheets[0]!, fmt: [[0, 0, { b: true }], [0, 1, { b: true }]] }
    const out = writeTable(blank, 'n.xlsx', [sheet as never])
    if (!out.ok) throw new Error(out.code)
    expect(part(out.data, 'xl/styles.xml')).toContain('<cellXfs count="2">')
    expect(part(out.data, 'xl/worksheets/sheet1.xml')).toContain('s="1"')
  })

  it('moved rows keep the formatting of the cell (existing behaviour) and a new format applies at the new place', () => {
    const src = book()
    const r = readTable(src, 'a.xlsx')
    if (!r.ok) throw new Error(r.code)
    const sheet = { ...r.table.sheets[0]!, rows: [[''], ...r.table.sheets[0]!.rows], rowsFrom: [null, 0, 1], colsFrom: [0, 1, 2], from: 0, fmt: [[0, 0, { b: true }]] }
    const out = writeTable(src, 'a.xlsx', [sheet as never])
    if (!out.ok) throw new Error(out.code)
    const sx = part(out.data, 'xl/worksheets/sheet1.xml')
    expect(sx).toContain('<c r="A2" s="1"')
    expect(sx).toMatch(/<c r="A1" s="3"/)
  })
})

describe('column widths and row heights', () => {
  const withSizes = (): Buffer => {
    const z = readZip(book())!
    const sh = z.find((x) => x.name === 'xl/worksheets/sheet1.xml')!
    sh.data = Buffer.from(sh.data.toString('utf8')
      .replace('<sheetData>', '<cols><col min="1" max="2" width="20" customWidth="1"/></cols><sheetData>')
      .replace('<row r="1">', '<row r="1" ht="30" customHeight="1">'), 'utf8')
    return buildZip(z.map((x) => ({ name: x.name, data: x.data })))
  }

  it('reads the widths (a span covers its columns) and the custom heights in pixels', () => {
    const r = readTable(withSizes(), 'a.xlsx')
    if (!r.ok) throw new Error(r.code)
    const sh = r.table.sheets[0]!
    expect(sh.colWidths).toEqual({ '0': 145, '1': 145 })
    expect(sh.rowHeights).toEqual({ '0': 40 })
  })

  it('a changed width splits the span; a changed height sets ht + customHeight; nothing else moves', () => {
    const src = withSizes()
    const r = readTable(src, 'a.xlsx')
    if (!r.ok) throw new Error(r.code)
    const sheet = { ...r.table.sheets[0]!, colWidths: { '1': 200, '3': 90 }, rowHeights: { '1': 40 } }
    const out = writeTable(src, 'a.xlsx', [sheet as never])
    if (!out.ok) throw new Error(out.code)
    const sx = part(out.data, 'xl/worksheets/sheet1.xml')
    expect(sx).toContain('<col min="1" max="1" width="20" customWidth="1"/>')
    expect(sx).toMatch(/<col min="2" max="2" width="27\.86" customWidth="1"\/>/)
    expect(sx).toMatch(/<col min="4" max="4" width="12\.14" customWidth="1"\/>/)
    expect(sx).toMatch(/<row r="2" ht="30" customHeight="1">/)
    expect(sx).toContain('<c r="C1" s="2"')
    const back = readTable(out.data, 'a.xlsx')
    if (!back.ok) throw new Error(back.code)
    expect(back.table.sheets[0]!.colWidths!['1']).toBe(200)
  })

  it('the same sizes as in the file are no change', () => {
    const src = withSizes()
    const r = readTable(src, 'a.xlsx')
    if (!r.ok) throw new Error(r.code)
    const sheet = { ...r.table.sheets[0]!, colWidths: r.table.sheets[0]!.colWidths, rowHeights: r.table.sheets[0]!.rowHeights }
    expect(writeTable(src, 'a.xlsx', [sheet as never])).toEqual({ ok: false, code: 'table_no_change' })
  })
})

describe('the wire', () => {
  it('only supported properties and valid colours get through', () => {
    expect(sanitizeCellStyle({ b: true, fc: 'red', bg: '#abcdef', ha: 'x', fs: 12, evil: 1 })).toEqual({ b: true, bg: '#ABCDEF', fs: 12 })
    expect(sanitizeCellStyle('x')).toBeNull()
    const n = normalizeSheets([{ name: 'A', rows: [['x']], fmt: [[0, 0, { b: true }]] }])
    expect(n.ok && n.sheets[0]!.fmt).toEqual([[0, 0, { b: true }]])
    expect(normalizeSheets([{ name: 'A', rows: [['x']], fmt: [[-1, 0, { b: true }]] }]).ok).toBe(false)
  })

  it('StyleWriter output is parseable again', () => {
    const sb = parseStyleBook(STYLES, null)!
    const w = new StyleWriter(sb)
    const i = w.apply(0, { b: true, fs: 11, ff: 'Calibri', wr: true })!
    const sb2 = parseStyleBook(w.xml(), null)!
    expect(xfStyle(sb2, i)).toMatchObject({ b: true, wr: true, fs: 11 })
  })
})
