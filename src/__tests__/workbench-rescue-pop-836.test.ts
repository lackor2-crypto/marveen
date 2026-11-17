// #836 regression (source contract; the real-browser proof is tests/browser/workbench-rescue-pop-836.spec.ts):
// on the Simple start page the left panel is content-sized and clips its dropdowns. The rebuild dropdown that moved into
// the pinned top box was cut off below the panel's edge, so the owner could not reach its button. While a dropdown is
// open the start-page panel must keep room for it, and the dropdown must never be taller than that room.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const css = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.css'), 'utf8')
const js = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.js'), 'utf8')

describe('#836 the dropdowns of the pinned box fit the start-page panel', () => {
  it('the start-page panel gets a min-height while a dropdown is open', () => {
    expect(css).toMatch(/\.wb-sh-start-tree > \.wb-sh-tree:has\(\.wb-pin \.wb-pop\)\s*\{[^}]*min-height:\s*var\(--wb-pop-room\)/)
  })
  it('the dropdown is capped below that room (it scrolls inside itself)', () => {
    expect(css).toMatch(/\.wb-sh-start-tree \.wb-panel-items \.wb-pin \.wb-pop\s*\{[^}]*max-height:\s*(?:min\()?calc\(var\(--wb-pop-room\) - \d+px\)/)  // #831: min(room cap, measured --wb-pop-fit) since the fit
  })
  it('the room is defined for desktop and for the narrow layout', () => {
    expect(css).toMatch(/\.wb-sh-start-tree\s*\{\s*--wb-pop-room:/)
    expect(css).toMatch(/@media \(max-width: 900px\)\s*\{\s*\.wb-sh-start-tree\s*\{\s*--wb-pop-room:/)
  })
  it('the rebuild box still renders as a .wb-pop inside the pinned box (what the CSS above relies on)', () => {
    expect(js).toContain("'<div class=\"wb-trash wb-rescue\">' + head + '<div class=\"wb-pop\">'")
  })
})
