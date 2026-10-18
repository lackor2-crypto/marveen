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

  // #693/#694 (Boss TG 9632/9639): every group gets its own golden-angle hue; the old fixed folder palette (GRP_FOLDER)
  // and the per-item folder restart made different groups share a colour (two work items, every item's "Feltoltesek").
  it('uses one golden-angle hue per group, no fixed folder palette and no per-item restart', () => {
    expect(js).toContain('function grpHsl(g)')
    expect(js).toContain('var g = ownFold[f] ? -(++topIdx) : folIdx++')
    expect(js).toContain('var g = outIdx++')
    expect(js).not.toContain('var GRP_FOLDER =')
    expect(js).not.toContain('if (ownFold[f]) folIdx = 0')
    expect(js).not.toContain('outerFol')
    // #684 (Boss TG 9503): the background colour carries the grouping; the frames are faded.
    expect(css).toMatch(/\.wb-sec-box\s*\{[^}]*10%, transparent[^}]*background: transparent/)
  })
})

describe('palette golden angle (#693, #694)', () => {
  const js = readFileSync(join(process.cwd(), 'web/workbench.js'), 'utf-8')
  const dist = (a: number, b: number) => { const x = Math.abs(a - b) % 360; return Math.min(x, 360 - x) }
  const itemHue0 = Number(/var GRP_ITEM_HUE0 = (\d+)/.exec(js)![1])
  const itemL = Number((/var GRP_ITEM_SL = \[(\d+), (\d+)\]/.exec(js)!)[2])
  const folHue0 = Number(/var GRP_FOLDER_HUE0 = (\d+)/.exec(js)![1])
  const itemHue = (n: number) => Math.round((itemHue0 + n * 137.508) % 360)
  const folHue = (n: number) => Math.round((folHue0 + n * 137.508) % 360)
  const items = Array.from({ length: 8 }, (_, n) => ({ h: itemHue(n), l: itemL }))
  const folders = Array.from({ length: 12 }, (_, n) => ({ h: folHue(n), l: n % 2 ? 66 : 56 }))

  it('neighbouring items, and neighbouring folders, are far apart on the wheel (>= 90 deg)', () => {
    for (let i = 0; i + 1 < items.length; i++) expect(dist(items[i].h, items[i + 1].h)).toBeGreaterThanOrEqual(90)
    for (let i = 0; i + 1 < folders.length; i++) expect(dist(folders[i].h, folders[i + 1].h)).toBeGreaterThanOrEqual(90)
  })
  it('any two of 8 open items, and any two of the first 6 folders, differ by >= 30 deg (#693/#694)', () => {
    expect(js).toContain('(-g - 1) * 137.508')
    expect(js).toContain('g * 137.508')
    for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) expect(dist(items[i].h, items[j].h)).toBeGreaterThanOrEqual(30)
    for (let i = 0; i < 6; i++) for (let j = i + 1; j < 6; j++) expect(dist(folders[i].h, folders[j].h)).toBeGreaterThanOrEqual(30)
  })
  it('work items are DARK, folders LIGHT, so a folder (e.g. Feltoltesek) never looks like a work item (Boss TG 9624/9639)', () => {
    expect(itemL).toBeLessThanOrEqual(36)
    for (const f of folders) expect(f.l).toBeGreaterThanOrEqual(50)
    for (const f of folders) expect(f.l - itemL).toBeGreaterThanOrEqual(14)
  })
})
