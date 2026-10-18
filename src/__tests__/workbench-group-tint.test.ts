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

  // #693/#694 (Boss TG 9632/9639): every work item gets its own golden-ratio hue in the item band; the folders use a fixed
  // palette in a SEPARATE band (a folder never looks like a work item); one continuous folder counter, no per-item restart.
  it('items use golden-ratio hues in their own band, folders a fixed band-separated palette, no per-item restart', () => {
    expect(js).toContain('function grpHsl(g)')
    expect(js).toContain('var g = ownFold[f] ? -(++topIdx) : folIdx++')
    expect(js).toContain('var g = outIdx++')
    expect(js).not.toContain('if (ownFold[f]) folIdx = 0')
    expect(js).not.toContain('outerFol')
    // #684 (Boss TG 9503): the background colour carries the grouping; the frames are faded.
    expect(css).toMatch(/\.wb-sec-box\s*\{[^}]*10%, transparent[^}]*background: transparent/)
  })
})

describe('palette golden angle (#693, #694)', () => {
  const js = readFileSync(join(process.cwd(), 'web/workbench.js'), 'utf-8')
  const dist = (a: number, b: number) => { const x = Math.abs(a - b) % 360; return Math.min(x, 360 - x) }
  const folders = JSON.parse((/var GRP_FOLDER = (\[\[[0-9, \[\]]+\]\])/.exec(js))![1]) as number[][]
  const [bandStart, bandWidth] = (/var GRP_ITEM_BAND = \[(\d+), (\d+)\]/.exec(js)!).slice(1).map(Number)
  const [itemS, itemL] = (/var GRP_ITEM_SL = \[(\d+), (\d+)\]/.exec(js)!).slice(1).map(Number)
  const itemHue = (n: number) => Math.round(bandStart + ((n * 0.618034) % 1) * bandWidth)
  const items = Array.from({ length: 4 }, (_, n) => [itemHue(n), itemS, itemL])
  it('the 6 folders of one work item are far apart: neighbours (in the order they are handed out, also the 6th -> 7th wrap-around: the counter never restarts) >= 90 degrees, and any two differ in hue by 30+ or lightness by 15+', () => {
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
  it('every work item gets its own hue: any two of the first 4 open items differ by >= 30 degrees (#693, Boss TG 9632)', () => {
    expect(js).toContain('((-g - 1) * 0.618034) % 1')
    for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) expect(dist(items[i][0], items[j][0])).toBeGreaterThanOrEqual(30)
  })
  it('folder hues and work item hues are in SEPARATE bands: a folder never looks like a work item, none is violet or pink (#694, Boss TG 9639)', () => {
    const lo = bandStart, hi = bandStart + bandWidth
    for (const f of folders) {
      expect(f[0] < lo - 15 || f[0] > hi + 15 || (f[0] < lo && lo - f[0] >= 15)).toBe(true)
      expect(f[0] >= lo && f[0] <= hi).toBe(false)
    }
    for (const it of items) expect(it[0] >= lo && it[0] <= hi).toBe(true)
  })
  it('the item tint is stronger than the folder tint', () => {
    expect(js).toContain("(g < 0 ? '40%' : '24%')")
  })
})
