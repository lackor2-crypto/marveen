// Boss TG 3193: the line between the middle area and the chat drags sideways; width kept per browser.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const js = readFileSync(join(__dirname, '../../web/workbench.js'), 'utf8')
const css = readFileSync(join(__dirname, '../../web/workbench.css'), 'utf8')

describe('chat width handle', () => {
  it('renders a vertical separator before the chat and restores the saved width', () => {
    expect(js).toMatch(/id="wbChatWidthSplit" role="separator" aria-orientation="vertical"/)
    expect(js).toContain("CHAT_WIDTH_KEY = 'marveen.workbench.chatWidth'")
    expect(js).toMatch(/applyChatWidth\(w0 \+ dir \* \(ev\.clientX - x0\), true\)/)
    // #595: the manual split view has the same divider, the chat on its left
    expect(js).toMatch(/wb-split-divider/)
    expect(css).toMatch(/\.wb-fr-chatsplit \{[^}]*cursor: col-resize/)
  })
  it('keeps the width in a CSS variable, never as an inline flex (the narrow column layout would read it as a height)', () => {
    expect(js).not.toMatch(/chat\.style\.flex\s*=\s*'0 0 '/)
    expect(js).not.toContain("style=\"flex:0 0 ' + WB.chatWidth")
    expect(js).toContain("--wb-chat-w")
    expect(css).toMatch(/\.wb-fr-chat \{ flex-basis: var\(--wb-chat-w, 340px\); max-width: calc\(100% - 360px\); \}/)
    expect(css).toMatch(/@media \(max-width: 900px\) \{ \.wb-fr-chat \{ flex-basis: auto; max-width: none; \} \}/)
  })
  // #595: measured in a real browser (1400x800): the manual frame's top sat 372px down, so the chat's input line
  // (bottom of the window-high frame) was at y=1004 and only showed after a scroll. The frame is brought to the top
  // of the window once per opened work, as the Simple view does; a phone (stacked columns) is left alone.
  it('brings the manual split frame to the top of the window once per opened work, so the chat input is on the screen', () => {
    expect(js).toMatch(/function revealSplitFrame\(\) \{[\s\S]*?window\.innerWidth <= 900\) return[\s\S]*?WB\.splitRevealKey === WB\.selectedId[\s\S]*?scrollIntoView\(\{ block: 'start' \}\)/)
    expect(js).toMatch(/fitSavedChatSplit\(\)\n\s+revealSplitFrame\(\)/)
    expect(css).toMatch(/\.wb-split \{[^}]*scroll-margin-top: 8px/)
  })
})
