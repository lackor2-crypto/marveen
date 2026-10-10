// #533 (Boss 2026-10-10): a visszavonas / ujra gomb a dokumentum-lap, a birosagi beadvany es a tablazat felso savjaban,
// a "Mentve" UTAN jobbra; Ctrl+Z / Ctrl+Y a lapon; mindket nezetben; felirat-buborek HU+EN. A viselkedest a valodi
// bongeszos proba merte (lasd a kartya megjegyzeseit); ez a teszt a szerkezetet rogziti, hogy a gombok ne tunjenek el.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(__dirname, '..', '..')
const wb = readFileSync(join(root, 'web', 'workbench.js'), 'utf-8')
const hu = readFileSync(join(root, 'web', 'lang', 'hu.js'), 'utf-8')
const en = readFileSync(join(root, 'web', 'lang', 'en.js'), 'utf-8')
const entry = readFileSync(join(root, 'tools', 'univer-build', 'entry.js'), 'utf-8')
const bundle = readFileSync(join(root, 'web', 'vendor', 'univer', 'univer.js'), 'utf-8')

function fn(name: string): string {
  const i = wb.indexOf(`function ${name}(`)
  expect(i, `function ${name} missing`).toBeGreaterThan(-1)
  const next = wb.indexOf('\n  function ', i + 10)
  return wb.slice(i, next > -1 ? next : undefined)
}

describe('visszavonas / ujra gomb (#533)', () => {
  it('a felso savban a "Mentve" jelzes UTAN, a cim ELOTT all', () => {
    const top = fn('frTopHtml')
    const saved = top.indexOf("wb-sh-saved wb-sh-saved-")
    const steps = top.indexOf("stepsForItem(it, 'wb-fr-tbtn'")
    const name = top.indexOf('wb-fr-name')
    expect(saved).toBeGreaterThan(-1)
    expect(steps).toBeGreaterThan(saved)
    expect(name).toBeGreaterThan(steps)
  })

  it('dokumentumnal (birosagi beadvany ugyanez) es tablazatnal is megjelenik, archivaltnal nem', () => {
    const s = fn('stepsForItem')
    expect(s).toContain('archived()')
    expect(s).toMatch(/docPageOpen\(it\)[\s\S]*stepButtonsHtml\('doc'/)
    expect(s).toMatch(/frIsTable\(it\)[\s\S]*stepButtonsHtml\('tbl'/)
  })

  it('a Manualis nezetben a vazlat es a racs felett is ott van, az Egyszerunel nem duplazodik', () => {
    expect(fn('outlineHtml')).toContain('manualStepsHtml(d.item)')
    expect(fn('previewHtml')).toContain('manualStepsHtml(')
    expect(fn('manualStepsHtml')).toContain('isSimple()')
  })

  it('Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z a dokumentum-lapon; mas beviteli mezoben a bongeszo sajat visszavonasa marad', () => {
    expect(wb).toContain("if (k !== 'z' && k !== 'y') return")
    expect(wb).toContain("docStep(k === 'y' || e.shiftKey ? 'redo' : 'undo')")
    expect(wb).toMatch(/tag === 'INPUT' \|\| tag === 'TEXTAREA' \|\| tag === 'SELECT'/)
    // a gomb nem veheti el a fokuszt a lap mezojetol, es a begepelt szoveget a lepes elott elmentjuk
    expect(wb).toContain("closest('[data-wb-step]')")
    expect(fn('docStep')).toContain('dpFlush()')
  })

  it('a letiltott allapot a szerver tortenetebol jon (nincs mit visszavonni = tiltott)', () => {
    const s = fn('stepButtonsHtml')
    expect(s).toContain('h.can_undo')
    expect(s).toContain('h.can_redo')
    expect(s).toContain("(x.on ? '' : ' disabled')")
  })

  it('a felirat-buborek es a lepesek nevei HU+EN, a tortenet helye ki van mondva', () => {
    const keys = [
      'workbench.dp.undo', 'workbench.dp.redo', 'workbench.dp.undo_what', 'workbench.dp.redo_what', 'workbench.dp.undo_none',
      'workbench.dp.redo_none', 'workbench.dp.undone', 'workbench.dp.redone', 'workbench.dp.history_hint',
      'workbench.dp.step.add_block', 'workbench.dp.step.edit_block', 'workbench.dp.step.remove_block', 'workbench.dp.step.rename_section',
      'workbench.tbl.undo_grid', 'workbench.tbl.undo_version', 'workbench.tbl.redo_version', 'workbench.tbl.history_hint',
    ]
    for (const k of keys) {
      expect(hu, `hu ${k}`).toContain(`"${k}"`)
      expect(en, `en ${k}`).toContain(`"${k}"`)
    }
    // minden szerver-oldali lepes-cimkehez van felirat
    for (const l of ['add_section', 'rename_section', 'move_section', 'edit_section', 'remove_section', 'add_block', 'edit_block', 'format_block', 'move_block', 'remove_block', 'accept_rewrite', 'dismiss_rewrite', 'drop', 'confirm', 'external']) {
      expect(hu, `hu step ${l}`).toContain(`"workbench.dp.step.${l}"`)
      expect(en, `en step ${l}`).toContain(`"workbench.dp.step.${l}"`)
    }
  })

  it('a tablazat racsa (Univer) kiadja a sajat lepes-tortenetet, es a vendorolt csomag ezt tartalmazza', () => {
    expect(entry).toContain('IUndoRedoService')
    expect(entry).toMatch(/undo: function \(\) \{ return step\('undo'\) \}/)
    expect(entry).toMatch(/redo: function \(\) \{ return step\('redo'\) \}/)
    expect(entry).toContain('historyStatus: status')
    expect(entry).toContain('onHistory')
    // a csomag a build kimenete: a kezelo kulcsai benne vannak (a nevek nem minifikalodnak)
    expect(bundle).toContain('historyStatus:')
    expect(bundle).toContain('onHistory')
  })
})
