// #755 (Boss TG 4324, 4335): a loose file row is two lines with the tick box on the left, and the Technical details
// grid (tree + Context, no width handle) has two columns, so the Context is never squeezed into the 10px handle column.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const css = readFileSync(join(process.cwd(), 'web', 'workbench.css'), 'utf8')
const js = readFileSync(join(process.cwd(), 'web', 'workbench.js'), 'utf8')

describe('file row in two lines (#755)', () => {
  it('keeps the tick box beside the name: the row never wraps', () => {
    expect(css).toMatch(/\.wb-item-row\.wb-file-row \{ flex-wrap: nowrap;/)
  })
  it('puts the name on its own line and size + date together on the second', () => {
    expect(css).toMatch(/\.wb-item-row\.wb-file-row \.wb-file-link \{[^}]*flex-direction: row; flex-wrap: wrap;[^}]*justify-content: flex-start;/)
    expect(css).toMatch(/\.wb-item-row\.wb-file-row \.wb-file-link \.wb-item-title \{ flex: 1 1 100%;[^}]*white-space: nowrap;/)
    expect(css).toMatch(/\.wb-item-row\.wb-file-row \.wb-file-link \.wb-item-meta \{ flex: 0 0 auto; margin: 0;/)
  })
  it('the #755 rules come after the narrow-column rules they override', () => {
    const at = css.indexOf('.wb-item-row.wb-file-row { flex-wrap: nowrap;')
    expect(at).toBeGreaterThan(css.lastIndexOf('.wb-sh-tech .wb-item-row .wb-item { order: -1;'))
    expect(at).toBeGreaterThan(css.lastIndexOf('.wb-fr-panel .wb-item-row .wb-item {'))
  })
  it('the tick box is drawn before the link in the row', () => {
    const fn = js.slice(js.indexOf('function plainFileRowHtml('), js.indexOf('function isLinkedFile('))
    expect(fn.lastIndexOf('wb-file-sel')).toBeLessThan(fn.lastIndexOf('<a class="wb-item wb-file-link"'))
  })
})

describe('Technical details grid (#755)', () => {
  it('draws tree + Context without the width handle', () => {
    expect(js).toMatch(/'<div class="wb-grid wb-grid-aside">' \+ itemsPanelHtml\(\) \+ contextPanelHtml\(\) \+ '<\/div>'/)
  })
  it('so it has its own two-column grid', () => {
    expect(css).toMatch(/\.wb-sh-tech \.wb-grid-aside \{ grid-template-columns: minmax\(0, 1fr\) minmax\(200px, 1fr\);/)
  })
})
