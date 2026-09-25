// #386 -- AZ INTEZO RESZLETES ADATLAPJA CSAK AZ INFO-RA NYILIK.
//
// Boss: "ez a részletes információ, ez csak az info-ra rákattintva jöjjön elő,
// kizárólag csak akkor, máskor ne." A sima bal kattintas (sor, csempe,
// fajlnev) addig az adatlapot is kinyitotta a kijelolt sor alatt, ami letolta
// a mappa tobbi reszet -- a mappaba lepes utan a tartalom a lap aljan allt.
//
// A forrasszoveget nezzuk (mint az intezo-ctxmenu teszt): az app.js tobb
// tizezer soros bongeszo-fajl, a tesztkornyezet nem tudja modulkent betolteni.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const app = readFileSync(join(process.cwd(), 'web', 'app.js'), 'utf8')

function csakKod(sz: string): string {
  return sz.split('\n').filter((l) => {
    const t = l.trim()
    return t.slice(0, 2) !== '//' && t.slice(0, 1) !== '*' && t.slice(0, 2) !== '/*'
  }).join('\n')
}
function fnBody(fej: string): string {
  const i = app.indexOf(fej)
  if (i < 0) throw new Error('nincs ilyen fuggveny: ' + fej)
  const veg = app.indexOf('\n}', i)
  return csakKod(app.slice(i, veg < 0 ? undefined : veg + 2))
}
/** Egy `querySelectorAll('<sel>').forEach(...)` blokk kodja. */
function handler(sel: string): string {
  const i = app.indexOf("list.querySelectorAll('" + sel + "').forEach")
  if (i < 0) throw new Error('nincs ilyen kezelo: ' + sel)
  const veg = app.indexOf('\n  })\n', i)
  return csakKod(app.slice(i, veg))
}

describe('#386 -- az adatlap csak az Info gombra nyilik', () => {
  it('a sor/csempe bal kattintasa csak kijelol', () => {
    const h = handler('[data-pick]')
    expect(h).toContain('_intezoSelectOnly(rel)')
    expect(h).not.toMatch(/_intezoInfo\(rel\)/)
  })

  it('a fajlnev kattintasa csak kijelol, a mappanev belep', () => {
    const h = handler('a[data-open]')
    expect(h).toContain('_intezoOpen(rel)')
    expect(h).toContain('_intezoSelectOnly(rel)')
    expect(h).not.toMatch(/_intezoInfo\(rel\)/)
  })

  it('a kijelolo mod a nyitott adatlapot is becsukja', () => {
    const f = fnBody('function _intezoSelectOnly(')
    expect(f).toContain("_intezoInfo(rel, 'select')")
    const info = fnBody('async function _intezoInfo(')
    expect(info).toMatch(/quiet === 'select'\) card\.hidden = true/)
    // csendes: az elonezet-ablak sem ugrik fel egy sima kattintasra
    expect(info).toContain("if (quiet !== 'select') void _intezoRenderPreview(info)")
  })

  it('az Info gomb nyit; csak NYITOTT adatlapnal csuk be', () => {
    const h = handler('button[data-info]')
    expect(h).toContain('_intezoInfo(rel)')
    // kijelolt, de panel nelkuli tetelen az Info nem levesz, hanem kinyit
    expect(h).toMatch(/open && _intezoSelected && _intezoSelected\.rel === rel\) _intezoClearSelection\(\)/)
  })

  it('muvelet utani frissites sosem nyitja ki az adatlapot', () => {
    const kod = csakKod(app)
    expect(kod).not.toMatch(/await _intezoInfo\(_intezoSelected\.rel\)/)
    expect((kod.match(/await _intezoInfo\(_intezoSelected\.rel, true\)/g) || []).length).toBeGreaterThanOrEqual(4)
  })

  it('a jobb klikk menu Reszletes informacio pontja tovabbra is nyit', () => {
    const menu = app.slice(app.indexOf('async function _intezoOpenMenu'), app.indexOf('if (!window._intezoMenuBound)'))
    expect(menu).toMatch(/menu_info'\), async \(\) => \{\s*await _intezoInfo\(entry\.rel\)\s*\n\s*_intezoJumpTo\('intezoInfoCard'\)/)
  })

  it('mappaba lepes utan a lista teteje latszik', () => {
    const f = fnBody('async function _intezoOpen(')
    expect(f).toContain('const navigated = uj !== _intezoPath')
    // #387: the scroll moved into _intezoScrollTop, called on the FIRST draw
    // after navigating (the cached / light / full listing, whichever is first).
    expect(f).toMatch(/if \(!drawn && navigated\) _intezoScrollTop\(\)/)
    expect(fnBody('function _intezoScrollTop(')).toContain("scrollIntoView({ block: 'start' })")
  })

  it('Ctrl+X/C a kijelolesen, Kivagas/Masolas a jobb klikk menuben mukodik', () => {
    const kod = csakKod(app)
    // #389 ota a tobbes kijelolesre is: `_intezoSelectionItems()` = a pipak,
    // vagy ha nincs pipa, az egy kijelolt elem.
    expect(kod).toMatch(/\(k === 'x' \|\| k === 'c'\) && sel\.length/)
    expect(fnBody('function _intezoSelectionItems(')).toContain('_intezoSelected')
    expect(kod).toContain("_intezoClipSet(entry, 'cut')")
  })
})

describe('#386 masodik kor -- nincs muveletsav, mappa egy kattintasra nyilik', () => {
  const html = readFileSync(join(process.cwd(), 'web', 'index.html'), 'utf8')

  it('a kijelolt tetel muveletsava nincs a lapon, es a kod sem hivatkozik ra', () => {
    expect(html).not.toContain('id="intezoActionBar"')
    const kod = csakKod(app)
    expect(kod).not.toContain('intezoActionBar')
    expect(kod).not.toContain('data-intezo-act')
  })

  it('mappa sor/csempe egy kattintasra belep', () => {
    const h = handler('[data-pick]')
    expect(h).toMatch(/if \(tr\.getAttribute\('data-dir'\)\) \{ void _intezoOpen\(rel\); return \}/)
    // a tobbes kijelolo modban a kattintas tovabbra is pipal, ELOBB
    expect(h.indexOf('_intezoMultiToggle')).toBeLessThan(h.indexOf('_intezoOpen(rel)'))
  })

  it('a megszokasbol dupla kattintas nem visz ket szinttel lejjebb', () => {
    const f = fnBody('function _intezoClickSwallowed(')
    expect(f).toContain('_intezoNavAt < 500')
    expect(handler('[data-pick]')).toContain('_intezoClickSwallowed()')
    expect(handler('a[data-open]')).toContain('_intezoClickSwallowed()')
    expect(fnBody('async function _intezoOpen(')).toContain('if (navigated) _intezoNavAt = Date.now()')
  })

  it('a sav muveletei a jobb klikk menuben vannak', () => {
    const menu = csakKod(app.slice(app.indexOf('async function _intezoOpenMenu'), app.indexOf('if (!window._intezoMenuBound)')))
    for (const k of ['intezo.menu_cut', 'intezo.menu_copy', 'intezo.menu_mount', 'intezo.menu_paper', 'intezo.menu_info', 'intezo.preview', 'intezo.download']) {
      expect(menu).toContain("t('" + k + "')")
    }
  })

  it('telefonon hosszu nyomas nyitja a menut, es utana nem lep be', () => {
    const lp = fnBody('function _intezoBindLongPress(')
    expect(lp).toContain("addEventListener('touchstart'")
    expect(lp).toContain('_intezoLongPressAt = Date.now()')
    expect(fnBody('function _intezoClickSwallowed(')).toContain('_intezoLongPressAt < 700')
    expect(csakKod(app)).toContain('_intezoBindLongPress(tr,')
  })

  it('dupla kattintas fajlon megnyitja, az Esc leveszi a kijelolest', () => {
    expect(csakKod(app)).toMatch(/querySelectorAll\('\[data-pick\]\[data-dir=""\]'\)[\s\S]{0,200}dblclick[\s\S]{0,200}_intezoOpenFile\(/)
    expect(csakKod(app)).toMatch(/else if \(_intezoSelected\) _intezoClearSelection\(\)/)
  })
})
