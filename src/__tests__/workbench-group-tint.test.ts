import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Boss TG 2531: a top-level group and everything under it share a base tint in the Workbench list.
describe('workbench list group tint', () => {
  const js = readFileSync(join(process.cwd(), 'web/workbench.js'), 'utf-8')
  const css = readFileSync(join(process.cwd(), 'web/workbench.css'), 'utf-8')
  it('folders, items and files inherit the group index', () => {
    expect(js).toContain('walk(f, depth + 1, g)')
    expect(js).toContain('itemRowHtml(it, depth, grp)')
    expect(js).toContain('plainFileRowHtml(f, depth, grp)')
    expect(js).toContain('--wb-grp')
  })
  it('the tint is styled from the variable', () => {
    expect(css).toMatch(/\.wb-grp\s*\{[^}]*var\(--wb-grp\)/)
  })

  // #684 (Boss TG 9503): the background colour carries the grouping; the frames are faded.
  it('the item folder is one blue, every other folder has its own palette colour and never inherits its parent\'s (Boss TG 9585), frames are faint', () => {
    expect(js).toContain('function grpHsl(g)')
    expect(js).toContain('var g = ownFold[f] ? -(++topIdx) : folIdx++')
    expect(js).not.toContain('subIdx')
    expect(js).toContain('var pal = [350, 128, 275, 42, 168, 318, 95]')
    expect(js).toContain('var g = outIdx++')
    expect(css).toMatch(/\.wb-sec-box\s*\{[^}]*10%, transparent[^}]*background: transparent/)
  })
})

describe('palette order (#690)', () => {
  it('neighbouring colours are at least 100 degrees apart on the wheel, never two shades of one hue', () => {
    const js = readFileSync(join(process.cwd(), 'web/workbench.js'), 'utf-8')
    const m = /var pal = \[([0-9, ]+)\]/.exec(js)
    const pal = m![1].split(',').map((x) => Number(x.trim()))
    const dist = (a: number, b: number) => { const x = Math.abs(a - b) % 360; return Math.min(x, 360 - x) }
    for (let i = 0; i < pal.length; i++) expect(dist(pal[i], pal[(i + 1) % pal.length])).toBeGreaterThanOrEqual(100)
    for (const h of pal) expect(dist(h, 210)).toBeGreaterThanOrEqual(40)
  })
})
