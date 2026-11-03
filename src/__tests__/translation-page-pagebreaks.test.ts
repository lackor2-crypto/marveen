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
    expect(JS).toMatch(/el\.innerHTML = twPanelInnerHtml\(o, docLocked\(\)\)\n\s+twPagesAfterRender\(\)/)
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
})
