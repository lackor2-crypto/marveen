// A BEKOTOTT-JELZO NE EGYE MEG A BESZELGETES CIMET.
//
// A MERT ESET (2026-09-13). A kod-hid kartyajan minden chat-sor elott ott allt a
// "● bekotott beszelgetes" felirat. Ez a LEGGYAKORIBB allapot -- amig a
// projekthez egyszer sem futott feladat, MINDEN sor ezt viseli --, es a teljes
// felirata elszoritotta azt, amiert a sor egyaltalan ott van: a beszelgetes
// cimet. Boss: "ami a kartyan van a chat elott hogy bekotott beszelgetes az nem
// kell oda. mert magabol a chat szovegebol igy semmi sem latszik."
//
// A jelzes MEGMARAD (pont + tooltip + aria-label), csak a helyet nem foglalja.
// A masik ket allapot kiirva marad: azok ritkak es valodi hirt hoznak.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..', '..')
const APP_JS = readFileSync(join(ROOT, 'web', 'app.js'), 'utf8')
const HU = readFileSync(join(ROOT, 'web', 'lang', 'hu.js'), 'utf8')
const EN = readFileSync(join(ROOT, 'web', 'lang', 'en.js'), 'utf8')

/** A cbTabMark fuggveny torzse -- ezt vizsgaljuk, nem a teljes fajlt. */
function tabMarkBody(): string {
  const i = APP_JS.indexOf('function cbTabMark(')
  expect(i, 'a cbTabMark fuggveny eltunt az app.js-bol').toBeGreaterThan(0)
  const end = APP_JS.indexOf('\n}', i)
  return APP_JS.slice(i, end)
}

describe('a bekotott-jelzo nem szoritja el a beszelgetes cimet', () => {
  it('a bekotott agon CSAK a pont latszik, nem a teljes felirat', () => {
    const body = tabMarkBody()
    // A lathato szoveg agakra bomlik: bound -> '●', minden mas -> a teljes cimke.
    expect(
      /bound\s*\?\s*'●'\s*:\s*t\(key\)/.test(body),
      'A bekotott allapot ujra a teljes feliratot irja ki -- ez volt az, ami\n'
        + 'elszoritotta a beszelgetes cimet a kartyan (Boss, 2026-09-13).',
    ).toBe(true)
  })

  it('az INFORMACIO nem vesz el: tooltip es aria-label tovabbra is a teljes szoveg', () => {
    const body = tabMarkBody()
    expect(body).toContain("title=")
    expect(body).toContain("aria-label=")
    // Az aria-label a teljes cimke (t(key)), nem a pont -- kulonben a
    // kepernyoolvaso kevesebbet mondana, mint eddig.
    expect(/aria-label="'\s*\+\s*escapeAttr\(t\(key\)\)/.test(body)).toBe(true)
  })

  it('a masik ket allapot TOVABBRA IS kiirva marad', () => {
    // Ezek ritkak es valodi hirt hoznak (epp itt dolgozik / itt dolgozott
    // utoljara) -- oket nem rejtjuk el.
    const body = tabMarkBody()
    expect(body).toContain('cb.card.tab_mark_running')
    expect(body).toContain('cb.card.tab_mark_last')
  })

  it('mindharom cimke megvan magyarul es angolul is', () => {
    for (const key of ['tab_mark_running', 'tab_mark_last', 'tab_mark_bound']) {
      expect(HU.includes(`'cb.card.${key}'`), `hianyzik a magyar ${key}`).toBe(true)
      expect(EN.includes(`'cb.card.${key}'`), `hianyzik az angol ${key}`).toBe(true)
      expect(HU.includes(`'cb.card.${key}_help'`), `hianyzik a magyar ${key}_help`).toBe(true)
      expect(EN.includes(`'cb.card.${key}_help'`), `hianyzik az angol ${key}_help`).toBe(true)
    }
  })
})
