// #526 -- SHEETS in the Workbench table editor: add, rename, remove, reorder.
//
// Owner, 2026-10-09: "a fulet, Excel fulet elnevezest nem lehet megvaltoztatni. Meg jo
// par dolgot nem lehet csinalni. Csak az Excelben. Miert? [...] lehessen itt is
// megcsinalni." The save patches the opened file, so until now the list of sheets had to
// stay as it was. These tests pin what the save now does to the file -- and that a sheet
// that stays keeps everything it had.
import { describe, it, expect } from 'vitest'
import { buildZip } from '../web/zip-writer.js'
import { readTable, writeTable, readZip, normalizeSheets, sheetNameProblem, renameSheetInFormula } from '../workbench-table.js'

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
const RNS = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'

/** Three sheets; the first is formatted (widths, a row height, a style) and holds a
 *  formula pointing at the second; a print area is scoped to the third. */
function book(): Buffer {
  const files: Record<string, string> = {
    '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="ws"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="ws"/>'
      + '<Override PartName="/xl/worksheets/sheet3.xml" ContentType="ws"/></Types>',
    'xl/workbook.xml': `<?xml version="1.0"?><workbook ${NS} ${RNS}><bookViews><workbookView activeTab="2"/></bookViews>`
      + '<sheets><sheet name="Összesítő" sheetId="1" r:id="rId1"/><sheet name="Adatok 2026" sheetId="2" r:id="rId2"/><sheet name="Jegyzet" sheetId="5" r:id="rId3"/></sheets>'
      + '<definedNames><definedName name="_xlnm.Print_Area" localSheetId="2">Jegyzet!$A$1:$B$2</definedName>'
      + "<definedName name=\"Adat\">'Adatok 2026'!$A$1</definedName></definedNames></workbook>",
    'xl/_rels/workbook.xml.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="ws" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="ws" Target="worksheets/sheet2.xml"/>'
      + '<Relationship Id="rId3" Type="ws" Target="worksheets/sheet3.xml"/></Relationships>',
    'xl/styles.xml': `<?xml version="1.0"?><styleSheet ${NS}><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="0" fontId="1"/></cellXfs></styleSheet>`,
    'xl/worksheets/sheet1.xml': `<?xml version="1.0"?><worksheet ${NS}><dimension ref="A1:B2"/><cols><col min="1" max="1" width="40" customWidth="1"/></cols><sheetData>`
      + '<row r="1" ht="30" customHeight="1"><c r="A1" s="1" t="inlineStr"><is><t>Cím</t></is></c></row>'
      + "<row r=\"2\"><c r=\"A2\"><f>'Adatok 2026'!A1*2</f><v>14</v></c><c r=\"B2\"><f>Jegyzet!A1</f><v>0</v></c></row></sheetData></worksheet>",
    'xl/worksheets/sheet2.xml': `<?xml version="1.0"?><worksheet ${NS}><sheetData><row r="1"><c r="A1"><v>7</v></c></row></sheetData></worksheet>`,
    'xl/worksheets/sheet3.xml': `<?xml version="1.0"?><worksheet ${NS}><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>`,
    'xl/worksheets/_rels/sheet3.xml.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>',
  }
  return buildZip(Object.entries(files).map(([name, data]) => ({ name, data })))
}

const text = (buf: Buffer, name: string): string | null => readZip(buf)?.find((x) => x.name === name)?.data.toString('utf8') ?? null
const opened = () => { const r = readTable(book(), 'k.xlsx'); if (!r.ok) throw new Error('read'); return r.table.sheets.map((s, i) => ({ ...s, from: i as number | null })) }
const save = (sheets: ReturnType<typeof opened>) => { const w = writeTable(book(), 'k.xlsx', sheets); if (!w.ok) throw new Error(w.code + ' ' + (w.detail || '')); return w.data }
const names = (buf: Buffer) => { const r = readTable(buf, 'k.xlsx'); if (!r.ok) throw new Error('reread ' + r.code); return r.table.sheets.map((s) => s.name) }

describe('sheet names', () => {
  it('what Excel refuses is named', () => {
    expect(sheetNameProblem('Munka1')).toBe(null)
    expect(sheetNameProblem('  ')).toBe('empty')
    expect(sheetNameProblem('x'.repeat(32))).toBe('long')
    expect(sheetNameProblem('a/b')).toBe('chars')
    expect(sheetNameProblem("'x")).toBe('quote')
  })

  it('a renamed sheet is followed in formulas, quoted or not, but not inside a text', () => {
    const r = new Map([['Adatok 2026', 'Forrás'], ['Jegyzet', 'Napi jegyzet']])
    // A new name is always written quoted unless it is a plain ASCII word: quoting is valid everywhere.
    expect(renameSheetInFormula("'Adatok 2026'!A1*2", r)).toBe("'Forrás'!A1*2")
    expect(renameSheetInFormula('Összesítő!A1+MásÖsszesítő!A1', new Map([['Összesítő', 'Total']]))).toBe('Total!A1+MásÖsszesítő!A1')
    expect(renameSheetInFormula('SUM(Jegyzet!A1:A3)+Jegyzet!B1', r)).toBe("SUM('Napi jegyzet'!A1:A3)+'Napi jegyzet'!B1")
    expect(renameSheetInFormula('"Jegyzet!A1"&Jegyzet!A1', r)).toBe("\"Jegyzet!A1\"&'Napi jegyzet'!A1")
    expect(renameSheetInFormula('MasJegyzet!A1', r)).toBe('MasJegyzet!A1')
  })
})

describe('saving a changed list of sheets', () => {
  it('nothing changed: no new file', () => {
    expect(writeTable(book(), 'k.xlsx', opened())).toMatchObject({ ok: false, code: 'table_no_change' })
  })

  it('RENAME: the new name is in the file, formulas and names follow it, the formatting of the sheet stays', () => {
    const sh = opened()
    sh[1]!.name = 'Forrás'
    const out = save(sh)
    expect(names(out)).toEqual(['Összesítő', 'Forrás', 'Jegyzet'])
    const s1 = text(out, 'xl/worksheets/sheet1.xml')!
    expect(s1).toContain("<f>'Forrás'!A1*2</f>")
    expect(s1).toContain('<col min="1" max="1" width="40" customWidth="1"/>')
    expect(s1).toContain('ht="30" customHeight="1"')
    expect(s1).toContain('<c r="A1" s="1" t="inlineStr">')
    const wb = text(out, 'xl/workbook.xml')!
    expect(wb).toContain('<sheet name="Forrás" sheetId="2" r:id="rId2"/>')
    expect(wb).toContain("<definedName name=\"Adat\">'Forrás'!$A$1</definedName>")
    expect(wb).toContain('fullCalcOnLoad="1"')
  })

  it('ADD: a new sheet with what was typed, readable again, the others untouched', () => {
    const sh = opened()
    sh.push({ name: 'Új lap', rows: [['Név', 'Összeg'], ['Tégla', '12,5'], ['', '=B2*2']], from: null })
    const out = save(sh)
    expect(names(out)).toEqual(['Összesítő', 'Adatok 2026', 'Jegyzet', 'Új lap'])
    const again = readTable(out, 'k.xlsx')
    if (!again.ok) throw new Error('reread')
    expect(again.table.sheets[3]!.rows).toEqual([['Név', 'Összeg'], ['Tégla', '12.5'], ['', '=B2*2']])
    expect(text(out, 'xl/worksheets/sheet4.xml')).toContain('<sheetData>')
    expect(text(out, 'xl/workbook.xml')).toContain('<sheet name="Új lap" sheetId="6" r:id="rId4"/>')
    expect(text(out, 'xl/_rels/workbook.xml.rels')).toContain('Id="rId4"')
    expect(text(out, '[Content_Types].xml')).toContain('PartName="/xl/worksheets/sheet4.xml"')
    expect(text(out, 'xl/worksheets/sheet2.xml')).toBe(text(book(), 'xl/worksheets/sheet2.xml'))
  })

  it('REMOVE: the sheet, its part, its relationship and the names scoped to it are gone; the tab that was open is reset', () => {
    const sh = opened().filter((_s, i) => i !== 2)
    const out = save(sh)
    expect(names(out)).toEqual(['Összesítő', 'Adatok 2026'])
    expect(text(out, 'xl/worksheets/sheet3.xml')).toBe(null)
    expect(text(out, 'xl/worksheets/_rels/sheet3.xml.rels')).toBe(null)
    expect(text(out, 'xl/_rels/workbook.xml.rels')).not.toContain('rId3')
    expect(text(out, '[Content_Types].xml')).not.toContain('sheet3.xml')
    const wb = text(out, 'xl/workbook.xml')!
    expect(wb).not.toContain('Print_Area')
    expect(wb).toContain('<definedName name="Adat">')
    expect(wb).toContain('activeTab="0"')
  })

  it('REORDER: the order asked for, and a name scoped to a sheet follows its sheet', () => {
    const o = opened()
    const out = save([o[2]!, o[0]!, o[1]!])
    expect(names(out)).toEqual(['Jegyzet', 'Összesítő', 'Adatok 2026'])
    expect(text(out, 'xl/workbook.xml')).toContain('<definedName name="_xlnm.Print_Area" localSheetId="0">')
  })

  it('all at once: one removed, one renamed, one added, and a cell edited on a sheet that stays', () => {
    const o = opened()
    o[0]!.rows[0]![0] = 'Új cím'
    o[1]!.name = 'Forrás'
    const out = save([o[0]!, { name: 'Friss', rows: [['1']], from: null }, o[1]!])
    expect(names(out)).toEqual(['Összesítő', 'Friss', 'Forrás'])
    const s1 = text(out, 'xl/worksheets/sheet1.xml')!
    expect(s1).toContain('Új cím')
    expect(s1).toContain('<c r="A1" s="1"')
    expect(s1).toContain("<f>'Forrás'!A1*2</f>")
  })

  it('a bad or repeated name is refused, with the name, and nothing is written', () => {
    const o = opened()
    expect(writeTable(book(), 'k.xlsx', [{ ...o[0]!, name: 'a:b' }, o[1]!, o[2]!])).toEqual({ ok: false, code: 'table_sheet_name_chars', detail: 'a:b' })
    expect(writeTable(book(), 'k.xlsx', [o[0]!, { ...o[1]!, name: 'ÖSSZESÍTŐ' }, o[2]!])).toMatchObject({ ok: false, code: 'table_sheet_name_twice' })
    expect(writeTable(book(), 'k.xlsx', [o[0]!, { ...o[1]!, name: '' }, o[2]!])).toMatchObject({ ok: false, code: 'table_sheet_name_empty' })
  })

  it('the same opened sheet twice, or one that was never there, is refused', () => {
    const o = opened()
    expect(writeTable(book(), 'k.xlsx', [o[0]!, { ...o[0]!, name: 'Másolat' }])).toMatchObject({ ok: false, code: 'table_sheets_changed' })
    expect(writeTable(book(), 'k.xlsx', [{ ...o[0]!, from: 9 }])).toMatchObject({ ok: false, code: 'table_sheets_changed' })
  })

  it('the old contract (no `from` at all) still refuses a changed list', () => {
    const r = readTable(book(), 'k.xlsx')
    if (!r.ok) throw new Error('read')
    expect(writeTable(book(), 'k.xlsx', r.table.sheets.slice(0, 2))).toMatchObject({ ok: false, code: 'table_sheets_changed' })
  })

  it('`from` survives the input check, and nonsense in it is refused', () => {
    expect(normalizeSheets([{ name: 'a', rows: [['1']], from: 0 }, { name: 'b', rows: [['2']], from: null }])).toMatchObject({ ok: true, sheets: [{ from: 0 }, { from: null }] })
    expect(normalizeSheets([{ name: 'a', rows: [['1']], from: -1 }])).toMatchObject({ ok: false, code: 'table_bad_input' })
    expect(normalizeSheets([{ name: 'a', rows: [['1']], from: 'x' }])).toMatchObject({ ok: false, code: 'table_bad_input' })
  })

  it('a .csv has one sheet: a second one is refused', () => {
    expect(writeTable(Buffer.from('a;b\n1;2\n'), 'k.csv', [{ name: 'k', rows: [['a', 'b']], from: 0 }, { name: 'x', rows: [['1']], from: null }])).toMatchObject({ ok: false, code: 'table_bad_input' })
  })
})
