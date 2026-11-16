import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const JS = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.js'), 'utf8')
const ROUTE = readFileSync(join(__dirname, '..', 'web', 'routes', 'workbench.ts'), 'utf8')
const SRV = readFileSync(join(__dirname, '..', 'workbench-doclang-translate.ts'), 'utf8')

// Boss TG 4785 (#853): the "Pages" switch breaks the translation page into pages too (lines like "2. oldal"),
// and switching it off removes them from BOTH pages.
describe('the translation page has page-break lines too (#853)', () => {
  it('the page is painted, loaded and redrawn together with the original sheet', () => {
    expect(JS).toContain('function twPagesPaint()')
    expect(JS).toContain('function twPagesAfterRender()')
    expect(JS).toMatch(/dpPagesPaint\(\)\n\s+twPagesAfterRender\(\)/)
    expect(JS).toMatch(/el\.innerHTML = twPanelInnerHtml\(o, docLocked\(\)\)\n\s+twAlignTop\(\)\n\s+twPagesAfterRender\(\)/)
  })
  it('the switch paints (or clears) both pages and the lines vanish when it is off', () => {
    const i = JS.indexOf("a === 'dp-pages-toggle'")
    const body = JS.slice(i, i + 700)
    expect(body).toContain('twPagesPaint()')
    const p = JS.slice(JS.indexOf('function twPagesPaint()'), JS.indexOf('function twPagesLoad()'))
    expect(p).toContain('.wb-dp-pagebreak')
    expect(p).toContain('!dpPagesOn()')
  })
  it('a saved translation is measured again', () => {
    expect(JS).toContain('WB.twPages = null // the saved language version changed')
  })
  it('the server measures the saved language version and answers in the terms of the original chapters', () => {
    expect(ROUTE).toContain("url.searchParams.get('to')")
    expect(ROUTE).toContain('translationPageBreaks(item,')
    expect(SRV).toContain('export async function translationPageBreaks')
    expect(SRV).toContain('pageBreaksFor(live.item, uiLang)')
  })
  it('#854: the page-break line is never read back as a paragraph of the translation', () => {
    const c = JS.slice(JS.indexOf('function twCollect()'), JS.indexOf('var shownOnes ='))
    expect(c).toContain("el.classList.contains('wb-dp-pagebreak')")
    expect(c.indexOf("wb-dp-pagebreak")).toBeLessThan(c.indexOf("var role = el.getAttribute('data-tw')"))
  })
  it('#854 (run, not text): twCollect reads the page back WITHOUT the page-break lines -- "2. oldal" does not become a paragraph, however many redraws', () => {
    const from = JS.indexOf('function twCollect()')
    const fn = JS.slice(from, JS.indexOf('function twPanelInnerHtml', from))
    const el = (cls: string, attrs: Record<string, string>, text: string) => ({
      nodeType: 1, innerText: text, textContent: text, tagName: 'DIV', classList: { contains: (c: string) => c === cls },
      getAttribute: (k: string) => (k in attrs ? attrs[k] : null),
    })
    const title = el('', { 'data-tw': 'title', 'data-tw-sec': 's1' }, 'Sachverhalt')
    const para = (txt: string) => el('', { 'data-tw': 'block', 'data-tw-sec': 's1', 'data-tw-kind': 'paragraph' }, txt)
    const band = () => el('wb-dp-pagebreak', {}, '2. oldal')
    const read = (src: string) => {
      const page = {
        childNodes: [title, para('Die Klage ist eingereicht.'), band(), para('Zweiter Absatz.'), band(), band()],
        getAttribute: (k: string) => (k === 'data-tw-shown' ? 'w1:de|s1' : null),
      }
      const tw = { lang: 'de', note: '', prev: { 'w1:de:s1': { title: 'Sachverhalt', sig: 'x', fresh: false, blocks: [] as { kind: string; text: string }[] } } as Record<string, { blocks: { kind: string; text: string }[] }> }
      // eslint-disable-next-line no-new-func
      new Function('document', 'WB', 'twState', 'twKey', 't', 'dpFmtOf', 'dpPfmtOf', 'DP_ALIGNS', 'dpTableParts', 'dpTableText', 'twTableLines', 'dpCanonText', 'DP_BLANK', 'twSig', src + '; twCollect()')(
        { getElementById: () => page }, { detail: { outline: { sections: [{ id: 's1' }] } }, selectedId: 'w1' }, () => tw,
        (id: string) => 'w1:de:' + id, (k: string) => k, () => ({}), () => ({}), [], (x: string) => ({ text: x }), (x: string) => x, () => null, (x: string) => String(x).trim(), '\u200B', () => 'x',
      )
      return tw.prev['w1:de:s1'].blocks.map((b) => b.text)
    }
    // with the fix: only the two real paragraphs are saved
    expect(read(fn)).toEqual(['Die Klage ist eingereicht.', 'Zweiter Absatz.'])
    // without the skip the lines' words are saved (once per line) -- the bug: "2. oldal" five times after a few redraws
    expect(read(fn.replace("if (el.classList.contains('wb-dp-pagebreak')) continue", ''))).toContain('2. oldal')
  })
  it('#854: the page-break line says just "N. oldal" everywhere, no explanation', () => {
    expect(JS).not.toContain('pagebreak_inside')
  })
  it('#854: the translation controls are one box as high as the original toolbar, above the page', () => {
    expect(JS).toContain('<div class="wb-tw-top" id="wbTwTop">')
    expect(JS).toContain('function twAlignTop()')
    expect(JS).toContain("document.querySelector('.wb-tw-left .wb-dp-toolbar')")
    expect(JS).toContain("top.style.minHeight = bar ? bar.offsetHeight + 'px'")
  })
  it('#854: the height alignment tolerates a DOM without querySelector (the frontend test DOM)', () => {
    expect(JS).toContain("typeof document.querySelector === 'function' ? document.querySelector('.wb-tw-left .wb-dp-toolbar') : null")
  })
})
