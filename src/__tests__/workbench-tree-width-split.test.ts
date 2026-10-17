// Boss TG 9571 (#686): the left folder column drags sideways in both views; width kept per browser.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const js = readFileSync(join(__dirname, '../../web/workbench.js'), 'utf8')
const css = readFileSync(join(__dirname, '../../web/workbench.css'), 'utf8')
const hu = readFileSync(join(__dirname, '../../web/lang/hu.js'), 'utf8')
const en = readFileSync(join(__dirname, '../../web/lang/en.js'), 'utf8')

describe('folder column width handle', () => {
  it('renders a separator in the Simple frame and the Manual split, stores the width guarded by try/catch', () => {
    expect(js).toMatch(/id="wbTreeWidthSplit" role="separator" aria-orientation="vertical"/)
    expect(js).toContain("TREE_WIDTH_KEY = 'marveen.workbench.treeWidth'")
    expect(js).toMatch(/frPanelBodyHtml\(\) \+ '<\/aside>' \+ treeWidthHandleHtml\(\)/)
    expect(js).toMatch(/wb-grid-aside"' \+ treeWidthStyle\(\) \+ '>' \+ itemsPanelHtml\(\) \+ treeWidthHandleHtml/)
    expect(js).toMatch(/applyTreeWidth\(w0 \+ \(ev\.clientX - x0\), true\)/)
  })
  it('keeps the width in a CSS variable so the narrow layout keeps its own', () => {
    expect(js).toContain('--wb-tree-w')
    expect(css).toMatch(/@media \(min-width: 901px\) \{ \.wb-fr-panel \{ flex-basis: var\(--wb-tree-w, 320px\); \} \}/)
    expect(css).toMatch(/\.wb-grid-aside \{ grid-template-columns: var\(--wb-tree-w, /)
  })
  it('has the tooltip in both languages', () => {
    expect(hu).toContain('"workbench.tree.width_hint"')
    expect(en).toContain('"workbench.tree.width_hint"')
  })
})
