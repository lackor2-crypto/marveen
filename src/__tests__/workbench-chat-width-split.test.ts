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
    expect(js).toMatch(/applyChatWidth\(w0 - \(ev\.clientX - x0\), true\)/)
    expect(css).toMatch(/\.wb-fr-chatsplit \{[^}]*cursor: col-resize/)
  })
})
