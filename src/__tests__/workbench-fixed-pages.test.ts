/**
 * Owner 2026-11-09: the page editor stretched one long sheet (page 1 two pages tall, page 3 half...). Now: fixed A4 pages
 * (slot = A4 height + gap), a spacer at every page line, rows of a table carry page lines too, and the sheet is typeset like the PDF.
 * Source test; the layout itself was measured in a real browser (12 slots for the 12-page PDF).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const JS = readFileSync(join(ROOT, 'web', 'workbench.js'), 'utf8')
const CSS = readFileSync(join(ROOT, 'web', 'workbench.css'), 'utf8')

describe('fixed A4 pages in the page editor', () => {
  it('sizes every page line so the next page starts at the next A4 slot', () => {
    const i = JS.indexOf('function dpPagesFixLayout')
    expect(i).toBeGreaterThan(-1)
    const body = JS.slice(i, i + 2600)
    expect(body).toContain('297 / 210')
    expect(body).toContain('DP_PAGE_GAP')
    expect(body).toMatch(/b\.style\.height = hh \+ 'px'/)
  })
  it('puts a page line inside a table, as a row of its own', () => {
    expect(JS).toContain('wb-dp-pagebreak-tr')
    expect(JS).toMatch(/#r\(\\d\+\)\$/)
  })
  it('the language version page gets the same fixed pages, with page lines inside its tables', () => {
    expect(JS).toMatch(/dpPagesFixLayout\(host, d\.pages\)/)
    expect(JS).toMatch(/m\.row > 0/)
    expect(JS).toMatch(/wb-dp-pagebreak-tr'\)\) \}\)|classList\.contains\('wb-dp-pagebreak-tr'\)/)
    const srv = readFileSync(join(ROOT, 'src', 'workbench-doclang-translate.ts'), 'utf8')
    expect(srv).toMatch(/row\?: number/)
  })
  it('sizes the slots again when the type size or the width changes, and divides screen measures by the frame zoom', () => {
    expect(JS).toMatch(/pg\._fitKey !== fitKey/)
    expect(JS).toMatch(/getBoundingClientRect\(\)\.width \/ page\.offsetWidth/)
  })
  it('works at a phone width too (margins as a share of the sheet width)', () => {
    expect(JS).toMatch(/w \* 2\.5 \/ 21/)
  })
  it('types the sheet like the PDF (serif, 11 pt equal-width table cells, the PDF margins)', () => {
    expect(CSS).toMatch(/\.wb-dp-page \{ font-family: "Liberation Serif"/)
    expect(CSS).toMatch(/table-layout: fixed/)
    expect(CSS).toMatch(/--pg-pl: 95px/)
  })
})
