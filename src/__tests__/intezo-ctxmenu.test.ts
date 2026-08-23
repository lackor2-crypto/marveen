// AZ INTEZO HELYI MENUJE (jobb egergomb).
//
// Ket egyutt jelentkezo hiba volt itt, es ugyanaz az oka mindkettonek:
// a menu megnyitasa ASZINKRON (megvarja az adatlapot), es csak AZUTAN teszi
// magat a lapra. Ket gyors jobb klikk igy egymasba futott -- a masodik hivas
// bezarta az elsot, mielott az egyaltalan letezett volna, aztan mindketto
// kikerult. A `_intezoMenuEl` mar csak az egyikre mutatott, a masik pedig
// KIZARHATATLANUL ott maradt: a Boss ket menut latott, es kattintasra egyik
// sem tunt el.
//
// A forrasszoveget nezzuk, nem a futo lapot: az `app.js` egyetlen, tobb
// tizezer soros bongeszo-fajl, amit a tesztkornyezet nem tud modulkent
// betolteni. Az itt ellenorzott harom orszem viszont pont az a harom sor,
// aminek az elvesztese a hibat visszahozza.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const app = readFileSync(join(process.cwd(), 'web', 'app.js'), 'utf8')
/** A megjegyzes-sorok nelkuli kod -- hogy a teszt ne a kommentre feleljen. */
function csakKod(sz: string): string {
  return sz.split('\n').filter((l) => {
    const t = l.trim()
    return t.slice(0, 2) !== '//' && t.slice(0, 1) !== '*' && t.slice(0, 2) !== '/*'
  }).join('\n')
}

/** Egy fuggveny TORZSE a forrasbol -- a legkozelebbi sor eleji `}`-ig. */
function fnBody(fej: string): string {
  const i = app.indexOf(fej)
  if (i < 0) throw new Error('nincs ilyen fuggveny: ' + fej)
  const veg = app.indexOf('\n}', i)
  return app.slice(i, veg < 0 ? undefined : veg + 2)
}
const menuFn = app.slice(app.indexOf('async function _intezoOpenMenu'), app.indexOf('if (!window._intezoMenuBound)'))
const closeFn = app.slice(app.indexOf('function _intezoCloseMenu'), app.indexOf('/** Egy menupont.'))

describe('az Intezo helyi menuje', () => {
  it('a bezaras az OSSZES menut leszedi, nem csak a szamon tartottat', () => {
    // Ez a vedoháló: barmi okbol ragad ott egy arva menu, ez eltakaritja.
    expect(closeFn).toContain(".querySelectorAll('.intezo-ctxmenu')")
    expect(closeFn).toContain('removeChild')
  })

  it('a kesobb erkezo megnyitas ELDOBJA magat, nem tesz ki masodik menut', () => {
    // A sorszam-jegy: a megnyitas az `await` UTAN ellenorzi, hogy o-e meg az
    // aktualis. Enelkul ket menu kerul a lapra.
    expect(menuFn).toMatch(/const jegy = \+\+_intezoMenuSeq/)
    const utana = menuFn.slice(menuFn.indexOf('await _intezoInfo'))
    expect(utana).toMatch(/if \(jegy !== _intezoMenuSeq\) return/)
    // A visszateres a menu LETREHOZASA ELOTT van, kulonben nincs ertelme.
    expect(utana.indexOf('jegy !== _intezoMenuSeq')).toBeLessThan(utana.indexOf("createElement('div')"))
  })

  it('a menu megkapja azt az osztalyt, amivel a bezaras megtalalja', () => {
    expect(menuFn).toContain("m.className = 'intezo-ctxmenu'")
  })

  it('a jobb klikk NEM nyitja ki az adatlapot', () => {
    // Boss, 2026-08-22: "es alatta nem kellene kinyilnia az info nak!"
    // A `quiet` csak azt erte el, hogy ne nyissa ki -- egy korabbi bal
    // kattintastol viszont nyitva maradhatott, es a menu alatt ugralt.
    expect(menuFn).toContain('await _intezoInfo(entry.rel, true)')
    expect(menuFn).toMatch(/getElementById\('intezoInfoCard'\)[\s\S]{0,120}hidden = true/)
  })

  it('ures teruletre kattintva is becsukodik (nem csak `click`-re)', () => {
    // Egy jobb klikk az ures teruletre nem minden bongeszoben ad `click`-et.
    const bind = fnBody('if (!window._intezoMenuBound)')
    expect(bind).toMatch(/addEventListener\('mousedown'/)
    expect(bind).toMatch(/addEventListener\('keydown'[\s\S]{0,120}Escape/)
  })
})

describe('az adatlap NEM nyilik ki maganak', () => {
  const place = fnBody('function _intezoPlaceInfoCard')

  it('az elhelyezes csak MOZGATJA az adatlapot, nem nyitja ki', () => {
    // Ez a fuggveny MINDEN lista-ujrarajzolaskor lefut. Amig a vegen egy
    // `card.hidden = false` allt, addig a becsukott adatlap barmilyen
    // frissitestol visszajott -- eleg volt egy uj mappat letrehozni.
    // A megjegyzeseket kihagyjuk: a fenti magyarazat MAGA is leirja a rossz
    // sort, es enelkul a teszt a sajat kommentjere bukna el.
    expect(csakKod(place)).not.toMatch(/hidden = false/)
    expect(place).toMatch(/if \(card\.hidden\) return/)
  })

  it('a kinyitas egyedul kereskor tortenik', () => {
    const info = fnBody('async function _intezoInfo(')
    expect(info).toContain('if (!quiet) card.hidden = false')
  })
})

describe('uj mappa a helyi menubol', () => {
  it('BELEP abba a mappaba, ahova az uj mappa kerult', () => {
    // Boss, 2026-08-22: "jobb lenne ha az identitas mappaba menne. hogy
    // lassam hogy megcsinalta e a kk mappat." Az aktualis lista frissitese
    // olyan kepet ad, amiben az uj mappa nincs is benne.
    const veg = fnBody('async function _intezoMkdirInto')
    expect(veg).toContain('await _intezoOpen(rel)')
    expect(veg).not.toContain('await _intezoOpen(_intezoPath)')
    // A masik (ures teruletre nyilo) valtozat viszont HELYBEN frissit: ott az
    // uj mappa a mostani listaba kerul, tehat latszik is.
    expect(fnBody('async function _intezoMkdir(')).toContain('await _intezoOpen(_intezoPath)')
  })
})

describe('jobb klikk az Intezo ures reszen', () => {
  const bind = fnBody('if (!window._intezoMenuBound)')

  it('az EGESZ lap fogadja, nem csak a tablazat', () => {
    // Boss, 2026-08-22: "ha itt az ures reszen megnyomom az eger jobb gombjat,
    // akkor az uj mappa letrehozasa gomb jelenjen meg. ne csak akkor, ha ott
    // kozvetlenul a mappa alatt nyomom meg."
    // A `#intezoList` magassaga a sorok szama: egy ket-elemu mappaban a
    // tablazat par pixel, alatta meg fel kepernyonyi ures hely -- ott a
    // bongeszo sajat menuje jott elo.
    expect(bind).toContain("getElementById('intezoPage')")
    expect(bind).toMatch(/addEventListener\('contextmenu'/)
    expect(bind).toContain('_intezoOpenMenu(e, null)')
    // Mas lapon allva ne szoljon bele semmibe.
    expect(bind).toMatch(/lap\.hidden \|\| !lap\.contains\(t\)/)
  })

  it('a sorok es a beviteli mezok kimaradnak', () => {
    // A soroknak sajat (a tetelre vonatkozo) menujuk van; a mezokon es
    // gombokon pedig a bongeszo sajatja a hasznos (masolas, beillesztes).
    expect(bind).toContain("t.closest('tr[data-rel]')")
    expect(bind).toContain("input,textarea,select,a,button")
  })
})

describe('az uj mappa menupont felirata', () => {
  it('megmondja, MELYIK mappa ala kerul', () => {
    // Boss, 2026-08-22: "uj mappa ide helyett azt ird hogy uj mappa a mappa
    // ala! az egyertelmubb hogy hova teszi a mappat. ide az nem mond semmit."
    expect(menuFn).not.toContain('Új mappa ide')
    expect(menuFn).not.toContain('Új mappa itt')
    // A felirat 2026-08-23 ota t()-n keresztul all (ketnyelvu), de a MAPPA NEVET
    // tovabbra is bele kell tennie -- ezt orzi a ket parameteres hivas.
    expect(menuFn).toContain("t('intezo.menu_mkdir_into', { name: entry.name || entry.rel })")
    expect(menuFn).toContain("t('intezo.menu_mkdir_into', { name: _intezoMostaniNev() })")
  })

  it('a felirat mindket nyelven a mappa neve ala teszi', () => {
    const hu = readFileSync(join(process.cwd(), 'web', 'lang', 'hu.js'), 'utf8')
    const en = readFileSync(join(process.cwd(), 'web', 'lang', 'en.js'), 'utf8')
    expect(hu).toContain("'intezo.menu_mkdir_into': 'Új mappa a(z) „{name}” mappa alá'")
    expect(en).toContain("'intezo.menu_mkdir_into': 'New folder under \"{name}\"'")
  })

  it('a mostani mappa neve az utvonal utolso szakasza', () => {
    const fn = fnBody('function _intezoMostaniNev()')
    expect(fn).toContain("_intezoPath")
    // Gyoker: nincs utolso szakasz, de nevtelenul sem hagyhatjuk a menupontot.
    expect(fn).toContain("'Marveen'")
  })
})
