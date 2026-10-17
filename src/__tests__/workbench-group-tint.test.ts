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
  it('the item folder is one blue, a top-level branch has its own colour, deeper folders take their parent\'s (#685), frames are faint', () => {
    expect(js).toContain('function grpHsl(g)')
    expect(js).toContain('var g = path === box ? -(++topIdx) : grp')
    expect(js).not.toContain('subIdx')
    expect(js).toContain('var pal = [350, 28, 135, 275, 48, 168, 305, 95]')
    expect(js).toContain("var g = path === '' ? outIdx++ : grp")
    expect(css).toMatch(/\.wb-sec-box\s*\{[^}]*10%, transparent[^}]*background: transparent/)
  })
})
