// A jovahagyo link nem maradhat ott az elozo folyamatbol.
//
// Boss, 2026-08-15, amit a bongeszo kiirt neki: "Marveen: ez a jovahagyas egy
// KORABBI bejelentkeztetesbol jott, ezert nem hasznalhato. Zard be ezt a fulet,
// es a LEGUJABB linket nyisd meg."
//
// Ez a mondat a mi sajat, uj vedelmunk volt -- de a Bosst nem o kevertee be:
// a doboz horgonya megtartotta az ELOZO folyamat linkjet, es inditaskor a doboz
// AZONNAL megjelent. A friss link csak 1-2 masodperc mulva erkezik meg (addig a
// gyerekfolyamat ki sem irta), tehat volt egy ablak, amikor a lathato, kattinthato
// link a REGI folyamate volt. Aki azonnal kattintott -- vagyis mindenki --, egy
// mar nem letezo folyamat jovahagyasat nyitotta meg.
//
// A megoldas nem orzo-kod: url nelkul TOROLJUK a href-et. Egy href nelkuli
// horgony kattinthatatlan, es ezt a bongeszo garantalja, nem mi.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const app = readFileSync(join(ROOT, 'web', 'app.js'), 'utf8')
const css = readFileSync(join(ROOT, 'web', 'style.css'), 'utf8')
const html = readFileSync(join(ROOT, 'web', 'index.html'), 'utf8')

function extractFn(src: string, name: string): string {
  const start = new RegExp(`(?:async )?function ${name}\\s*\\(`).exec(src)
  if (!start) throw new Error(`nincs ilyen fuggveny: ${name}`)
  let depth = 0
  for (let j = src.indexOf('{', start.index); j < src.length; j++) {
    if (src[j] === '{') depth++
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(start.index, j + 1) }
  }
  throw new Error(`nem zarodik: ${name}`)
}

/** Egy horgony, amennyire a fuggvenynek kell -- es feljegyzi, mi tortent vele. */
function fakeLink(initial: { href?: string; url?: string } = {}) {
  const attrs = new Map<string, string>()
  const classes = new Set<string>()
  const el = {
    href: initial.href ?? '',
    dataset: {} as Record<string, string | undefined>,
    setAttribute: (k: string, v: string) => { attrs.set(k, v) },
    removeAttribute: (k: string) => { attrs.delete(k); if (k === 'href') el.href = '' },
    classList: { add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c) },
    attrs, classes,
  }
  if (initial.url) el.dataset.url = initial.url
  return el
}

/** A VALODI _setConsentLink futtatasa a hamis horgonyon. */
function run(el: ReturnType<typeof fakeLink>, url: string) {
  const fn = new Function('document', 'id', 'url',
    `${extractFn(app, '_setConsentLink')}; return _setConsentLink(id, url)`)
  fn({ getElementById: () => el }, 'barmi', url)
  return el
}

describe('a link torlese, ha nincs friss', () => {
  it('url nelkul a href ELTUNIK -- nem "#"-re valt', () => {
    // A "#" is kattinthato: a bongeszo a lap tetejere ugrana, es a felhasznalo
    // azt hinne, hogy tortent valami. A hianyzo href az egyetlen alak, amire a
    // bongeszo maga mondja, hogy ez nem link.
    const el = run(fakeLink({ href: 'https://accounts.google.com/o/oauth2/REGI' }), '')
    expect(el.attrs.has('href'), 'href-attributum').toBe(false)
    expect(el.href, 'ne maradjon ott a regi cim').toBe('')
    expect(el.href).not.toBe('#')
  })

  it('url nelkul a masolando cim is eltunik', () => {
    // A "Masolas" gomb a dataset.url-t olvassa. Ha ott marad, a felhasznalo a
    // REGI linket masolja ki, es ugyanoda jut vissza.
    const el = run(fakeLink({ url: 'https://accounts.google.com/o/oauth2/REGI' }), '')
    expect(el.dataset.url).toBeUndefined()
  })

  it('url nelkul latszik is, hogy meg nem lehet ravinni', () => {
    const el = run(fakeLink(), '')
    expect(el.attrs.get('aria-disabled')).toBe('true')
    expect(el.classes.has('link-waiting')).toBe(true)
    expect(css, 'a jelolesnek legyen kepe is').toMatch(/a\.link-waiting\s*\{/)
  })

  it('friss url-lel minden visszakapcsol', () => {
    const el = run(fakeLink({ href: 'REGI', url: 'REGI' }), 'https://accounts.google.com/o/oauth2/UJ')
    expect(el.href).toBe('https://accounts.google.com/o/oauth2/UJ')
    expect(el.dataset.url).toBe('https://accounts.google.com/o/oauth2/UJ')
    expect(el.attrs.has('aria-disabled')).toBe(false)
    expect(el.classes.has('link-waiting')).toBe(false)
  })

  it('nem borul fel, ha a horgony nincs is a lapon', () => {
    const fn = new Function('document', `${extractFn(app, '_setConsentLink')}; return _setConsentLink('nincs', '')`)
    expect(() => fn({ getElementById: () => null })).not.toThrow()
  })
})

describe('MINDIG torlodik, mielott a doboz lathatova valik', () => {
  it('a Fotok oldalon a torles MEGELOZI a doboz megjeleniteset', () => {
    // A SORREND itt maga a javitas: forditva egy pillanatra (es egy
    // kattintasnyi idore) a regi link lenne lathato es aktiv.
    const fn = extractFn(app, '_photosConsentStart')
    const clear = fn.indexOf("_setConsentLink('photosConsentLink', '')")
    const show = fn.indexOf('photosConsentFlow').valueOf()
    expect(clear, 'van torles az inditasban').toBeGreaterThan(-1)
    expect(clear).toBeLessThan(show)
  })

  it('a Kapcsolatok oldalon is a torles jon eloszor', () => {
    const fn = extractFn(app, '_gconnStartAuth')
    const clear = fn.indexOf("_setConsentLink('gconnLink', '')")
    const show = fn.indexOf('flowBox.hidden = false')
    expect(clear).toBeGreaterThan(-1)
    expect(clear).toBeLessThan(show)
  })

  it('a folyamat lezarasakor is torlodik', () => {
    expect(extractFn(app, '_photosConsentReset')).toContain("_setConsentLink('photosConsentLink', '')")
  })

  it('a linket EGYEDUL a szerver friss valasza allitja be -- MIND A NEGY folyamatnal', () => {
    // Ezt a tesztet irva bukott ki, hogy a hiba nem ket helyen elt, hanem
    // negyen: a Claude-fiok bejelentkeztetese es az MCP-csatlakozo ugyanigy
    // orizte az elozo link-jet. Egyetlen ut marad: _setConsentLink.
    expect(app, 'kozvetlen href-iras maradt valahol').not.toMatch(/link\.href = s\.url/)
    expect(app).not.toMatch(/\.dataset\.url = s\.url/)
    expect(extractFn(app, '_photosConsentTick')).toMatch(/if \(s\.url\) _setConsentLink\('photosConsentLink', s\.url\)/)
    expect(extractFn(app, '_gconnTick')).toMatch(/if \(s\.url\) _setConsentLink\('gconnLink', s\.url\)/)
    expect(extractFn(app, '_claudeAuthTick')).toMatch(/if \(s\.url\) _setConsentLink\('claudeAuthLink', s\.url\)/)
    expect(extractFn(app, '_mconnLoginTick')).toMatch(/if \(s\.url\) _setConsentLink\('mconnLink', s\.url\)/)
  })

  it('a masik ket folyamat is torol, mielott megmutatja a dobozat', () => {
    // A Claude-bejelentkeztetes es az MCP-csatlakozo gombja nem kulon fuggveny,
    // hanem beagyazott kezelo -- ezert a doboz megjeleniteset korulvevo
    // szoveget nezzuk, ugyanazzal a SORREND-szaballyal.
    for (const [id, show] of [
      ['claudeAuthLink', "document.getElementById('claudeAuthFlow').hidden = false"],
      ['mconnLink', 'flow.hidden = false'],
    ]) {
      const showAt = app.indexOf(show)
      expect(showAt, show).toBeGreaterThan(-1)
      const before = app.slice(Math.max(0, showAt - 400), showAt)
      expect(before, `${id}: a torles hianyzik a doboz megmutatasa elol`).toContain(`_setConsentLink('${id}', '')`)
    }
  })

  it('a markup ures href-fel indul, nem egy beegetett cimmel', () => {
    for (const id of ['photosConsentLink', 'gconnLink', 'claudeAuthLink', 'mconnLink']) {
      const i = html.indexOf(`id="${id}"`)
      expect(i, id).toBeGreaterThan(-1)
      const tag = html.slice(html.lastIndexOf('<', i), html.indexOf('>', i))
      expect(tag, `${id}: ne mutasson sehova indulaskor`).toMatch(/href="#"/)
    }
  })
})
