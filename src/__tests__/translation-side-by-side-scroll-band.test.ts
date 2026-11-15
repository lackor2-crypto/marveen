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
    // Boss TG 5491: both move by the same step (what both can take); the rest goes to the whole view, never to one page alone
    expect(js).toContain('a.scrollTop = plan.top; b.scrollTop = plan.top')
    expect(js).toContain("cols.closest('.wb-fr-scroll')")
    expect(js).toContain('outer.scrollTop += plan.rest')
    expect(js).not.toContain('a.scrollTop += dy')
  })
  it('the band label is in both languages', () => {
    expect(hu).toContain('"workbench.tw.band_label"')
    expect(en).toContain('"workbench.tw.band_label"')
  })
})

// #877: the wheel step is run for real (the function is cut out of workbench.js), not only grepped.
function loadPlan() {
  const at = js.indexOf('  function twBandPlan(')
  const end = js.indexOf('  function twBandSetup()', at)
  if (at < 0 || end < 0) throw new Error('twBandPlan is missing from workbench.js')
  return new Function(js.slice(at, end) + '\nreturn twBandPlan')() as (
    a: { top: number; max: number }, b: { top: number; max: number }, dy: number) => { top: number; rest: number }
}

describe('shared-scroll band keeps the two pages on one line (#877)', () => {
  const plan = loadPlan()
  it('moves both by the same step and leaves no rest while both have room', () => {
    expect(plan({ top: 100, max: 1000 }, { top: 100, max: 1000 }, 200)).toEqual({ top: 300, rest: 0 })
    expect(plan({ top: 100, max: 1000 }, { top: 100, max: 1000 }, -50)).toEqual({ top: 50, rest: 0 })
  })
  it('when one page runs out, the rest goes to the outer view and both stay together', () => {
    expect(plan({ top: 900, max: 1000 }, { top: 900, max: 950 }, 200)).toEqual({ top: 950, rest: 150 })
    expect(plan({ top: 30, max: 1000 }, { top: 30, max: 1000 }, -100)).toEqual({ top: 0, rest: -70 })
  })
  it('pages that were scrolled apart on their own are first brought to one offset, so the longer page is not stranded', () => {
    // left was scrolled to its end on its own, right is still at the top: one wheel step puts them on one line
    const r = plan({ top: 1000, max: 1000 }, { top: 0, max: 1000 }, 0)
    expect(r).toEqual({ top: 1000, rest: 0 })
    // right is further down than left can go: both end on what the shorter one can show, the step goes on from there
    expect(plan({ top: 0, max: 500 }, { top: 800, max: 1000 }, 100)).toEqual({ top: 500, rest: 100 })
    // scrolling up from apart: both end on one offset
    expect(plan({ top: 400, max: 1000 }, { top: 0, max: 1000 }, -100)).toEqual({ top: 300, rest: 0 })
  })
  it('a page with no room at all (nothing to scroll) sends everything to the outer view', () => {
    expect(plan({ top: 0, max: 0 }, { top: 0, max: 800 }, 120)).toEqual({ top: 0, rest: 120 })
  })
})
