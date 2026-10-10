// Kanban #504: the pure rules of the Workbench Univer grid (tools/univer-build/rules.mjs).
// The grid itself is a vendored browser bundle; what it may offer and what a save sends
// is decided here, so it is checked here.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  blockedKind, hiddenMenuConfig, FORMAT_KEPT_MENU_IDS, styleToUniver, univerToStyle, hexColor, HIDDEN_MENU_IDS, deepMerge, cellFromText, cellPattern, isDatePattern, serialToIso, isoToSerial as clientIsoToSerial, textFromCell,
  freezeCount, freezeConfig, freezeCounts, FREEZE_MAX_ROWS, FREEZE_MAX_COLS,
} from '../../tools/univer-build/rules.mjs'
import { serialToIso as serverSerialToIso, isoToSerial, readTable, writeTable } from '../workbench-table.js'
import { buildZip } from '../web/zip-writer.js'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

describe('blockedKind: amit a mentes nem tud megtartani, azt a racs nem engedi', () => {
  it('a formazas mindenhol tiltott: eszkoztar, gyorsbillentyu, formatum-masolo, formazas torlese, szamformatum, egyesites, vedelem', () => {
    for (const id of [
      'sheet.command.set-range-bold', 'sheet.command.set-range-italic', 'sheet.command.set-style', 'sheet.command.set-background-color',
      'sheet.command.set-border-basic', 'sheet.command.set-horizontal-text-align', 'sheet.command.add-worksheet-merge-all',
      'sheet.command.numfmt.set.percent', 'sheet.operation.open.numfmt.panel', 'sheet.command.apply-format-painter',
      'ui.operation.activate-format-painter', 'ui.command.clear-formatting', 'sheet.command.clear-selection-format',
      'sheet.command.add-range-protection-from-context-menu', 'sheet.command.set-tab-color', 'sheet.command.set-rows-hidden',
    ]) {
      expect(blockedKind(id, false), id).toBe('format')
      expect(blockedKind(id, true), id).toBe('format')
    }
  })

  it('a tartalom-szerkesztes szabad: gepeles, kitoltes, masolas, beillesztes, tartalom torlese', () => {
    for (const id of [
      'sheet.command.set-range-values', 'sheet.command.auto-fill', 'sheet.command.copy', 'sheet.command.cut', 'sheet.command.paste',
      'sheet.command.copy-down', 'sheet.command.clear-selection-content', 'univer.command.undo', 'ui.operation.cancel-format-painter',
      'sheet.command.toggle-gridlines', 'sheet.command.set-stylex', '',
    ]) {
      expect(blockedKind(id, true), id).toBe(null)
    }
  })

  it('kozepre sor/oszlop csak Excel-fajlban tiltott; munkalap-muvelet csak ott, ahol egy lap lehet (.csv) -- #526', () => {
    // #526, part 2: whole rows and columns are allowed in an .xlsx ...
    for (const id of ['sheet.command.insert-row-before', 'sheet.command.insert-col-after', 'sheet.command.remove-row', 'sheet.command.remove-col', 'sheet.command.move-rows', 'sheet.command.move-cols']) {
      expect(blockedKind(id, true, false, false), id).toBe(null)
      // ... unless the sheet holds objects placed by position
      expect(blockedKind(id, true, false, true), id).toBe('objects')
      // a .csv has no formatting to lose: never locked
      expect(blockedKind(id, false, true, true), id).toBe(null)
    }
    // shifting cells stays refused in an .xlsx (the cells move without their rows)
    for (const id of ['sheet.command.insert-range-move-down', 'sheet.command.insert-range-move-right', 'sheet.command.delete-range-move-up', 'sheet.command.delete-range-move-left']) {
      expect(blockedKind(id, true, false, false), id).toBe('structure')
      expect(blockedKind(id, false, true, false), id).toBe(null)
    }
    for (const id of ['sheet.command.insert-sheet', 'sheet.command.remove-sheet', 'sheet.command.set-worksheet-name', 'sheet.command.set-worksheet-order']) {
      // .xlsx (sheets not locked): adding, removing, renaming and reordering is allowed
      expect(blockedKind(id, true, false), id).toBe(null)
      // .csv (sheets locked): all of it is refused
      expect(blockedKind(id, false, true), id).toBe('sheet')
    }
    // Copying a sheet is refused everywhere: the copy would lose the formatting.
    expect(blockedKind('sheet.command.copy-sheet', true, false)).toBe('sheetcopy')
    expect(blockedKind('sheet.command.copy-sheet', false, true)).toBe('sheet')
  })

  it('a tiltott parancsok menupontjai rejtettek, a tartalom-szerkeszteseke nem', () => {
    const cfg = hiddenMenuConfig()
    expect(Object.keys(cfg).length).toBe(HIDDEN_MENU_IDS.length)
    // #526: rename and remove are offered on the sheet tab of an .xlsx, hidden for a .csv; copy is hidden always
    expect(cfg['sheet.operation.rename-sheet']).toBeUndefined()
    expect(cfg['sheet.command.remove-sheet-confirm']).toBeUndefined()
    expect(cfg['sheet.command.copy-sheet']).toEqual({ hidden: true })
    const csv = hiddenMenuConfig(true)
    expect(csv['sheet.operation.rename-sheet']).toEqual({ hidden: true })
    expect(csv['sheet.command.remove-sheet-confirm']).toEqual({ hidden: true })
    for (const v of Object.values(cfg)) expect(v).toEqual({ hidden: true })
    for (const id of ['ui.operation.activate-format-painter', 'ui.command.clear-formatting', 'sheet.command.set-range-bold', 'sheet.contextMenu.permission']) {
      expect(cfg[id], id).toEqual({ hidden: true })
    }
    for (const id of HIDDEN_MENU_IDS) expect(['sheet.command.set-range-values', 'sheet.command.paste', 'sheet.command.copy']).not.toContain(id)
  })
})

describe('textFromCell: egy cella mentett szovege', () => {
  it('a kitoltott/lemasolt (kozos) keplet cellankent a feloldott kepletkent megy, nem az eredmenyekent', () => {
    expect(textFromCell({ si: 'abc', v: 6, t: 2 }, '', '=C5*2')).toBe('=C5*2')
    expect(textFromCell({ si: 'abc', v: 6, t: 2 }, '', 'C5*2')).toBe('=C5*2')
    expect(textFromCell({ f: 'SUM(A1:A2)', v: 30 }, '', '')).toBe('=SUM(A1:A2)')
  })

  it('a begepelt datum EEEE-HH-NN alakban megy (ahogy a szerver kuldi es varja), nem napszamkent', () => {
    expect(textFromCell({ v: 46291, t: 2 }, 'yyyy-mm-dd', '')).toBe('2026-09-26')
    expect(textFromCell({ v: 46291.5, t: 2 }, 'yyyy-mm-dd hh:mm', '')).toBe('2026-09-26 12:00')
    expect(isoToSerial(textFromCell({ v: 46291, t: 2 }, 'yyyy.mm.dd', ''))).toBe(46291)
  })

  it('a begepelt szazalek szazalekkent megy, lebegopontos zaj nelkul', () => {
    expect(textFromCell({ v: 0.1, t: 2 }, '0%', '')).toBe('10%')
    expect(textFromCell({ v: 0.07, t: 2 }, '0.00%', '')).toBe('7%')
    expect(textFromCell({ v: 0.075, t: 2 }, '0.0%', '')).toBe('7.5%')
  })

  it('formatum nelkul a nyers ertek; idezett szoveg a formatumban nem datum', () => {
    expect(textFromCell({ v: 0.1, t: 2 }, '', '')).toBe('0.1')
    expect(textFromCell({ v: 1500, t: 2 }, '#,##0" Ft"', '')).toBe('1500')
    expect(textFromCell({ v: 'Tégla', t: 1 }, '', '')).toBe('Tégla')
    expect(textFromCell({ v: true }, '', '')).toBe('TRUE')
    expect(textFromCell({ v: 0, t: 3 }, '', '')).toBe('FALSE')
    expect(textFromCell({ p: { body: { dataStream: 'két\r\nsor\r\n' } } }, '', '')).toBe('két\nsor')
    expect(textFromCell(null, '', '')).toBe('')
  })

  it('a cella formatuma helyben vagy stilus-azonositoval all', () => {
    expect(cellPattern({ v: 1, s: { n: { pattern: '0%' } } }, {})).toBe('0%')
    expect(cellPattern({ v: 1, s: 'st1' }, { st1: { n: { pattern: 'yyyy-mm-dd' } } })).toBe('yyyy-mm-dd')
    expect(cellPattern({ v: 1, s: 'nincs' }, {})).toBe('')
    expect(cellPattern({ v: 1 }, {})).toBe('')
  })

  it('a datum-felismeres es a napszam-atvaltas ugyanaz, mint a szerveren', () => {
    expect(isDatePattern('yyyy-mm-dd')).toBe(true)
    expect(isDatePattern('[$-40E]yyyy. mmmm d.')).toBe(true)
    expect(isDatePattern('0.00%')).toBe(false)
    expect(isDatePattern('#,##0.00')).toBe(false)
    for (const n of [1, 25569, 46291, 46291.25, 2958465]) expect(serialToIso(n), String(n)).toBe(serverSerialToIso(n))
  })
})

describe('betoltes es nyelv', () => {
  it('cellFromText: keplet, szam, szoveg (a vezeto nulla szoveg marad)', () => {
    expect(cellFromText('=SUM(A1:A2)')).toEqual({ f: '=SUM(A1:A2)' })
    expect(cellFromText('10')).toEqual({ v: 10, t: 2 })
    expect(cellFromText('007')).toEqual({ v: '007', t: 1 })
    expect(cellFromText('')).toBe(null)
  })

  it('deepMerge: a forditatlan kulcs angolul marad, a tomb csereje teljes', () => {
    const out = deepMerge({ a: { b: 'B', c: 'C' }, l: [{ title: 'Instruction', url: 'u' }] }, { a: { b: 'Bé' }, l: [{ title: 'Útmutató', url: 'u' }] })
    expect(out).toEqual({ a: { b: 'Bé', c: 'C' }, l: [{ title: 'Útmutató', url: 'u' }] })
  })

  it('a magyar nyelvi csomagban benne van a fuggvenysugo (leiras, rovid leiras, parameterek)', () => {
    const hu = JSON.parse(readFileSync(join(REPO, 'tools', 'univer-build', 'hu-HU.json'), 'utf8'))
    const fl = hu['engine-formula'].functionList as Record<string, { description: string; abstract: string; links?: { title: string }[]; functionParameter: Record<string, { name: string; detail: string }> }>
    expect(Object.keys(fl).length).toBeGreaterThanOrEqual(500)
    expect(fl.SUM!.abstract).toBe('Összeadja az argumentumait')
    for (const [name, f] of Object.entries(fl)) {
      expect(f.description && f.abstract, name).toBeTruthy()
      for (const l of f.links || []) expect(l.title, name).toBe('Útmutató')
      for (const [pk, p] of Object.entries(f.functionParameter)) expect(p.name, name + '.' + pk).toBeTruthy()
    }
  })
})

describe('#526 section A: the formatting a save keeps', () => {
  const KEPT = ['set-range-bold', 'set-range-italic', 'set-range-underline', 'set-range-stroke', 'set-range-font-family',
    'set-range-fontsize', 'set-range-font-increase', 'set-range-font-decrease', 'set-range-text-color', 'reset-text-color', 'reset-range-text-color',
    'set-background-color', 'reset-background-color', 'set-horizontal-text-align', 'set-vertical-text-align', 'set-text-wrap', 'set-style',
    // section B
    'set-border', 'set-border-basic', 'set-border-color', 'set-border-style', 'set-border-position', 'add-worksheet-merge',
    'add-worksheet-merge-all', 'add-worksheet-merge-vertical', 'add-worksheet-merge-horizontal', 'remove-worksheet-merge',
    // section C
    'numfmt.set.numfmt', 'numfmt.set.percent', 'numfmt.set.currency', 'numfmt.add.decimal.command', 'numfmt.subtract.decimal.command']
  const STILL = ['paste-besides-border', 'set-range-subscript', 'set-text-rotation', 'set-shrink-to-fit',
    'mobile.numfmt.set.numfmt', 'numfmt.set.other', 'paste-format', 'clear-selection-format', 'set-once-format-painter', 'set-worksheet-hidden', 'set-tab-color',
    'add-range-protection', 'hide-row-confirm']

  it('is allowed in an .xlsx whose stylesheet is usable, blocked everywhere else', () => {
    for (const c of KEPT) {
      expect(blockedKind('sheet.command.' + c, true, false, false, true), c).toBe(null)
      expect(blockedKind('sheet.command.' + c, true, false, false, false), c).toBe('format')
      expect(blockedKind('sheet.command.' + c, false, true, false), c).toBe('format')
    }
  })

  it('what cannot be kept stays blocked even where the rest is allowed', () => {
    for (const c of STILL) expect(blockedKind('sheet.command.' + c, true, false, false, true), c).toBe('format')
  })

  it('the buttons of the kept commands are shown only where a save keeps them', () => {
    const on = hiddenMenuConfig(false, true)
    const off = hiddenMenuConfig(false, false)
    for (const id of FORMAT_KEPT_MENU_IDS) { expect(on[id], id).toBeUndefined(); expect(off[id], id).toEqual({ hidden: true }) }
    for (const id of ['sheet.command.paste-besides-border', 'sheet.command.set-once-format-painter']) expect(on[id]).toEqual({ hidden: true })
    // section C: the number format buttons and the panel
    for (const id of ['sheet.operation.open.numfmt.panel', 'sheet.command.numfmt.set.percent', 'sheet.command.numfmt.add.decimal.command']) {
      expect(on[id], id).toBeUndefined()
      expect(off[id], id).toEqual({ hidden: true })
    }
    expect(blockedKind('sheet.operation.open.numfmt.panel', true, false, false, true)).toBe(null)
    expect(blockedKind('sheet.operation.open.numfmt.panel', true, false, false, false)).toBe('format')
    for (const id of ['sheet.command.set-border-basic', 'sheet.command.add-worksheet-merge', 'sheet.command.remove-worksheet-merge']) {
      expect(on[id], id).toBeUndefined()
      expect(off[id], id).toEqual({ hidden: true })
    }
  })

  it('a cell format goes to Univer and back unchanged', () => {
    const cs = { b: true, i: true, u: true, s: true, fs: 14, ff: 'Arial', fc: '#FF0000', bg: '#FFFF00', ha: 'c' as const, va: 'm' as const, wr: true }
    expect(univerToStyle(styleToUniver(cs))).toEqual(cs)
    expect(styleToUniver({})).toEqual({})
    expect(univerToStyle({ n: { pattern: '0%' } })).toEqual({ nf: '0%' })
  })

  it('borders go to Univer and back; black is the colour of a line without one', () => {
    const bd = { t: { s: 'thin' as const }, b: { s: 'double' as const, c: '#FF0000' }, l: { s: 'thick' as const } }
    const u = styleToUniver({ bd }) as { bd: Record<string, { s: number; cl: { rgb: string } }> }
    expect(u.bd.t).toEqual({ s: 1, cl: { rgb: '#000000' } })
    expect(u.bd.b).toEqual({ s: 7, cl: { rgb: '#FF0000' } })
    expect(u.bd.l.s).toBe(13)
    expect(u.bd.r).toBeUndefined()
    expect(univerToStyle(u)).toEqual({ bd })
    expect(univerToStyle({ bd: { t: { s: 0 } } })).toEqual({})
  })

  it('colours of any shape Univer holds come out as #RRGGBB', () => {
    expect(hexColor('rgb(255, 0, 16)')).toBe('#FF0010')
    expect(hexColor({ rgb: '#abc' })).toBe('#AABBCC')
    expect(hexColor('red')).toBe('')
  })
})

describe('number format (section C)', () => {
  it('a format code travels as the Univer pattern and back; General is nothing', () => {
    expect(styleToUniver({ nf: '0.00%' }).n).toEqual({ pattern: '0.00%' })
    expect(styleToUniver({ nf: 'General' }).n).toBeUndefined()
    expect(univerToStyle({ n: { pattern: '#,##0.00' } }).nf).toBe('#,##0.00')
    expect(univerToStyle({ n: { pattern: 'General' } }).nf).toBeUndefined()
    expect(univerToStyle({ n: { pattern: '' } }).nf).toBeUndefined()
  })

  it('where the format is kept a percent goes back as the number, a date as ISO text', () => {
    expect(textFromCell({ v: 0.1, t: 2 }, '0%', '', true)).toBe('0.1')
    expect(textFromCell({ v: 0.1, t: 2 }, '0%', '', false)).toBe('10%')
    expect(textFromCell({ v: 45356, t: 2 }, 'yyyy-mm-dd', '', true)).toBe('2024-03-05')
    expect(textFromCell({ v: 1234.5, t: 2 }, '#,##0.00', '', true)).toBe('1234.5')
  })

  it('isoToSerial is the server inverse of the ISO text', () => {
    expect(clientIsoToSerial('2024-03-05')).toBe(45356)
    expect(clientIsoToSerial('2024-03-05 12:00')).toBe(45356.5)
    expect(serialToIso(clientIsoToSerial('2024-03-05 13:30'))).toBe('2024-03-05 13:30')
    expect(clientIsoToSerial('2024-02-31')).toBe(null)
    expect(clientIsoToSerial('szoveg')).toBe(null)
  })
})

// #557 (owner TG 8817): a colour that was set can be taken back. The "Reset" row of the text colour
// panel runs `sheet.command.reset-range-text-color` (measured in the grid: it calls set-text-color with
// the grid's default text colour underneath); the blocked list only knew `reset-text-color`, a command
// without a button, so the reset answered "this formatting cannot be saved" on a coloured cell.
describe('#557: colours, borders and freezing can be put back', () => {
  const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
  const RNS = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
  const STYLES = `<?xml version="1.0"?><styleSheet ${NS}>`
    + '<fonts count="2"><font><sz val="11"/><color theme="1"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFF0000"/><name val="Calibri"/></font></fonts>'
    + '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>'
    + '<fill><patternFill patternType="solid"><fgColor rgb="FFFFFF00"/><bgColor indexed="64"/></patternFill></fill></fills>'
    + '<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>'
    + '<border><left style="thin"><color rgb="FF000000"/></left><right style="thin"><color rgb="FF000000"/></right><top style="thin"><color rgb="FF000000"/></top><bottom style="thin"><color rgb="FF000000"/></bottom><diagonal/></border></borders>'
    + '<cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>'
    + '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" applyFont="1" applyFill="1" applyBorder="1"/>'
    + '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" applyFont="1"/>'
    + '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" applyBorder="1"/></cellXfs></styleSheet>'
  const book = (): Buffer => {
    const files: Record<string, string> = {
      '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/worksheets/sheet1.xml" ContentType="ws"/></Types>',
      'xl/workbook.xml': `<?xml version="1.0"?><workbook ${NS} ${RNS}><sheets><sheet name="Lap1" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      'xl/_rels/workbook.xml.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="ws" Target="worksheets/sheet1.xml"/></Relationships>',
      'xl/styles.xml': STYLES,
      'xl/worksheets/sheet1.xml': `<?xml version="1.0"?><worksheet ${NS}><dimension ref="A1:C1"/><sheetData>`
        + '<row r="1"><c r="A1" s="1" t="inlineStr"><is><t>mind</t></is></c><c r="B1" s="2" t="inlineStr"><is><t>piros</t></is></c><c r="C1" s="3" t="inlineStr"><is><t>keret</t></is></c></row>'
        + '</sheetData></worksheet>',
    }
    return buildZip(Object.entries(files).map(([name, data]) => ({ name, data })))
  }
  // The cell as the editor holds it after the file was read: the file's own style, in Univer terms.
  const styleAt = (r: ReturnType<typeof readTable>, col: number) => {
    if (!r.ok) throw new Error(r.code)
    const sh = r.table.sheets[0]!
    const e = (sh.cellStyles || []).find((x) => x[0] === 0 && x[1] === col)
    return e ? r.table.styleTable![String(e[2])]! : {}
  }

  it('the colour and border reset commands are kept in an .xlsx and blocked where nothing is kept', () => {
    for (const id of ['sheet.command.reset-range-text-color', 'sheet.command.reset-text-color', 'sheet.command.reset-background-color']) {
      expect(blockedKind(id, true, false, false, true), id).toBe(null)
      expect(blockedKind(id, false, true, false, false), id).toBe('format')
    }
    // no border: the panel's "none" runs the very command that sets one
    expect(blockedKind('sheet.command.set-border-basic', true, false, false, true)).toBe(null)
    expect(blockedKind('sheet.command.set-border', true, false, false, true)).toBe(null)
    // freezing is not a format at all: never blocked
    for (const id of ['sheet.command.set-frozen', 'sheet.command.cancel-frozen', 'sheet.command.set-selection-frozen']) expect(blockedKind(id, true, false, false, true), id).toBe(null)
  })

  it('the text colour reset button is the real command id, shown where a save keeps it', () => {
    expect(HIDDEN_MENU_IDS).toContain('sheet.command.reset-range-text-color')
    expect(FORMAT_KEPT_MENU_IDS).toContain('sheet.command.reset-range-text-color')
    expect(hiddenMenuConfig(false, true)['sheet.command.reset-range-text-color']).toBeUndefined()
    expect(hiddenMenuConfig(false, false)['sheet.command.reset-range-text-color']).toEqual({ hidden: true })
  })

  it('a reset text colour and fill, and a removed border, are gone from the saved file too', () => {
    const src = book()
    const r = readTable(src, 'a.xlsx')
    expect(styleAt(r, 0)).toMatchObject({ b: true, fc: '#FF0000', bg: '#FFFF00', bd: { t: { s: 'thin' } } })
    // Univer after "Reset" on A1: text colour = its default (set-text-color with gray.900), fill = null, borders = none
    const afterReset = { ...styleToUniver(styleAt(r, 0)), cl: { rgb: '#1B1C1F' }, bg: { rgb: null }, bd: undefined }
    const fmt: [number, number, ReturnType<typeof univerToStyle>][] = [
      [0, 0, univerToStyle(afterReset)],
      // B1 had a red font: its text colour reset only
      [0, 1, univerToStyle({ ...styleToUniver(styleAt(r, 1)), cl: { rgb: '#1B1C1F' } })],
      // C1 had a border: "no border" only
      [0, 2, univerToStyle({ ...styleToUniver(styleAt(r, 2)), bd: { t: null, r: null, b: null, l: null } })],
    ]
    expect(fmt[0]![2].fc).toBeUndefined()
    expect(fmt[0]![2].bg).toBeUndefined()
    expect(fmt[0]![2].bd).toBeUndefined()
    const sh = r.ok ? { ...r.table.sheets[0]!, fmt } : null
    const out = writeTable(src, 'a.xlsx', [sh as never])
    if (!out.ok) throw new Error(out.code)
    const back = readTable(out.data, 'a.xlsx')
    // Read back from the saved file: the cell is at its default again, the rest of its look stays.
    expect(styleAt(back, 0).fc).toBeUndefined()
    expect(styleAt(back, 0).bg).toBeUndefined()
    expect(styleAt(back, 0).bd).toBeUndefined()
    expect(styleAt(back, 0).b).toBe(true)
    expect(styleAt(back, 1).fc).toBeUndefined()
    expect(styleAt(back, 1).b).toBe(true)
    expect(styleAt(back, 2).bd).toBeUndefined()
  })

  it('freezing: two typed values, 0 / 0 lifts it, junk is 0, too big is the limit', () => {
    expect(freezeConfig(2, 1)).toEqual({ startRow: 2, startColumn: 1, ySplit: 2, xSplit: 1 })
    expect(freezeConfig(0, 0)).toEqual({ startRow: -1, startColumn: -1, ySplit: 0, xSplit: 0 })
    expect(freezeConfig(3, 0)).toEqual({ startRow: 3, startColumn: -1, ySplit: 3, xSplit: 0 })
    expect(freezeCounts(freezeConfig(2, 1))).toEqual({ rows: 2, cols: 1 })
    expect(freezeCounts({ startRow: -1, startColumn: -1, ySplit: 0, xSplit: 0 })).toEqual({ rows: 0, cols: 0 })
    expect(freezeCounts(null)).toEqual({ rows: 0, cols: 0 })
    expect(freezeCount('2', 100)).toBe(2)
    expect(freezeCount(' 3 ', 100)).toBe(3)
    expect(freezeCount('2,7', 100)).toBe(2)
    expect(freezeCount('-4', 100)).toBe(0)
    expect(freezeCount('abc', 100)).toBe(0)
    expect(freezeCount('', 100)).toBe(0)
    expect(freezeCount('99999', 99)).toBe(99)
    expect(FREEZE_MAX_ROWS).toBeGreaterThan(0)
    expect(FREEZE_MAX_COLS).toBeGreaterThan(0)
  })

  it('the grid shows the two freeze boxes and the "no border" button with words from the page (HU + EN)', () => {
    const entry = readFileSync(join(REPO, 'tools', 'univer-build', 'entry.js'), 'utf8')
    expect(entry).toContain('sheet.toolbar.sheet-frozen')
    expect(entry).toContain('data-mv-freeze')
    expect(entry).toContain('data-mv-noborder')
    const css = readFileSync(join(REPO, 'tools', 'univer-build', 'widgets.css'), 'utf8')
    expect(css).toContain('[data-u-command="sheet.toolbar.sheet-frozen"] { display: none !important; }')
    const wb = readFileSync(join(REPO, 'web', 'workbench.js'), 'utf8')
    const hu = readFileSync(join(REPO, 'web', 'lang', 'hu.js'), 'utf8')
    const en = readFileSync(join(REPO, 'web', 'lang', 'en.js'), 'utf8')
    for (const k of ['freeze_title', 'freeze_rows', 'freeze_cols', 'freeze_apply', 'freeze_hint', 'no_border', 'hint_view']) {
      const key = 'workbench.table.univer_' + k
      expect(wb, key).toContain(key)
      expect(hu, key).toContain('"' + key + '"')
      expect(en, key).toContain('"' + key + '"')
    }
  })
})
