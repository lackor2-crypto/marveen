// A "Leallitas" gomb MENTETT, de a hid tovabb futott -- es a kartya a kattintas
// utan is azt mutatta, hogy "Fut".
//
// Boss, 2026-08-23: "bent a vscode kartyan belul rakattintottam a leallitas
// gombra. de nem allt le. miert? es kivul a kartyan nem latom hogy fut vagy
// leallitva."
//
// Merve, nem tippelve: a store/config-overrides.json-ben CODE_BRIDGE_ENABLED
// ekkor mar '0' volt, a /api/code/health `enabled` mezoje viszont `true` --
// tehat a mentes MEGTORTENT, csak a folyamat INDULASKOR olvassa be az erteket.
// A hiba nem a gombban volt, hanem abban, hogy ezt semmi nem mondta ki: sem a
// kartyan belul (a cimke "Fut" maradt), sem kivul (semmilyen jelzes).
//
// Ez a fajl azt rogziti, hogy a ket allapot KULON latszik.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..', '..')
const app = readFileSync(join(ROOT, 'web', 'app.js'), 'utf8')
const code = readFileSync(join(ROOT, 'src', 'web', 'routes', 'code.ts'), 'utf8')
const hu = readFileSync(join(ROOT, 'web', 'lang', 'hu.js'), 'utf8')
const en = readFileSync(join(ROOT, 'web', 'lang', 'en.js'), 'utf8')

describe('kod-hid: a mentett es a futo allapot kulon latszik', () => {
  it('a health a MENTETT erteket is kikuldi, nem csak a futot', () => {
    // A `enabled` az indulaskor beolvasott konstans; a mentett erteket a
    // beallitas-tarolobol kell kerdezni, kulonben a felulet nem tudja
    // megkulonboztetni a ketto elterset.
    expect(code).toContain('savedEnabled')
    expect(code).toMatch(/savedEnabled: String\(getEffectiveSettingValue\('CODE_BRIDGE_ENABLED'\)\)/)
  })

  it('a kartyan BELUL kimondja, hogy ujrainditasra var', () => {
    const fn = app.slice(app.indexOf('function cbRenderService'), app.indexOf('async function cbSetService'))
    expect(fn).toContain('health.savedEnabled')
    expect(fn).toMatch(/pending = saved !== on/)
    expect(fn).toContain('cb.service.off_pending')
    expect(fn).toContain('cb.service.on_pending')
    // A gombok a MENTETT allapotot kovetik: ne alljon ott masodszor is a
    // "Leallitas", miutan mar leallitottad.
    expect(fn).toMatch(/startBtn\.hidden = saved/)
    expect(fn).toMatch(/stopBtn\.hidden = !saved/)
  })

  it('a kartyan KIVUL is latszik', () => {
    const fn = app.slice(app.indexOf('function cbCardNote'), app.indexOf('function cbCardNote') + 700)
    expect(fn).toContain('savedEnabled === false')
    expect(fn).toContain('cb.card.stop_pending')
  })

  it('regi backend valasza nem hazudik allapotot', () => {
    // Ha a `savedEnabled` hianyzik (regebbi szerver), a kartya NEM talal ki
    // allapotot: belul a futot mutatja, kivul hallgat.
    expect(app).toMatch(/typeof health\.savedEnabled === 'boolean'\s*\?\s*health\.savedEnabled\s*:\s*null/)
    expect(app).toMatch(/typeof health\.savedEnabled === 'boolean'\) \? health\.savedEnabled : on/)
  })

  it('minden uj szoveg ketnyelvu', () => {
    for (const key of ['cb.service.on_pending', 'cb.service.off_pending', 'cb.card.stop_pending']) {
      for (const lang of [hu, en]) expect(lang).toContain(`'${key}'`)
    }
  })

  it('a sarga pont a haz meglevo osztalyat hasznalja', () => {
    // Nem talalunk ki uj CSS-osztalyt: a `.process-dot.restarting` letezik es
    // pontosan ezt jelenti.
    const css = readFileSync(join(ROOT, 'web', 'style.css'), 'utf8')
    expect(css).toContain('.process-dot.restarting')
    expect(app).toMatch(/pending \? 'restarting'/)
  })
})
