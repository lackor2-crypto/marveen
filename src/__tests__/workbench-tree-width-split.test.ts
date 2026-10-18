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
    expect(css).toMatch(/@media \(min-width: 901px\) \{ \.wb-fr-panel \{ flex-basis: min\(var\(--wb-tree-w, 320px\), max\(320px, calc\(100% - 620px\)\)\); \} \}/)
    expect(css).toMatch(/\.wb-grid-aside \{ grid-template-columns: var\(--wb-tree-w, /)
  })
  it('clamps a saved width at render time, so a narrower window than when it was saved keeps the other columns', () => {
    expect(css).toMatch(/\.wb-grid-aside\[style\*="--wb-tree-w"\] \{ grid-template-columns: min\(var\(--wb-tree-w\), max\(200px, calc\(100% - 380px\)\)\)/)
  })
  it('has the tooltip in both languages', () => {
    expect(hu).toContain('"workbench.tree.width_hint"')
    expect(en).toContain('"workbench.tree.width_hint"')
  })
})
