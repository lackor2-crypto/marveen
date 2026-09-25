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
    // az elonezet-ablak ugyanugy felnyilhat, mint eddig
    expect(f).toContain('_intezoPreviewDismissed = false')
    const info = fnBody('async function _intezoInfo(')
    expect(info).toMatch(/quiet === 'select'\) card\.hidden = true/)
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
    expect(f).toMatch(/if \(navigated\)[\s\S]*scrollIntoView\(\{ block: 'start' \}\)/)
  })

  it('a kijeloles tovabbra is a Ctrl+X/C es a Kivagas/Masolas alapja', () => {
    const kod = csakKod(app)
    expect(kod).toMatch(/\(k === 'x' \|\| k === 'c'\) && _intezoSelected/)
    expect(kod).toContain("case 'cut': _intezoClipSet(_intezoSelected, 'cut')")
  })
})
