// TG 3133: the two header buttons are small and side by side. TG 3137: the line between the answers and the
// agent's activity in the project chat can be dragged.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const rd = (p: string) => readFileSync(new URL(`../../web/${p}`, import.meta.url), 'utf8')
const js = rd('workbench.js'); const css = rd('workbench.css'); const hu = rd('lang/hu.js'); const en = rd('lang/en.js')

describe('header buttons', () => {
  it('both buttons sit in one no-wrap group', () => {
    const i = js.indexOf('<span class="wb-head-btns">')
    expect(i).toBeGreaterThan(0)
    const seg = js.slice(i, i + 1600)
    expect(seg).toContain('wb-head-open')
    expect(seg).toContain('wb-head-attach')
    expect(seg).toContain("'</span></div>'")
    expect(css).toMatch(/\.wb-head-btns \{[^}]*flex-wrap: nowrap/)
    expect(css).toMatch(/\.wb-panel-items \.wb-panel-head \{ flex-wrap: nowrap/)
  })
  it('the later three-block layout (.wb-blk-top) does not turn the group back into a wrapping one', () => {
    const rule = css.match(/\.wb-panel-items \.wb-blk-top \.wb-head-btns \{([^}]*)\}/)
    expect(rule).not.toBeNull()
    expect(rule![1]).toContain('flex-wrap: nowrap')
    expect(rule![1]).not.toContain('flex-wrap: wrap')
  })
})

describe('chat splitter', () => {
  it('has a handle between log and tools, drag + keyboard + reset, remembered', () => {
    expect(js).toContain('id="wbChatSplit"')
    expect(js).toContain("addEventListener('pointerdown'")
    expect(js).toContain("e.key !== 'ArrowUp'")
    expect(js).toContain("addEventListener('dblclick'")
    expect(js).toContain('marveen.workbench.chatSplit')
    expect(js).toContain("chatPaneStyle('log')")
    expect(js).toContain("chatPaneStyle('tools')")
    expect(css).toContain('.wb-chat-split')
  })
  it('the lower strip keeps the dragged height and the upper one flexes (fixed-frame Simple view, TG 3148)', () => {
    expect(js).toContain("tools.style.flex = '0 0 auto'")
    expect(js).toContain("log.style.flex = '1 1 auto'")
    expect(js).toContain('A fixed-height frame squeezes the upper strip')
  })
  it('the hint is in both languages', () => {
    expect(hu).toContain('"workbench.chat.split_hint"')
    expect(en).toContain('"workbench.chat.split_hint"')
  })
})
