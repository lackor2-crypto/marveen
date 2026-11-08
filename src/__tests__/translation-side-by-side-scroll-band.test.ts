// #857 (Boss TG 5348): side by side, each column scrolls on its own; only the marked middle band scrolls both together.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(__dirname, '..', '..')
const css = readFileSync(join(root, 'web', 'workbench.css'), 'utf8')
const js = readFileSync(join(root, 'web', 'workbench.js'), 'utf8')
const hu = readFileSync(join(root, 'web', 'lang', 'hu.js'), 'utf8')
const en = readFileSync(join(root, 'web', 'lang', 'en.js'), 'utf8')

describe('side-by-side translation scroll (#857)', () => {
  it('both columns are their own scrollers, the zoom sits on the content', () => {
    expect(css).toContain('.wb-sh-doc-body > .wb-tw-cols > .wb-tw-left, .wb-sh-doc-body > .wb-tw-cols > #wbTwPanel.wb-tw-right { min-height: 0; max-height: 100%; overflow-y: auto;')
    expect(css).toContain('#wbTwPanel.wb-tw-right { zoom: 1; }')
  })
  it('the middle band is drawn and only the band scrolls both columns', () => {
    expect(css).toContain('#wbTwBand {')
    expect(js).toContain("cols.addEventListener('wheel'")
    expect(js).toMatch(/e\.clientX < mm\.x0 \|\| e\.clientX > mm\.x1 \|\| e\.clientY < mm\.y0\) return/)
    expect(js).toContain('a.scrollTop += dy; b.scrollTop += dy')
  })
  it('the band label is in both languages', () => {
    expect(hu).toContain('"workbench.tw.band_label"')
    expect(en).toContain('"workbench.tw.band_label"')
  })
})
