// #590 (Boss TG 9045): the editor sheet shows a dashed line where the next PDF page about begins, and says it is approximate.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const js = readFileSync(new URL('../../web/workbench.js', import.meta.url), 'utf8')
const css = readFileSync(new URL('../../web/workbench.css', import.meta.url), 'utf8')
const hu = readFileSync(new URL('../../web/lang/hu.js', import.meta.url), 'utf8')
const en = readFileSync(new URL('../../web/lang/en.js', import.meta.url), 'utf8')

describe('the page-break line of the editor sheet', () => {
  it('is a dashed repeating line drawn over the sheet, never catching a click', () => {
    expect(css).toContain('.wb-dp-page::after')
    expect(css).toMatch(/\.wb-dp-page::after \{[^}]*pointer-events: none/)
    expect(css).toContain('--wb-pg-h: 1056px')
    expect(css).toContain('mask')
  })
  it('says under the sheet that the line is approximate, in both languages', () => {
    expect(js).toContain("t('workbench.dp.pagebreak_hint')")
    expect(hu).toContain('"workbench.dp.pagebreak_hint"')
    expect(en).toContain('"workbench.dp.pagebreak_hint"')
  })
})
