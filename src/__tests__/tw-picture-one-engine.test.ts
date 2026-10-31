// Boss TG 3959: the work item page and the translation column draw and handle a picture with ONE engine.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const JS = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.js'), 'utf8')

describe('one picture engine for the page and the translation column', () => {
  it('both draw the picture with dpImgFigureHtml', () => {
    expect(JS).toContain('function dpImgFigureHtml')
    expect(JS).toContain('dpImgFigureHtml(b.id, sec.id, pic, ro, false)')
    expect(JS).toContain("dpImgFigureHtml(bid || 'tw:0', '', pic, !!ro, true)")
  })
  it('the page handlers resolve and save a column picture (tw:N) through the island', () => {
    const i = JS.indexOf('function dpImageBlock(bid)')
    expect(JS.slice(i, i + 400)).toContain("indexOf('tw:') === 0")
    const c = JS.indexOf('function dpCall(method, sub, body)')
    expect(JS.slice(c, c + 500)).toContain('twPicApply')
    expect(JS).toContain("dpOverPlace(bid, box, wPct) {\n    if (String(bid).indexOf('tw:') === 0)")
  })
  it('the corner size handle measures a column picture too', () => {
    expect(JS).toContain("hd.closest('.wb-dp-row, .wb-tw-over')")
    expect(JS).toContain("hd.closest('.wb-dp-page, .wb-tw-page')")
  })
  it('the old separate size bar of the column is gone', () => {
    expect(JS).not.toContain('wb-tw-picbar')
    expect(JS).not.toContain('data-tw-pic="smaller"')
  })
})
