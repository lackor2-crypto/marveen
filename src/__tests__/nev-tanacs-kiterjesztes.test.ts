/**
 * A NEV-FIGYELMEZTETES NEM RONTHATJA EL A NEVET -- ES NEM HALLGATHAT.
 *
 * Boss, 2026-09-12: "ha veletlenul en is ekezetes nevet irok be egy
 * mappanevnek vagy file nevnek, akkor a marveen szolna hogy hoppa hiba van!
 * az intezoben..."
 *
 * A figyelmeztetes maga mar 2026 elejen megvolt (kanban #167), de KET MERT
 * hibaval allt:
 *
 *  1. A javaslat MEGETTE A KITERJESZTEST. A `naplo.md` javasolt neve
 *     `naplo-md` volt -- aki elfogadta a tanacsot, egy megnyithatatlan fajlt
 *     kapott. Egy figyelmeztetes, ami elrontja a nevet, rosszabb a semminel.
 *
 *  2. AMIBOL NEM VOLT JAVASLAT, ARROL HALLGATOTT. A felulet
 *     `if (!r.suggestion) return false` sora nemán visszafordult -- tehat
 *     eppen a LEGROSSZABB nevnel (amibol egyaltalan nem kepezheto ervenyes
 *     gep-nev) nem szolt semmit. Ez a "csend nem valasz" szabaly bukasa.
 *
 * A ZONAZAS SZANDEKOSAN SZUK. Az ekezet a dokumentum-fan RENDBEN van -- eles
 * meresen (2026-09-12) az `Archiv`, `Cegek`, `Korpas Laszlo` nevek hibatlanul
 * atmentek a kod-hid teljes lancan, lekerdezo utvonalkent is. Csak ott
 * szolunk, ahol bizonyitottan torik: a `GIT_REPOS` alatt, amit a git es a
 * parancssor hasznal. Aki mindenre riaszt, azt egy het mulva senki nem
 * olvassa el.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkName, splitExtension, slugify } from '../naming-conventions.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const APP_JS = readFileSync(join(ROOT, 'web', 'app.js'), 'utf8')

describe('a javaslat megtartja a kiterjesztest', () => {
  it('a fajlnev kiterjesztese atmegy a slugositason', () => {
    expect(checkName('napló.md', 'machine', 'hu').suggestion).toBe('naplo.md')
    expect(checkName('Korpás László.pdf', 'machine', 'hu').suggestion).toBe('korpas-laszlo.pdf')
  })

  it('tobb pont eseten CSAK az utolso a kiterjesztes', () => {
    expect(checkName('olvass.el.most.txt', 'machine', 'hu').suggestion).toBe('olvass-el-most.txt')
  })

  it('a kiterjesztes nelkuli nev valtozatlan uton megy', () => {
    expect(checkName('Árvíztűrő', 'machine', 'hu').suggestion).toBe('arvizturo')
  })

  it('a VERZIOSZAM nem kiterjesztes -- egy `v1.2` mappa nem esik ide', () => {
    // Ha a szamot is kiterjesztesnek vennenk, egy verziozott mappanevbol
    // fajlnev-alaku javaslat lenne. A hatart a BETU huzza meg.
    expect(splitExtension('v1.2')).toEqual({ base: 'v1.2', ext: '' })
    expect(checkName('v1.2', 'machine', 'hu').suggestion).toBe(slugify('v1.2'))
  })

  it('a pont ONMAGABAN nem csinal kiterjesztest', () => {
    expect(splitExtension('.rejtett')).toEqual({ base: '.rejtett', ext: '' })
    expect(splitExtension('vege.')).toEqual({ base: 'vege.', ext: '' })
    expect(splitExtension('')).toEqual({ base: '', ext: '' })
  })

  it('a kiterjesztes kisbetus lesz, de nem csonkul', () => {
    expect(splitExtension('KEP.JPEG')).toEqual({ base: 'KEP', ext: 'jpeg' })
  })
})

describe('az ember-zonaban az ekezet tovabbra is RENDBEN van', () => {
  it('egy ekezetes dokumentum-mappa nem kap figyelmeztetest', () => {
    // Ez a teszt oria a szuk zonazast: ha valaki kesobb "mindenre riasztunk"-ra
    // allitja at, itt all meg. A Boss faja szinte vegig ekezetes.
    for (const n of ['Korpás László', 'Árvíztűrő tükörfúrógép', 'Egészség', 'Beérkező']) {
      expect(checkName(n, 'human', 'hu').ok, `feleslegesen riaszt: ${n}`).toBe(true)
    }
  })
})

describe('a felulet akkor is szol, ha nincs mit javasolnia', () => {
  it('a nemán visszafordulo ag eltunt', () => {
    const from = APP_JS.indexOf('async function _intezoNevTanacs(')
    expect(from, 'nincs meg a nev-tanacs kezeloje').toBeGreaterThan(0)
    const body = APP_JS.slice(from, APP_JS.indexOf('\n}\n', from))
    // A regi, nemá­n visszafordulo sor: a `suggestion` hianya ELNYELTE a
    // figyelmeztetest is.
    expect(
      body.includes('if (!r || !r.notice || !r.suggestion || !r.rel) return false'),
      'visszakerult a nemán visszafordulo ag',
    ).toBe(false)
    // Javaslat nelkul is elhangzik az uzenet.
    expect(body.includes('showToast(r.notice)'), 'javaslat nelkul nem szol semmit').toBe(true)
  })

  it('a figyelmeztetes szovege a SZERVERTOL jon, nem a lapba egetve', () => {
    // A `notice` mar a felulet nyelven erkezik (`uiLang`), tehat a lap nem
    // fordit ujra -- es nem is all benne beegetett magyar mondat.
    const from = APP_JS.indexOf('async function _intezoNevTanacs(')
    const body = APP_JS.slice(from, APP_JS.indexOf('\n}\n', from))
    expect(/showToast\('/.test(body), 'beegetett szoveg kerult a kezelobe').toBe(false)
  })
})
