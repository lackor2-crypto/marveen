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
    expect(js).toContain('var GRP_FOLDER = ')
    expect(js).toContain('var g = outIdx++')
    expect(css).toMatch(/\.wb-sec-box\s*\{[^}]*10%, transparent[^}]*background: transparent/)
  })
})

describe('palette (#690, #692)', () => {
  const js = readFileSync(join(process.cwd(), 'web/workbench.js'), 'utf-8')
  const dist = (a: number, b: number) => { const x = Math.abs(a - b) % 360; return Math.min(x, 360 - x) }
  const folders = JSON.parse((/var GRP_FOLDER = (\[\[[0-9, \[\]]+\]\])/.exec(js))![1]) as number[][]
  const hue0 = Number(/var GRP_ITEM_HUE0 = (\d+)/.exec(js)![1])
  const [itemS, itemL] = (/var GRP_ITEM_SL = \[(\d+), (\d+)\]/.exec(js)!).slice(1).map(Number)
  const itemHue = (n: number) => Math.round((hue0 + n * 137.508) % 360)
  const items = Array.from({ length: 8 }, (_, n) => [itemHue(n), itemS, itemL])
  it('the 6 folders of one work item are far apart: neighbours >= 90 degrees, and any two differ in hue by 30+ or lightness by 15+', () => {
    expect(folders.length).toBeGreaterThanOrEqual(6)
    for (let i = 0; i < folders.length; i++) expect(dist(folders[i][0], folders[(i + 1) % folders.length][0])).toBeGreaterThanOrEqual(90)
    for (let i = 0; i < folders.length; i++) for (let j = i + 1; j < folders.length; j++) {
      expect(dist(folders[i][0], folders[j][0]) >= 30 || Math.abs(folders[i][2] - folders[j][2]) >= 15).toBe(true)
    }
  })
  it('the work item is DARK and every folder is lighter and away from it in hue or lightness (Boss TG 9624)', () => {
    for (const it of items) {
      expect(it[2]).toBeLessThanOrEqual(36)
      for (const f of folders) {
        expect(f[2] - it[2]).toBeGreaterThanOrEqual(6)
        expect(dist(f[0], it[0]) >= 45 || f[2] - it[2] >= 25).toBe(true)
      }
    }
  })
  it('every work item gets its own hue: any two of 8 open items differ by >= 30 degrees (#693, Boss TG 9632)', () => {
    expect(js).toContain('(-g - 1) * 137.508')
    for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) expect(dist(items[i][0], items[j][0])).toBeGreaterThanOrEqual(30)
  })
  it('every work item restarts the folder slots, and the item tint is stronger than the folder tint', () => {
    expect(js).toContain('if (ownFold[f]) folIdx = 0')
    expect(js).toContain('if (ownFold[f]) folIdx = outerFol')
    expect(js).toContain("(g < 0 ? '40%' : '24%')")
  })
})
