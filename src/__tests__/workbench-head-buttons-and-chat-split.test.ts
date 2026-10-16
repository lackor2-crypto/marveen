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
    expect(js).toContain('In a fixed-height frame (Simple view) the upper strip is squeezed')
  })
  // Measured in a real browser (Simple + Classic view, 1400x900 and 1100x700): the line moves inside the room the two
  // strips share, so dragging never pushes the lower strip (or the input row under it) out of the chat frame.
  it('the line moves inside the shared room: the measured sum is kept and neither strip can vanish', () => {
    const i = js.indexOf('function moveChatSplit(')
    const body = js.slice(i, i + 420)
    expect(body).toContain('var total = startLog + startTools')
    expect(body).toContain('Math.min(total - CHAT_SPLIT_MIN.tools, startLog + dy)')
    expect(body).toContain('applyChatSplit(lh, total - lh, save)')
  })
  it('the remembered sizes are fitted again after a redraw and a window resize, without overwriting the stored ones', () => {
    const fit = js.slice(js.indexOf('function fitSavedChatSplit()'), js.indexOf('function fitSavedChatSplit()') + 400)
    expect(fit).toContain('fitChatSplit(WB.chatSplit.log, WB.chatSplit.tools)')
    expect(fit).not.toContain('WB.chatSplit =')
    expect(js).toContain("el.innerHTML = chatInnerHtml()\n    fitSavedChatSplit()")
    expect(js).toContain('fitFrame()\n    fitSavedChatSplit()')
    expect(js).toContain('if (WB.open) { fitFrame(); fitSavedChatSplit() }')
  })
  it('the hint is in both languages', () => {
    expect(hu).toContain('"workbench.chat.split_hint"')
    expect(en).toContain('"workbench.chat.split_hint"')
  })
})
