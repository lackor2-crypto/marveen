// #526, part 2 -- ROWS AND COLUMNS inserted, removed and moved in the middle of an .xlsx.
//
// Owner, 2026-10-09: "sort es oszlopot a tabla kozepere beszurni vagy onnan torolni [...]
// igen persze. csinald ezt is." It was refused because the save patches the file BY
// POSITION: a row inserted in the middle would have shifted the data under the wrong
// formatting. The editor now says where each row and column came from, and the save moves
// the style, the row height, the column width, the merges, the rules and the references
// with it. These tests pin that -- on the file, not on the screen.
import { describe, it, expect } from 'vitest'
import { buildZip } from '../web/zip-writer.js'
import { readTable, writeTable, readZip, axisMap, mapSpan, mapRef, mapFormulaRefs, normalizeSheets, type TableSheet } from '../workbench-table.js'

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
const RNS = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'

/** Sheet 1: a styled header row with a height, a wide column B, a merge, a conditional format,
 *  a validation and a total row with a formula. Sheet 2 points at sheet 1. */
function book(extraSheet1 = ''): Buffer {
  const files: Record<string, string> = {
    '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    'xl/workbook.xml': `<?xml version="1.0"?><workbook ${NS} ${RNS}><sheets><sheet name="Adat" sheetId="1" r:id="rId1"/><sheet name="Össz" sheetId="2" r:id="rId2"/></sheets>`
      + '<definedNames><definedName name="Tartomany">Adat!$B$2:$B$4</definedName><definedName name="_xlnm.Print_Area" localSheetId="0">Adat!$A$1:$C$5</definedName></definedNames></workbook>',
    'xl/_rels/workbook.xml.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="ws" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="ws" Target="worksheets/sheet2.xml"/></Relationships>',
    'xl/styles.xml': `<?xml version="1.0"?><styleSheet ${NS}><cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="0" fontId="1"/><xf numFmtId="0" fillId="2"/></cellXfs></styleSheet>`,
    'xl/worksheets/sheet1.xml': `<?xml version="1.0"?><worksheet ${NS}><dimension ref="A1:C5"/><cols><col min="2" max="2" width="40" customWidth="1"/></cols><sheetData>`
      + '<row r="1" ht="30" customHeight="1"><c r="A1" s="1" t="inlineStr"><is><t>Név</t></is></c><c r="B1" s="1" t="inlineStr"><is><t>Ár</t></is></c><c r="C1" s="1" t="inlineStr"><is><t>Megj</t></is></c></row>'
      + '<row r="2"><c r="A2" t="inlineStr"><is><t>Tégla</t></is></c><c r="B2" s="2"><v>10</v></c></row>'
      + '<row r="3"><c r="A3" t="inlineStr"><is><t>Cement</t></is></c><c r="B3" s="2"><v>20</v></c></row>'
      + '<row r="4"><c r="A4" t="inlineStr"><is><t>Homok</t></is></c><c r="B4" s="2"><v>30</v></c></row>'
      + '<row r="5" ht="22" customHeight="1"><c r="A5" s="1" t="inlineStr"><is><t>Összesen</t></is></c><c r="B5" s="1"><f>SUM(B2:B4)</f><v>60</v></c></row>'
      + '</sheetData><mergeCells count="1"><mergeCell ref="A5:A5"/></mergeCells>'
      + '<conditionalFormatting sqref="B2:B4"><cfRule type="expression" dxfId="0" priority="1"><formula>$B2&gt;15</formula></cfRule></conditionalFormatting>'
      + '<dataValidations count="1"><dataValidation type="whole" sqref="B2:B4"><formula1>0</formula1></dataValidation></dataValidations>'
      + extraSheet1 + '</worksheet>',
    'xl/worksheets/sheet2.xml': `<?xml version="1.0"?><worksheet ${NS}><sheetData><row r="1"><c r="A1"><f>Adat!B5*2</f><v>120</v></c></row></sheetData></worksheet>`,
  }
  return buildZip(Object.entries(files).map(([name, data]) => ({ name, data })))
}

const text = (buf: Buffer, name: string): string => readZip(buf)!.find((x) => x.name === name)!.data.toString('utf8')
const opened = (b = book()): TableSheet[] => { const r = readTable(b, 'k.xlsx'); if (!r.ok) throw new Error('read'); // A client that does not report merges leaves them to the row/column mapping (section B: one
  // that does report them is the truth, see workbench-table-border-merge.test.ts).
  return r.table.sheets.map((s, i) => { const o = { ...s, from: i }; delete o.merges; return o }) }
const save = (sheets: TableSheet[], b = book()) => { const w = writeTable(b, 'k.xlsx', sheets); if (!w.ok) throw new Error(w.code + ' ' + (w.detail || '')); return w.data }

describe('where a row went', () => {
  it('an identity map is recognised, also when rows were typed past the end', () => {
    expect(axisMap(undefined, 5).identity).toBe(true)
    expect(axisMap([0, 1, 2, 3, 4], 5).identity).toBe(true)
    expect(axisMap([0, 1, 2, 3, 4, null, null], 5).identity).toBe(true)
    // a map that was sent and misses the last originals: those rows were removed
    expect(axisMap([0, 1, 2], 5).identity).toBe(false)
    expect(axisMap([0, null, 1, 2, 3, 4], 5).identity).toBe(false)
    expect(axisMap([0, 2, 3, 4], 5).identity).toBe(false)
  })

  it('a span follows its rows: an insert inside widens it, a removal narrows it, all removed is gone', () => {
    const ins = axisMap([0, 1, null, 2, 3, 4], 5)
    expect(mapSpan(ins, 1, 3)).toEqual([1, 4])
    expect(mapSpan(ins, 2, 2)).toEqual([3, 3])
    expect(mapSpan(ins, 10, 12)).toEqual([11, 13])
    const del = axisMap([0, 1, 3, 4], 5)
    expect(mapSpan(del, 1, 3)).toEqual([1, 2])
    expect(mapSpan(del, 2, 2)).toBe(null)
    expect(mapSpan(del, 10, 12)).toEqual([9, 11])
  })

  it('a tag that turns up twice counts once: the second is a new row', () => {
    const m = axisMap([0, 1, 1, 2], 3)
    expect(m.from).toEqual([0, 1, null, 2])
  })

  it('references move in every spelling, and a removed cell is #REF!', () => {
    const maps = { rows: axisMap([0, 1, null, 2, 3, 4], 5), cols: axisMap(undefined, 3) }
    expect(mapRef('B3', maps)).toBe('B4')
    expect(mapRef('$B$2:$B$4', maps)).toBe('$B$2:$B$5')
    expect(mapRef('B:B', maps)).toBe('B:B')
    expect(mapRef('3:4', maps)).toBe('4:5')
    const of = (n: string) => (n === 'Adat' ? maps : null)
    expect(mapFormulaRefs('SUM(B2:B4)+Adat!B3+Másik!B3', 'Adat', of)).toBe('SUM(B2:B5)+Adat!B4+Másik!B3')
    expect(mapFormulaRefs('"B3"&B3', 'Adat', of)).toBe('"B3"&B4')
    expect(mapFormulaRefs('LOG10(B3)', 'Adat', of)).toBe('LOG10(B4)')
    const del = { rows: axisMap([0, 1, 3, 4], 5), cols: axisMap(undefined, 3) }
    expect(mapFormulaRefs('B3+B4', 'Adat', () => del)).toBe('#REF!+B3')
  })
})

describe('a row inserted in the middle of an .xlsx', () => {
  // What the editor sends after "insert a row above Cement": the grid with the new row, the
  // formulas already moved by the editor, and where each row came from.
  const inserted = (): TableSheet[] => {
    const o = opened()
    const rows = o[0]!.rows
    return [
      { ...o[0]!, rows: [rows[0]!, rows[1]!, ['Kavics', '15', ''], rows[2]!, rows[3]!, ['Összesen', '=SUM(B2:B5)', '']], rowsFrom: [0, 1, null, 2, 3, 4] },
      { ...o[1]!, rows: [['=Adat!B6*2']] },
    ]
  }

  it('every row keeps ITS formatting, at its new place', () => {
    const s1 = text(save(inserted()), 'xl/worksheets/sheet1.xml')
    // the styled header and the total row with its own height, one row lower
    expect(s1).toContain('<row r="1" ht="30" customHeight="1">')
    expect(s1).toContain('<row r="6" ht="22" customHeight="1">')
    expect(s1).toContain('<c r="A6" s="1"')
    expect(s1).toContain('<c r="B6" s="1"><f>SUM(B2:B5)</f></c>')
    // the data cells kept their fill style (s="2") after moving down
    expect(s1).toContain('<c r="B4" s="2"><v>20</v></c>')
    expect(s1).toContain('<c r="B5" s="2"><v>30</v></c>')
    // the new row is there, without a borrowed style
    expect(s1).toContain('<c r="B3"><v>15</v></c>')
    expect(s1).not.toMatch(/<row r="3"[^>]*ht=/)
  })

  it('the merge, the rule, the validation and the print area move with the rows', () => {
    const out = save(inserted())
    const s1 = text(out, 'xl/worksheets/sheet1.xml')
    expect(s1).toContain('<mergeCell ref="A6:A6"/>')
    expect(s1).toContain('<conditionalFormatting sqref="B2:B5">')
    expect(s1).toContain('<dataValidation type="whole" sqref="B2:B5">')
    expect(s1).toContain('<dimension ref="A1:C6"/>')
    const wb = text(out, 'xl/workbook.xml')
    expect(wb).toContain('<definedName name="Tartomany">Adat!$B$2:$B$5</definedName>')
    expect(wb).toContain('<definedName name="_xlnm.Print_Area" localSheetId="0">Adat!$A$1:$C$6</definedName>')
  })

  it('the other sheet points at the moved cell, and the file reads back as it was sent', () => {
    const out = save(inserted())
    expect(text(out, 'xl/worksheets/sheet2.xml')).toContain('<f>Adat!B6*2</f>')
    const again = readTable(out, 'k.xlsx')
    if (!again.ok) throw new Error('reread')
    expect(again.table.sheets[0]!.rows.map((r) => r[0])).toEqual(['Név', 'Tégla', 'Kavics', 'Cement', 'Homok', 'Összesen'])
    expect(again.table.sheets[0]!.rows[5]![1]).toBe('=SUM(B2:B5)')
  })
})

describe('a row removed, a column inserted, a row moved', () => {
  it('REMOVE a row: the rows below come up with their formatting, the rule narrows', () => {
    const o = opened()
    const rows = o[0]!.rows
    const out = save([{ ...o[0]!, rows: [rows[0]!, rows[1]!, rows[3]!, ['Összesen', '=SUM(B2:B3)', '']], rowsFrom: [0, 1, 3, 4] }, { ...o[1]!, rows: [['=Adat!B4*2']] }])
    const s1 = text(out, 'xl/worksheets/sheet1.xml')
    expect(s1).toContain('<c r="B3" s="2"><v>30</v></c>')
    expect(s1).toContain('<row r="4" ht="22" customHeight="1">')
    expect(s1).toContain('<mergeCell ref="A4:A4"/>')
    expect(s1).toContain('<conditionalFormatting sqref="B2:B3">')
    expect(s1).not.toContain('Cement')
  })

  it('REMOVE the LAST row: what was bound to it goes with it, and a reference to it is said to be gone', () => {
    const o = opened()
    const rows = o[0]!.rows
    const out = save([{ ...o[0]!, rows: rows.slice(0, 4), rowsFrom: [0, 1, 2, 3], colsFrom: [0, 1, 2] }, { ...o[1]!, rows: [['=#REF!*2']] }])
    const s1 = text(out, 'xl/worksheets/sheet1.xml')
    expect(s1).not.toContain('mergeCell')
    expect(s1).not.toContain('Összesen')
    expect(s1).toContain('<conditionalFormatting sqref="B2:B4">')
    expect(text(out, 'xl/workbook.xml')).toContain('<definedName name="_xlnm.Print_Area" localSheetId="0">Adat!$A$1:$C$4</definedName>')
  })

  it('a last row that was only EMPTIED is not a removed row: its tag is still there', () => {
    const o = opened()
    const rows = o[0]!.rows
    // the editor sends the grid up to the last filled row, but the tags of all five rows
    const out = save([{ ...o[0]!, rows: rows.slice(0, 4), rowsFrom: [0, 1, 2, 3, 4], colsFrom: [0, 1, 2] }, o[1]!])
    expect(text(out, 'xl/worksheets/sheet1.xml')).toContain('<mergeCell ref="A5:A5"/>')
  })

  it('INSERT a column: the wide column and the styles move right with their data', () => {
    const o = opened()
    const rows = o[0]!.rows.map((r, i) => [r[0]!, i === 0 ? 'Db' : '', r[1]!, r[2] ?? ''])
    rows[4] = ['Összesen', '', '=SUM(C2:C4)', '']
    const out = save([{ ...o[0]!, rows, colsFrom: [0, null, 1, 2] }, { ...o[1]!, rows: [['=Adat!C5*2']] }])
    const s1 = text(out, 'xl/worksheets/sheet1.xml')
    expect(s1).toContain('<col min="3" max="3" width="40" customWidth="1"/>')
    expect(s1).toContain('<c r="C2" s="2"><v>10</v></c>')
    expect(s1).toContain('<c r="C1" s="1"')
    expect(s1).toContain('<conditionalFormatting sqref="C2:C4">')
    expect(s1).toContain('<formula>$C2&gt;15</formula>')
    expect(text(out, 'xl/workbook.xml')).toContain('<definedName name="Tartomany">Adat!$C$2:$C$4</definedName>')
  })

  it('MOVE a row: the row carries its style and height to where it was put', () => {
    const o = opened()
    const rows = o[0]!.rows
    const out = save([{ ...o[0]!, rows: [rows[0]!, rows[3]!, rows[1]!, rows[2]!, rows[4]!], rowsFrom: [0, 3, 1, 2, 4] }, o[1]!])
    const s1 = text(out, 'xl/worksheets/sheet1.xml')
    expect(s1).toContain('<c r="B2" s="2"><v>30</v></c>')
    expect(s1).toContain('<c r="B3" s="2"><v>10</v></c>')
    expect(s1).toContain('<row r="5" ht="22" customHeight="1">')
  })
})

describe('what the save does NOT follow is refused, said out loud', () => {
  it('a sheet with a picture or a table object is marked when opened, and a structural save is refused', () => {
    const b = book('<drawing r:id="rId1"/>')
    const r = readTable(b, 'k.xlsx')
    if (!r.ok) throw new Error('read')
    expect(r.table.sheets[0]!.structure_locked).toBe(true)
    expect(r.table.sheets[1]!.structure_locked).toBeUndefined()
    const o = opened(b)
    const rows = o[0]!.rows
    expect(writeTable(b, 'k.xlsx', [{ ...o[0]!, rows: [rows[0]!, ['', '', ''], ...rows.slice(1)], rowsFrom: [0, null, 1, 2, 3, 4] }, o[1]!]))
      .toEqual({ ok: false, code: 'table_structure_objects', detail: 'Adat' })
    // typing into such a sheet still saves
    const typed = opened(b)
    typed[0]!.rows[1]![0] = 'Beton'
    expect(writeTable(b, 'k.xlsx', typed).ok).toBe(true)
  })

  it('nothing moved: the file is patched exactly as before', () => {
    const o = opened()
    o[0]!.rowsFrom = [0, 1, 2, 3, 4]
    o[0]!.colsFrom = [0, 1, 2]
    expect(writeTable(book(), 'k.xlsx', o)).toMatchObject({ ok: false, code: 'table_no_change' })
    o[0]!.rows[1]![0] = 'Beton'
    const s1 = text(save(o), 'xl/worksheets/sheet1.xml')
    expect(s1).toContain('<row r="1" ht="30" customHeight="1"><c r="A1" s="1" t="inlineStr"><is><t>Név</t></is></c>')
    expect(s1).toContain('<f>SUM(B2:B4)</f>')
  })

  it('the maps survive the input check, nonsense in them is refused', () => {
    expect(normalizeSheets([{ name: 'a', rows: [['1'], ['2']], from: 0, rowsFrom: [0, null], colsFrom: [0] }])).toMatchObject({ ok: true, sheets: [{ rowsFrom: [0, null], colsFrom: [0] }] })
    expect(normalizeSheets([{ name: 'a', rows: [['1']], from: 0, rowsFrom: [-1] }])).toMatchObject({ ok: false, code: 'table_bad_input' })
    expect(normalizeSheets([{ name: 'a', rows: [['1']], from: 0, colsFrom: 'x' }])).toMatchObject({ ok: false, code: 'table_bad_input' })
  })
})
