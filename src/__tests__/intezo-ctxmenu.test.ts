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
    const bind = app.slice(app.indexOf('if (!window._intezoMenuBound)'))
    expect(bind).toMatch(/addEventListener\('mousedown'/)
    expect(bind).toMatch(/addEventListener\('keydown'[\s\S]{0,120}Escape/)
  })
})
