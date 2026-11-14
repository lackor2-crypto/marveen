// #859: on a phone the pinned button box of the Workbench left panel must not be clipped (max-height + overflow hidden hid the
// "+ New work item" / "Upload files" buttons), and the tree rows must wrap inside the panel.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const css = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.css'), 'utf8')
const blocks = [...css.matchAll(/@media \(max-width: 900px\) \{([\s\S]*?)\n\}/g)].map((m) => m[1])
const mobile = blocks.find((b) => b.includes('.wb-pin-slot:not(.wb-pin-open) .wb-blk-top')) || ''

describe('workbench mobile pin box (#859)', () => {
  it('has a mobile block that lifts the pin box height cap', () => {
    expect(mobile).not.toBe('')
    expect(mobile).toMatch(/\.wb-pin-slot:not\(\.wb-pin-open\) \.wb-blk-top \{[^}]*max-height: none[^}]*overflow: visible/)
  })
  it('does not stick the pin box on a phone and hides the more arrow', () => {
    expect(mobile).toMatch(/\.wb-panel-items \.wb-pin \{[^}]*position: static/)
    expect(mobile).toMatch(/\.wb-pin-more[^{]*\{[^}]*display: none/)
  })
  it('lets tree rows shrink and wrap inside the panel', () => {
    expect(mobile).toMatch(/min-width: 0[^}]*max-width: 100%[^}]*overflow-wrap: anywhere/)
  })
  it('one-column phone grids use minmax(0, 1fr) so deep folders cannot widen the panel past the screen', () => {
    expect(mobile).toMatch(/\.wb-grid, \.wb-grid\.wb-grid-aside, \.wb-grid-aside\[style\*="--wb-tree-w"\] \{ grid-template-columns: minmax\(0, 1fr\); \}/)
    expect(mobile).toMatch(/\.wb-grid > \*, \.wb-grid-aside > \* \{ min-width: 0; \}/)
  })
  it('every other one-column phone grid of the Workbench also uses minmax(0, 1fr) (same root cause)', () => {
    const tail = css.slice(css.indexOf('Same root cause in every other one-column phone grid'))
    expect(tail).toMatch(/\.wb-split, \.wb-cmp-head, \.wb-cmp-cols, \.wb-img-cols, \.wb-md-split \{ grid-template-columns: minmax\(0, 1fr\); \}/)
    expect(tail).toMatch(/\.wb-can-grid \{ grid-template-columns: minmax\(0, 1fr\); \}/)
    expect(tail).toMatch(/\.wb-doclang-cols \{ grid-template-columns: minmax\(0, 1fr\); \}/)
    expect(tail).toMatch(/\.wb-tl-row \{ grid-template-columns: minmax\(0, 1fr\); \}/)
  })
})
