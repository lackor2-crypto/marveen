// Kanban #504: the pure rules of the Workbench Univer grid (tools/univer-build/rules.mjs).
// The grid itself is a vendored browser bundle; what it may offer and what a save sends
// is decided here, so it is checked here.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  blockedKind, hiddenMenuConfig, FORMAT_KEPT_MENU_IDS, styleToUniver, univerToStyle, hexColor, HIDDEN_MENU_IDS, deepMerge, cellFromText, cellPattern, isDatePattern, serialToIso, textFromCell,
} from '../../tools/univer-build/rules.mjs'
import { serialToIso as serverSerialToIso, isoToSerial } from '../workbench-table.js'

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
    'set-range-fontsize', 'set-range-font-increase', 'set-range-font-decrease', 'set-range-text-color', 'reset-text-color',
    'set-background-color', 'reset-background-color', 'set-horizontal-text-align', 'set-vertical-text-align', 'set-text-wrap', 'set-style',
    // section B
    'set-border', 'set-border-basic', 'set-border-color', 'set-border-style', 'set-border-position', 'add-worksheet-merge',
    'add-worksheet-merge-all', 'add-worksheet-merge-vertical', 'add-worksheet-merge-horizontal', 'remove-worksheet-merge']
  const STILL = ['paste-besides-border', 'set-range-subscript', 'set-text-rotation', 'set-shrink-to-fit',
    'numfmt.set.percent', 'paste-format', 'clear-selection-format', 'set-once-format-painter', 'set-worksheet-hidden', 'set-tab-color',
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
    for (const id of ['sheet.command.paste-besides-border', 'sheet.operation.open.numfmt.panel']) expect(on[id]).toEqual({ hidden: true })
    for (const id of ['sheet.command.set-border-basic', 'sheet.command.add-worksheet-merge', 'sheet.command.remove-worksheet-merge']) {
      expect(on[id], id).toBeUndefined()
      expect(off[id], id).toEqual({ hidden: true })
    }
  })

  it('a cell format goes to Univer and back unchanged', () => {
    const cs = { b: true, i: true, u: true, s: true, fs: 14, ff: 'Arial', fc: '#FF0000', bg: '#FFFF00', ha: 'c' as const, va: 'm' as const, wr: true }
    expect(univerToStyle(styleToUniver(cs))).toEqual(cs)
    expect(styleToUniver({})).toEqual({})
    expect(univerToStyle({ n: { pattern: '0%' } })).toEqual({})
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
