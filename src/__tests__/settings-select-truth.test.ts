// A Beallitasok valasztolistaja nem mutathat mast, mint ami ervenyben van.
//
// A <select> nemán viselkedik: ha olyan erteket kap, ami egyik <option>-jenek
// sem felel meg, az ELSO opciot mutatja. A Beallitasok sorai pontosan igy
// keszultek (`valueInput.value = originalValue`), ezert minden olyan kulcs,
// aminek az elo erteke nincs a listaban, HAMIS erteket irt ki mint jelenlegit:
//
//   - SCHEDULER_TZ alapertelmezese '' (a gep sajat zonaja), a listaja meg
//     'Europe/London'-nal kezdodik -> egy be nem allitott telepites ugy latta,
//     hogy Londonban van
//   - egy kezzel szerkesztett .env (pl. MAIN_AGENT_MODEL=claude-opus-4-8) sem
//     szerepel feltetlenul a listaban
//
// Az Ugynokok oldal modell-valasztoja ezt mar megoldotta (dynamic-model-opt);
// ez a teszt ugyanazt a becsuletet keri szamon a Beallitasok soraitol.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SETTINGS_REGISTRY } from '../config-registry.js'

const ROOT = join(__dirname, '..', '..')
const APP_JS = readFileSync(join(ROOT, 'web', 'app.js'), 'utf8')
const HU = readFileSync(join(ROOT, 'web', 'lang', 'hu.js'), 'utf8')
const EN = readFileSync(join(ROOT, 'web', 'lang', 'en.js'), 'utf8')

/** A valueSet-agat vagja ki a sor-szerkeszto fuggvenybol. */
function selectBranch(): string {
  const start = APP_JS.indexOf("if (Array.isArray(def.valueSet) && def.valueSet.length) {")
  expect(start, 'nem talalom a valueSet-agat a web/app.js-ben').toBeGreaterThan(-1)
  return APP_JS.slice(start, APP_JS.indexOf("} else if (def.type === 'boolean')", start))
}

describe('valueSet-es beallitas sora', () => {
  it('a listan kivuli elo erteket kulon opciokent szurja be', () => {
    const branch = selectBranch()
    expect(branch).toMatch(/!def\.valueSet\.includes\(originalValue\)/)
  })

  it('az ures erteket nem ures sorkent mutatja', () => {
    expect(selectBranch()).toContain("settings.value.unset")
  })

  it('a ket uj kulcs mindket nyelvben megvan', () => {
    for (const key of ['settings.value.unset', 'settings.value.current_suffix']) {
      expect(HU, `hu.js: ${key}`).toContain(key)
      expect(EN, `en.js: ${key}`).toContain(key)
    }
  })
})

describe('a registry oldalarol nezve', () => {
  it('van olyan valueSet-es kulcs, aminek az alapertelmezese NINCS a listaban', () => {
    // Ez nem hiba, hanem a fenti javitas letjogosultsaga: amig van ilyen kulcs,
    // addig a nyers `select.value = ...` hazudna. Ha ez a lista egyszer
    // kiurul, a javitas akkor is kell -- a kezzel szerkesztett .env miatt --,
    // de ez a teszt akkor mar nem mond semmit, ezert allitunk ra.
    const offList = SETTINGS_REGISTRY
      .filter(d => d.valueSet && d.valueSet.length > 0)
      .filter(d => !d.valueSet!.includes(String(d.default)))
      .map(d => d.key)
    expect(offList.length).toBeGreaterThan(0)
  })
})
