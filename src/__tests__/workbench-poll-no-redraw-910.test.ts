/**
 * #910: the quiet tree poller (every ~10 s) must not redraw the page the owner is looking at (a presentation whose
 * photo blinked) when only ANOTHER row or the outside folder listing changed. When the open item's own row is the
 * same, only the tree panel is swapped.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const js = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.js'), 'utf8')

describe('tree poll does not redraw the open item (#910)', () => {
  const f = js.slice(js.indexOf('function refreshTree(quiet, swap)'), js.indexOf('function treeSwapOnly()'))
  it('a quiet poll with an unchanged open row falls back to the tree-only swap', () => {
    expect(f).toContain('if (quiet && !swap && WB.selectedId)')
    expect(f).toContain('if (openRow(items) === openRow(WB.items)) swap = true')
  })
  it('the swap path returns before the full render, and the full render stays for a changed open row', () => {
    expect(f.indexOf('if (swap) { treeSwapOnly(); return }')).toBeGreaterThan(-1)
    expect(f.indexOf('if (swap) { treeSwapOnly(); return }')).toBeLessThan(f.lastIndexOf('render()'))
  })
  it('the decision is made before WB.items is overwritten', () => {
    expect(f.indexOf('openRow(items) === openRow(WB.items)')).toBeLessThan(f.indexOf('WB.items = items'))
  })
})
