// Kanban #504: the pure rules of the Workbench Univer grid (tools/univer-build/rules.mjs).
// The grid itself is a vendored browser bundle; what it may offer and what a save sends
// is decided here, so it is checked here.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  blockedKind, hiddenMenuConfig, HIDDEN_MENU_IDS, deepMerge, cellFromText, cellPattern, isDatePattern, serialToIso, textFromCell,
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
    expect(blockedKind('sheet.command.insert-row-before', true)).toBe('structure')
    expect(blockedKind('sheet.command.insert-row-before', false)).toBe(null)
    expect(blockedKind('sheet.command.remove-col', true)).toBe('structure')
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
