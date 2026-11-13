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
})
