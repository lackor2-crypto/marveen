// Munkaterulet-visszaallitas frissiteskor.
//
// Boss, 2026-08-15: "a ctrl shift r re az email jon be. a fotokon allok akkor
// miert nem a fotok jon be? elugrik frisiteskor."
//
// A tunet: az oldal betolt a helyes oldalra (az URL `#photos`-t mond), majd egy
// pillanat mulva atdob az Emailre. Az ok nem a betoltes, hanem a boot-kori
// munkaterulet-visszaallitas: az ugy latta, hogy a Fotok "nem Iroda-oldal",
// ezert hazakuldte a munkaterulet elso oldalara.
//
// KET hibat javitunk itt, es mindketto kulon vedelmet kap:
//   1. Az Iroda-oldalak listaja kezzel karbantartott objektum volt, es KETSZER
//      csuszott el a markuphoz kepest (eloszor a Drive, most a Fotok es a
//      Dokumentumok). Ezert most a markupbol szarmazik.
//   2. A mentett munkaterulet felulbiralta azt az oldalt, amit az URL kimondottan
//      megnevez. Ez konyvjelzonel es megosztott linknel is elugrast okozott --
//      most az URL dont.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..', '..')
const app = readFileSync(join(ROOT, 'web', 'app.js'), 'utf8')
const html = readFileSync(join(ROOT, 'web', 'index.html'), 'utf8')

/** Egy fuggveny torzse az app.js-bol, zarojel-parositassal. */
function extractFn(src: string, name: string): string {
  const start = new RegExp(`(?:async )?function ${name}\\s*\\(`).exec(src)
  if (!start) throw new Error(`nincs ilyen fuggveny: ${name}`)
  let i = src.indexOf('{', start.index)
  let depth = 0
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(start.index, j + 1) }
  }
  throw new Error(`nem zarodik: ${name}`)
}

/** Az Iroda-oldalsav linkjei A MARKUPBOL -- ez a teszt "igazsag-forrasa". */
function navIrodaPagesFromMarkup(): string[] {
  const i = html.indexOf('id="navIroda"')
  expect(i, 'nincs navIroda az index.html-ben').toBeGreaterThan(-1)
  const end = html.indexOf('</aside>', i)
  const seg = html.slice(i, end > 0 ? end : undefined)
  return [...seg.matchAll(/data-page="([^"]+)"/g)].map((m) => m[1])
}

/**
 * A VALODI irodaPages() lefuttatasa a VALODI markupbol kiolvasott menuvel.
 * Igy nem a kod szoveget nezzuk, hanem azt, amit tenylegesen csinal -- pont ez
 * a kulonbseg fogja meg, ha a lista megegyszer elcsuszik a markuptol.
 */
function runIrodaPages(pages: string[]): Record<string, boolean> {
  const fn = new Function('document', `${extractFn(app, 'irodaPages')}; return irodaPages()`)
  return fn({
    querySelectorAll: (sel: string) =>
      sel === '#navIroda [data-page]' ? pages.map((p) => ({ dataset: { page: p } })) : [],
  })
}

describe('melyik oldal tartozik az Irodahoz', () => {
  it('a lista a MARKUPBOL jon, nem kezzel karbantartott felsorolas', () => {
    // A regi alak (`const IRODA_PAGES = { email: true, ... }`) ketszer csuszott
    // el. Ha visszakerul, ez a teszt bukik.
    expect(app).not.toMatch(/const IRODA_PAGES\s*=\s*\{/)
    expect(extractFn(app, 'irodaPages')).toContain("querySelectorAll('#navIroda [data-page]')")
  })

  it('MINDEN Iroda-oldalsav link Iroda-oldalnak szamit -- a Fotok is', () => {
    const pages = navIrodaPagesFromMarkup()
    expect(pages.length).toBeGreaterThan(2)
    expect(pages, 'a Fotok az Iroda oldalsavban van').toContain('photos')
    const set = runIrodaPages(pages)
    for (const p of pages) expect(set[p], p).toBe(true)
  })

  it('a ket korabban kimaradt oldal is benne van (Fotok, Dokumentumok)', () => {
    // Nevre szolo regresszio-proba: pontosan ezek okoztak az elugrast.
    const set = runIrodaPages(navIrodaPagesFromMarkup())
    expect(set.photos, 'Fotok').toBe(true)
    expect(set.docs, 'Dokumentumok').toBe(true)
    expect(set.drive, 'Drive -- ez egyszer mar elromlott').toBe(true)
  })

  it('az Email is benne van, pedig nem statikus link', () => {
    // Az Email a fiokonkenti almenube kerul (ensureEmailAccountNav), ami a
    // markupban meg nem letezik -- ezert kap kezi kivetelt.
    expect(runIrodaPages([]).email).toBe(true)
  })

  it('Marvin-oldal NEM szamit Iroda-oldalnak', () => {
    const set = runIrodaPages(navIrodaPagesFromMarkup())
    for (const p of ['overview', 'agents', 'kanban', 'settings']) expect(set[p], p).toBeFalsy()
  })
})

describe('frissiteskor nem ugrik el arrol az oldalrol, amit a user nez', () => {
  const boot = app.slice(app.indexOf('let savedWs'), app.indexOf('=== Collapsible sidebar groups ==='))

  it('az URL-ben megnevezett oldal dont a munkateruletrol', () => {
    expect(boot).toMatch(/if \(named && document\.getElementById\(named \+ 'Page'\)\) ws = irodaPages\(\)\[named\] \? 'iroda' : 'marvin'/)
  })

  it('a hash ES a ?page= alak is szamit -- ahogy a route-olasnal', () => {
    expect(boot).toContain("location.hash")
    expect(boot).toContain("URLSearchParams(window.location.search).get('page')")
  })

  it('URL nelkul a mentett munkaterulet marad az alapertelmezes', () => {
    expect(boot).toMatch(/let ws = savedWs/)
  })

  it('ez az egyszeri kovetes NEM irja felul a mentett valasztast', () => {
    // A hivas idokozben kapott egy masodik erteket is (`page:`), hogy az indulo
    // visszaallitas megmondhassa, MELYIK oldalra tartunk -- lasd
    // web-boot-order.test.ts. A teszt lenyege valtozatlan: a `persist: false`
    // nem tunhet el, kulonben a puszta megnyitas felulirna a mentett
    // munkateruletet. Ezert a lezaras helyett vesszo is allhat utana.
    expect(boot).toMatch(/setWorkspace\(ws, \{ persist: false\s*(,|\})/)
  })

  it('a munkatereuleti GOMB tovabbra is atdob a masik oldalrol', () => {
    // Ez szandekos viselkedes, es nem eshet aldozatul a fenti javitasnak:
    // gombnyomasra nem maradhat a kepernyon egy olyan oldal, aminek nincs
    // linkje az uj oldalsavban.
    const sw = extractFn(app, 'setWorkspace')
    expect(sw).toMatch(/if \(ws === 'iroda' && !activeIsIroda\) location\.hash = 'email'/)
    expect(sw).toMatch(/if \(ws === 'marvin' && activeIsIroda\) location\.hash = 'overview'/)
    expect(sw).toMatch(/const activeIsIroda = !!irodaPages\(\)\[activePage\]/)
  })
})
