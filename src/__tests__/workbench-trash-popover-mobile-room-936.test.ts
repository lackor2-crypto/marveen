import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(__dirname, '..', '..')
const css = readFileSync(join(root, 'web', 'workbench.css'), 'utf8')
const js = readFileSync(join(root, 'web', 'workbench.js'), 'utf8')

// #936 (mobile follow-up): on a phone the Simple view stacks the columns, and the tree panel (.wb-fr-panel) is a fixed
// 320 px high box (flex-basis 320px in a column). The Trash drop-down (.wb-pop, absolute, up to 60vh) dropped out of it:
// the panel cut it off, the Restore buttons lay under the next section and could not be tapped (measured 2026-11-21,
// elementFromPoint at the Restore button hit the preview text). The panel needs room while a drop-down is open.
describe('Workbench Trash drop-down has room in the stacked (phone) layout (#936)', () => {
  const m = css.match(/@media \(max-width: 900px\) \{[^@]*?\.wb-fr-panel:has\(\.wb-pin \.wb-pop\)[^}]*\}[^@]*?\}/)
  it('a max-width:900px block gives the tree panel with an open drop-down room', () => {
    expect(m).not.toBeNull()
  })
  it('the room is at least the drop-down height (60vh) plus its header, and the fixed 320px basis is released', () => {
    const rule = (m ? m[0] : '').match(/\.wb-fr-panel:has\(\.wb-pin \.wb-pop\)\s*\{([^}]*)\}/)
    expect(rule).not.toBeNull()
    const body = rule ? rule[1] : ''
    expect(body).toMatch(/flex-basis:\s*auto/)
    expect(body).toMatch(/height:\s*auto/)
    expect(body).toMatch(/min-height:\s*calc\(60vh \+ \d+px\)/)
  })
  it('the code comments name this card (#936), not another number', () => {
    expect(js).not.toMatch(/#944: (Escape shuts|a click anywhere outside)/)
    expect(js).not.toContain('// #944 (Boss TG 6848-6850)')
  })
})
