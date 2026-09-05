// A FORRASJELVENY a feluleten (specifikacio 9. es 20. pontja).
//
// A `life-sources.test.ts` es a `storage-index.test.ts` a szerver oldalt
// meri: azt, hogy a `storageId`/`physicalPath`/`sourceProvider` mezok a
// megfelelo ertekkel jonnek letre. Ez a fajl azt meri, hogy ez az adat
// TENYLEG kijut a kepernyore, megkulonboztetheto modon -- a lista soraban
// jelvenykent, es a reszletes panelben a negy mezovel.
//
// Az `app.js` egyetlen, tobb tizezer soros bongeszo-fajl, amit a
// tesztkornyezet nem tud modulkent betolteni (lasd `intezo-ctxmenu.test.ts`
// magyarazata) -- ezert a forrasszoveget vizsgaljuk, nem futtatjuk le.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const app = readFileSync(join(process.cwd(), 'web', 'app.js'), 'utf8')
const html = readFileSync(join(process.cwd(), 'web', 'index.html'), 'utf8')
const hu = readFileSync(join(process.cwd(), 'web', 'lang', 'hu.js'), 'utf8')
const en = readFileSync(join(process.cwd(), 'web', 'lang', 'en.js'), 'utf8')

/** Egy fuggveny TORZSE a forrasbol -- a legkozelebbi sor eleji `}`-ig. */
function fnBody(fej: string): string {
  const i = app.indexOf(fej)
  if (i < 0) throw new Error('nincs ilyen fuggveny: ' + fej)
  const veg = app.indexOf('\n}', i)
  return app.slice(i, veg < 0 ? undefined : veg + 2)
}

describe('_intezoBadge – a lista-sor jelvenye', () => {
  const fn = fnBody('function _intezoBadge(entry)')

  it('ki-modban semmit nem rajzol ki', () => {
    expect(fn).toMatch(/if \(mode === 'off'\) return ''/)
  })

  it('ikon-modban a forras sajat ikonja jelenik meg', () => {
    expect(fn).toMatch(/mode === 'icon' \? \(src\.icon \|\| '•'\)/)
  })

  it('felirat-modban a KIOSZTOTT sorszam all, nem csak a fajta rovidites', () => {
    // Ket Drive-fiok kulonben pontosan ugyanugy nezne ki -- a `storageId`
    // (pl. DRIVE_02) az, ami megkulonbozteti oket. Kitalalt szamot nem irunk
    // ki: ha nincs kiosztva, a fajta-rovidites (`short`) marad tartalek.
    expect(fn).toContain("src.storageId || src.short || '?'")
  })

  it('a fajl NEVET sose szinezi -- csak a jelveny kap szint', () => {
    expect(fn).toContain("class=\"intezo-badge\"")
    expect(fn).toMatch(/color:' \+ color/)
  })

  it('a lebego sugoban a reszletek is szerepelnek, nem csak a fajta neve', () => {
    expect(fn).toContain('src.details')
    expect(fn).toContain('escapeHtml')
  })
})

describe('a jelvenymod beallitasa (nezet, nem adat)', () => {
  it('a valasztott mod a bongeszoben marad (localStorage), nem a szerveren', () => {
    const getFn = fnBody('function _intezoBadgeMode()')
    expect(getFn).toContain("localStorage.getItem('intezoBadgeMode')")
    // Boss valasztasa: alapertelmezesben az ikonos jelzes fut.
    expect(getFn).toContain("|| 'icon'")
  })

  it('privat bongeszesben (localStorage tiltva) sem all le, csendben az ikon-modra esik vissza', () => {
    const getFn = fnBody('function _intezoBadgeMode()')
    expect(getFn).toMatch(/catch \(e\) \{ return 'icon' \}/)
  })

  it('modvaltaskor ujrarajzolja a listat, kulonben a regi jelvenyek maradnanak', () => {
    const setFn = fnBody('function _intezoSetBadgeMode(mode)')
    expect(setFn).toContain('_intezoRender()')
  })

  it('a harom radio-gomb (ikon / felirat / ki) mindegyike be van kotve', () => {
    const bind = app.slice(
      app.indexOf('document.querySelectorAll(\'input[name="intezoBadge"]\')'),
      app.indexOf("if (active) active.checked = true") + 40,
    )
    expect(bind).toContain("addEventListener('change', () => _intezoSetBadgeMode(r.value))")
    // Lapbetoltéskor a MENTETT mod jeloli be a radio-t -- kulonben a feluleten
    // mindig "ikon" latszana, meg akkor is, ha korabban "ki"-t valasztottak.
    expect(bind).toContain('const mode = _intezoBadgeMode()')
  })

  it('a beallito-panel mindharom erteket felkinalja a feluleten', () => {
    expect(html).toMatch(/name="intezoBadge" value="icon"/)
    expect(html).toMatch(/name="intezoBadge" value="text"/)
    expect(html).toMatch(/name="intezoBadge" value="off"/)
  })
})

describe('a reszletes panel – a 20. pont ot mezoje', () => {
  const info = fnBody('async function _intezoInfo(rel, quiet)')

  it('mind az ot mezot kiirja: logikai utvonal, azonosito, fajta, fizikai utvonal, szolgaltato', () => {
    expect(info).toContain("t('intezo.st_logical')")
    expect(info).toContain("t('intezo.st_id')")
    expect(info).toContain("t('intezo.st_type')")
    expect(info).toContain("t('intezo.st_physical')")
    expect(info).toContain("t('intezo.st_provider')")
  })

  it('az azonosito HIANYA nem hallgat: a nulla-szabaly szoveg jelenik meg helyette', () => {
    // `stg.storageId || stg.storageNote || '—'` -- ha nincs azonosito, a
    // `storageNote` (a harom ok egyike: no-depot / not-storage / unregistered)
    // all a helyen, nem egy sima üres cella.
    expect(info).toContain('stg.storageId || stg.storageNote')
  })

  it('a fizikai utvonal es a szolgaltato csak akkor jelenik meg, ha tenyleg van ertekuk', () => {
    // Igy egy tiszta helyi fajlnal (aminek nincs kulon fizikai masa) nem
    // jelenik meg egy ures sor.
    expect(info).toMatch(/if \(stg\.physicalPath\) rows\.push/)
    expect(info).toMatch(/if \(stg\.sourceProvider\) rows\.push/)
  })
})

describe('i18n – a jelveny es a panel szovege mindket nyelven megvan', () => {
  const keys = [
    'intezo.badge_mode', 'intezo.badge_icon', 'intezo.badge_text', 'intezo.badge_off',
    'intezo.st_logical', 'intezo.st_id', 'intezo.st_type', 'intezo.st_physical', 'intezo.st_provider',
  ]

  it.each(keys)('%s szerepel a magyar es az angol szotarban is', (key) => {
    expect(hu).toContain("'" + key + "':")
    expect(en).toContain("'" + key + "':")
  })

  it('a beallito-panel felirata data-i18n-en at all, nem huzva magyarul', () => {
    expect(html).toMatch(/data-i18n="intezo\.badge_mode"/)
    expect(html).toMatch(/data-i18n="intezo\.badge_icon"/)
    expect(html).toMatch(/data-i18n="intezo\.badge_text"/)
    expect(html).toMatch(/data-i18n="intezo\.badge_off"/)
  })
})
