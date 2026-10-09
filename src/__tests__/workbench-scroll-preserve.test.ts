/**
 * #482 -- SCROLL-POZICIO MEGORZESE UJRARAJZOLASKOR (regresszio-or).
 *
 * Boss (2026-10-03, TG 7716): a gorgetosav visszaugrik az elejere ujrarajzolaskor.
 * A Munkapad (web/workbench.js) mar menti es visszaallitja minden gorgetheto doboz
 * helyet egy generikus mechanizmussal (genericScrollSnapshot / genericScrollRestore),
 * DE a `fitMdSplit` a szerkeszto gorgetojet FELTETEL NELKUL nullazta MINDEN rajzolaskor,
 * AZUTAN, hogy a generikus visszaallitas mar helyreallitotta -- igy minden ujrarajzolas
 * (chat-stream, mentes, pipalás) a tetejere rantotta a szerkesztot.
 *
 * MIERT FORRAS-TESZT, NEM VISELKEDES-TESZT
 *   A scroll-logika bongeszo-elrendezest igenyel (scrollTop/scrollLeft, getBoundingClientRect,
 *   clientWidth/scrollWidth). A Munkapad teszt-harness `document.querySelector`-je null-t ad,
 *   ezert `fitMdSplit`/`genericScroll*`/`restoreStripScroll` a teszt-kornyezetben korán kilep:
 *   a tenyleges scroll-ertekek nem merhetok jsdom nelkul. Ezert a repo bevett mintajat kovetve
 *   (lasd i18n-no-hardcoded-hu) a FORRAST ellenorizzuk: a feltetel nelkuli nullazas nem terhet vissza.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SRC = readFileSync(join(ROOT, 'web', 'workbench.js'), 'utf8')

/** A `fitMdSplit` fuggveny torzse (a kovetkezo top-szintu `function`-ig). */
function fitMdSplitBody(): string {
  const start = SRC.indexOf('function fitMdSplit()')
  expect(start).toBeGreaterThan(-1)
  const after = SRC.indexOf('\n  function ', start + 1)
  return SRC.slice(start, after > -1 ? after : start + 1200)
}

describe('#482: fitMdSplit a szerkeszto gorgetojet nem nullazza minden ujrarajzolaskor', () => {
  it('NINCS feltetel nelkuli scroller.scrollTop = 0 a fitMdSplit-ben', () => {
    const body = fitMdSplitBody()
    // A regi, hibas sor: `if (scroller) scroller.scrollTop = 0` -- ennek nem szabad visszaternie.
    expect(body).not.toMatch(/if\s*\(\s*scroller\s*\)\s*scroller\.scrollTop\s*=\s*0/)
  })

  it('a szerkeszto-gorgeto nullazasat munkadarab-kulcs vedi (csak valodi valtaskor)', () => {
    const body = fitMdSplitBody()
    // A nullazas csak akkor fut, ha a jelenlegi munkadarab mas, mint amire utoljara fitteltunk.
    expect(body).toMatch(/scroller\.scrollTop\s*=\s*0/)
    expect(body).toMatch(/mdFitKey\s*!==\s*WB\.selectedId/)
    expect(body).toMatch(/WB\.mdFitKey\s*=\s*WB\.selectedId/)
  })
})

describe('#482: a generikus scroll-megorzes a helyen van (nem tunhet el eszrevetlenul)', () => {
  it('render() menti es visszaallitja minden gorgetheto doboz helyet', () => {
    expect(SRC).toMatch(/genericScrollSnapshot\s*\(\s*el\s*\)/)
    expect(SRC).toMatch(/genericScrollRestore\s*\(\s*el\s*,/)
    // a snapshot a vizszintes (left) ES fuggoleges (top) offsetet is rogziti
    expect(SRC).toMatch(/top:\s*n\.scrollTop\s*,\s*left:\s*n\.scrollLeft/)
  })
})

/** The real `restoreStripScroll` from web/workbench.js, run against a layout fake: the slide strip
 *  is a row of fixed-width cells, so the geometry is plain arithmetic and needs no browser. */
function loadRestoreStripScroll(strip: unknown): (left: number | null) => void {
  const start = SRC.indexOf('function restoreStripScroll(')
  expect(start).toBeGreaterThan(-1)
  const end = SRC.indexOf('\n  }\n', start)
  const fn = new Function('document', SRC.slice(start, end + 4) + '\nreturn restoreStripScroll')
  return fn({ querySelector: (sel: string) => (sel === '.wb-fr-strip' ? strip : null) })
}

/** A strip `clientWidth` wide whose open slide starts at `cellX` (content coordinates). */
function fakeStrip(clientWidth: number, cellX: number, cellW = 118) {
  const strip = {
    scrollLeft: 0,
    clientWidth,
    getBoundingClientRect: () => ({ left: 100 }),
    querySelector: (sel: string) => (sel === '.wb-fr-cell-on' ? cell : null),
  }
  const cell = { offsetWidth: cellW, getBoundingClientRect: () => ({ left: 100 + cellX - strip.scrollLeft }) }
  return strip
}

describe('#482: the slide strip does not jump when a slide is picked (Boss, TG 7716, 29-slide deck)', () => {
  it('a picked slide that is in view: the strip stays EXACTLY where the owner scrolled it', () => {
    // Scrolled right to 1611 px, 1000 px wide view, slide 17 at 1640 px -- in view.
    const strip = fakeStrip(1000, 1640)
    loadRestoreStripScroll(strip)(1611)
    expect(strip.scrollLeft).toBe(1611)
  })

  it('the last slides (s28/s29) picked near the end: no jump back to the start', () => {
    const strip = fakeStrip(1000, 3500)
    loadRestoreStripScroll(strip)(2672)
    expect(strip.scrollLeft).toBe(2672)
  })

  it('only a slide that would be out of view moves the strip (it is centred, not thrown to 0)', () => {
    const strip = fakeStrip(1000, 3000)
    loadRestoreStripScroll(strip)(200)
    expect(strip.scrollLeft).toBe(3000 - (1000 - 118) / 2)
  })

  it('render() hands the saved offset back (not null, which would re-centre on every click)', () => {
    const body = SRC.slice(SRC.indexOf('  function render() {'))
    expect(body).toMatch(/var stripLeft = oldStrip \? oldStrip\.scrollLeft : null/)
    expect(body.indexOf('restoreStripScroll(stripLeft)')).toBeGreaterThan(body.indexOf('el.innerHTML'))
  })
})
