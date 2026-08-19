/**
 * Az Attekintes onellenorzo kartyaja es a vegigvezetoje.
 *
 * Boss, 2026-08-19, harom keres egymas utan:
 *   "csinald ugy hogy allandoan megjelenjen [...] ne tunjon el. ha nincs semmi
 *    baj akor azt is irja ki"
 *   "vegig kell vezetni a folyamaton."
 *   "az onellenorzes ha kiirja ezt a hianyossagot, akor ott megnyom egy gombot
 *    es vegigvezeti ezen a folyamaton a usert."
 *
 * Ezek FELULETI kovetelmenyek, es a felulet nincs lefedve futtatott teszttel,
 * ezert a forrast olvassuk. Egy ilyen teszt nem bizonyitja, hogy szep -- azt
 * bizonyitja, hogy a harom megkovetelt viselkedes (nem tunik el / kiirja a jo
 * hirt is / van gomb, ami vegigvezet) nem esik ki csendben egy kesobbi
 * atirasnal.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../config.js'

const app = readFileSync(join(PROJECT_ROOT, 'web', 'app.js'), 'utf8')
const html = readFileSync(join(PROJECT_ROOT, 'web', 'index.html'), 'utf8')
const hu = readFileSync(join(PROJECT_ROOT, 'web', 'lang', 'hu.js'), 'utf8')
const en = readFileSync(join(PROJECT_ROOT, 'web', 'lang', 'en.js'), 'utf8')
const route = readFileSync(join(PROJECT_ROOT, 'src', 'web', 'routes', 'connections.ts'), 'utf8')

/** A kartyat rajzolo fuggveny torzse. */
const renderer = /async function renderOverviewConnections\(\)[\s\S]*?\n}\n/.exec(app)?.[0] ?? ''

describe('az onellenorzo kartya SOSEM tunik el', () => {
  it('megtalalom a rajzolo fuggvenyt', () => {
    expect(renderer.length).toBeGreaterThan(500)
  })

  it('egyetlen agon sem rejti el magat', () => {
    // Ez a lenyeg: barmelyik `box.hidden = true` visszateres pontosan azt a
    // viselkedest hozna vissza, amit Boss kifogasolt.
    expect(renderer).not.toMatch(/box\.hidden\s*=\s*true/)
  })

  it('a kartya a HTML-ben sincs alapbol elrejtve', () => {
    const div = /<div class="overview-capabilities" id="overviewConnections"[^>]*>/.exec(html)?.[0] ?? ''
    expect(div, 'nem talalom a kartyat').toContain('overviewConnections')
    expect(div).not.toContain('hidden')
  })

  it('meg a szerver elerhetetlensege eseten is kiir valamit', () => {
    expect(renderer).toMatch(/catch\s*{[\s\S]{0,200}conn\.ov_unreachable/)
  })

  it('ha nincs semmi baj, azt is kimondja', () => {
    expect(renderer).toMatch(/conn\.ov_all_ok/)
    for (const src of [hu, en]) expect(src).toMatch(/'conn\.ov_all_ok':/)
  })
})

describe('a lejarat sorai vegigvezetot nyitnak, nem csak egy oldalt', () => {
  it('a lejart es a hamarosan lejaro sor is kap vegigvezetot', () => {
    // A blokk vegeig kell olvasni: az elso `}` meg csak a `rows.push({...})`
    // objektumon belul van, es egy addig tarto minta akkor is "megtalaltam"-ot
    // mondana, ha a vegigvezeto-hivatkozas hianyzik.
    const expired = /status === 'expired'\)\s*{[\s\S]*?\n    }/.exec(renderer)?.[0] ?? ''
    const soon = /status === 'soon'\)\s*{[\s\S]*?\n    }/.exec(renderer)?.[0] ?? ''
    expect(expired.length, 'nem talalom a lejart agat').toBeGreaterThan(80)
    expect(soon.length, 'nem talalom a hamarosan agat').toBeGreaterThan(80)
    expect(expired).toContain('guide:')
    expect(soon).toContain('guide:')
  })

  it('a kattintas a vegigvezetot hivja', () => {
    expect(renderer).toMatch(/openSelfCheckGuide\(/)
  })

  it('a vegigvezeto ablaka letezik, ket uttal es ellenorzo gombbal', () => {
    expect(html).toContain('selfCheckGuideOverlay')
    expect(html).toContain('data-guide="quick"')
    expect(html).toContain('data-guide="permanent"')
    expect(html).toContain('selfCheckGuideCheck')
  })
})

describe('a vegigvezeto tartalma', () => {
  it('a zaro lepes MEGMERI az eredmenyt, nem csak gratulal', () => {
    const verify = /async function selfCheckGuideVerify\(\)[\s\S]*?\n}\n/.exec(app)?.[0] ?? ''
    expect(verify).toContain('/api/connections/summary')
    expect(verify).toContain('guide.verify_ok')
    expect(verify).toContain('guide.verify_still_expired')
  })

  it('a vegleges ut elmondja, hogy utana MEG EGYSZER csatlakoztatni kell', () => {
    // A legkonnyebben elrontheto reszlet: a mar kiadott token a regi
    // hatarideejevel el tovabb, tehat elesites utan is kell egy bejelentkezes.
    // Enelkul a user ket nap mulva ugyanitt all, es azt hiszi, becsaptuk.
    const m = /'guide\.perm_5':\s*'([^']*(?:\\'[^']*)*)'/.exec(hu)?.[1] ?? ''
    expect(m.length, 'nincs meg a guide.perm_5 lepes').toBeGreaterThan(40)
    expect(m).toMatch(/újra/i)
  })

  it('a regi (levelkuldo) token sajat lepessort kap', () => {
    // Ez a hitelesites nincs benne a Fiokok oldal listajaban, ezert a
    // "keresd meg a listaban" lepes hazug volna ra.
    expect(app).toContain("_selfCheckGuideTarget.id === 'google:legacy'")
    for (const src of [hu, en]) expect(src).toMatch(/'guide\.legacy_1':/)
  })

  it('a Cloud Console link a KONKRET projektre mutat', () => {
    expect(route).toMatch(/projectId: googleOauthProjectId\(\)/)
    expect(app).toMatch(/_selfCheckProjectId[\s\S]{0,200}console\.cloud\.google\.com/)
  })

  it('minden hasznalt guide-kulcs letezik mindket nyelven', () => {
    const used = new Set<string>()
    for (const m of app.matchAll(/t\('(guide\.[\w_.]+)'/g)) used.add(m[1])
    for (const m of html.matchAll(/data-i18n="(guide\.[\w_.]+)"/g)) used.add(m[1])
    expect(used.size).toBeGreaterThan(10)
    for (const key of used) {
      expect(hu, `hu: hianyzik ${key}`).toContain(`'${key}':`)
      expect(en, `en: hianyzik ${key}`).toContain(`'${key}':`)
    }
  })
})

describe('a rendszer-ellenorzesek is a kartyan jelennek meg', () => {
  // Boss, 2026-08-19: "barmi ami elromolhat arra tegyunk ellenorzest. ami itt
  // jelenik meg." Egy szerver-oldali ellenorzes, amit senki nem rajzol ki,
  // pont olyan nema, mint a hianyzo ellenorzes.
  it('a rajzolo kiirja a health sorokat', () => {
    expect(renderer).toContain('d.health')
    expect(renderer).toMatch(/t\('health\.' \+ h\.id/)
  })

  it('a rendben levo mentes a ZOLD kartyan is kap sort', () => {
    // Eppen az volt a baj, hogy a mentes hetekig "sikeres" volt, mikozben a
    // hozzaferesek egyike sem volt benne. Ezert a jo hir sem lehet nema.
    expect(renderer).toContain('backup_ok')
  })

  it('minden health kulcs letezik mindket nyelven', () => {
    const used = new Set<string>()
    for (const m of hu.matchAll(/'(health\.[\w_]+)':/g)) used.add(m[1])
    expect(used.size).toBeGreaterThan(8)
    for (const key of used) expect(en, `en: hianyzik ${key}`).toContain(`'${key}':`)
  })

  it('minden allapothoz tartozik TEENDO-szoveg is', () => {
    // A `_action` parja nelkul a sor panaszkodik, de nem mondja meg, mit
    // kezdjen vele a felhasznalo -- a kartya pont ettol lenne hasznalhatatlan.
    for (const m of hu.matchAll(/'health\.([\w_]+)':/g)) {
      const id = m[1]
      if (id.endsWith('_action')) continue
      expect(hu, `hu: nincs teendo ehhez: ${id}`).toContain(`'health.${id}_action':`)
      expect(en, `en: nincs teendo ehhez: ${id}`).toContain(`'health.${id}_action':`)
    }
  })
})

describe('a szerver oldala', () => {
  it('a lejart hitelesites ugyanolyan sulyu, mint egy bukott probe', () => {
    expect(route).toMatch(/googleBroken > 0 \|\| expiryWorst === 'expired'/)
  })

  it('a hasznalhatatlan mentes is felviszi a riasztas szintjet', () => {
    expect(route).toMatch(/healthWorst === 'bad'/)
    expect(route).toMatch(/healthWorst === 'warn'/)
  })

  it('a jo allapot is elmegy a felulethez (nem `none`)', () => {
    expect(route).toMatch(/:\s*'ok',/)
    expect(route).not.toMatch(/:\s*'none',/)
  })
})
