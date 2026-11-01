import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// #580: the project tree header sits higher, the hide-finalized switch hugs the buttons.
const css = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.css'), 'utf8')

describe('workbench tree header compact (#580)', () => {
  it('the hide switch has no outer margin', () => {
    const m = css.match(/\.wb-root \.wb-hide-done \{[^}]*\}/)
    expect(m).not.toBeNull()
    expect(m![0]).toContain('margin: 0;')
  })
  it('the items panel is tightened and the buttons ride at the top', () => {
    expect(css).toMatch(/\.wb-panel-items \{ padding-top: 6px; gap: 2px; \}/)
    expect(css).toMatch(/\.wb-panel-items \.wb-panel-head \{ align-items: flex-start; \}/)
    expect(css).toMatch(/\.wb-panel-items \.wb-head-btns \{ margin-top: -2px; \}/)
  })
  it('the chat attach / dictate / send buttons stay in one row while they fit, and wrap instead of overflowing the panel (TG 3155, #582)', () => {
    expect(css).toMatch(/\.wb-chat-btns \{ flex-wrap: wrap;/)
    expect(css).not.toMatch(/\.wb-chat-btns \{ flex-wrap: nowrap;/)
    expect(css).toMatch(/\.wb-chat-btns > \* \{ flex: 0 0 auto; white-space: nowrap; \}/)
  })
  it('the chat input row is a column in every layout (TG 3164)', () => {
    expect(css).toMatch(/\.wb-chat-row \{ flex-direction: column; align-items: stretch; \}/)
  })
  it('the send button is not full width inside the chat button row', () => {
    expect(css).toMatch(/\.wb-chat-btns \.btn-primary, \.wb-chat-btns \.btn-secondary \{ width: auto;/)
  })
  it('the project tree panel is three blocks and the Projects tab shows a path (TG 3169)', () => {
    const js = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.js'), 'utf8')
    for (const c of ['wb-blk-top', 'wb-blk-tree', 'wb-pin-acts']) expect(js).toContain(c)
    expect(js).toContain('function frPanelTitleHtml')
    expect(css).toMatch(/\.wb-panel-items \.wb-blk \{ background:/)
  })
  it('the project name is the header of the folder tree, on its own background, and the panel title no longer repeats it (TG 3235)', () => {
    const js = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.js'), 'utf8')
    const tree = js.indexOf('<div class="wb-blk wb-blk-tree"><div class="wb-blk-title">')
    const top = js.indexOf("'<div class=\"wb-blk wb-blk-top\">'")
    expect(tree).toBeGreaterThan(0)
    expect(top).toBeGreaterThan(0)
    expect(js.indexOf('<div class="wb-pin">')).toBeLessThan(tree) // #831: the pinned controls come first, the tree scrolls below
    const head = js.slice(js.indexOf('<div class="wb-panel-head">', top), js.indexOf("+ hideSw", top))
    expect(head).not.toContain('WB.rootHead')
    const title = js.slice(js.indexOf('function frPanelTitleHtml'), js.indexOf('function frPanelHtml'))
    expect(title).not.toContain('WB.project.name')
    expect(css).toMatch(/\.wb-panel-items \.wb-blk-title \{[^}]*background:/)
  })
})
