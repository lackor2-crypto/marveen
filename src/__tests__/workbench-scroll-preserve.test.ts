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
