// The classic Workbench layout (chat | current work | context) must not let the
// chat box grow wider than its grid column: the flex item's default
// `min-width: auto` let the account select / long tool lines push it into the
// neighbouring panel (Boss, TG 2008). Measured in a real browser at 905-1300px
// while fixing; this test pins the rules that did it (a source contract, it
// cannot see the layout itself).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const css = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.css'), 'utf8')
const rule = (selector: string) => {
  const m = css.match(new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}'))
  return m ? m[1] : ''
}

describe('workbench chat column containment', () => {
  it('the chat box may shrink to its grid column', () => {
    expect(rule('.wb-grid-chat .wb-chat')).toMatch(/min-width:\s*0/)
  })
  it('the account select and status line may shrink too', () => {
    expect(rule('.wb-chat-account')).toMatch(/min-width:\s*0/)
    expect(rule('.wb-chat-account')).not.toMatch(/min-width:\s*12ch/)
    expect(rule('.wb-chat-statusline, .wb-chat-account-row')).toMatch(/min-width:\s*0/)
  })
  it('a long tool command line wraps instead of spilling out', () => {
    expect(rule('.wb-tool')).toMatch(/overflow-wrap:\s*anywhere/)
  })
  it('between 901 and 1100px the context panel drops below instead of poking out of the grid', () => {
    const m = css.match(/@media \(min-width: 901px\) and \(max-width: 1100px\) \{([\s\S]*?)\n\}/)
    expect(m).not.toBeNull()
    expect(m![1]).toMatch(/\.wb-grid-chatfirst\s*\{\s*grid-template-columns:\s*minmax\(220px, 1fr\) minmax\(240px, 1\.6fr\)/)
    expect(m![1]).toMatch(/\.wb-panel-context\s*\{\s*grid-column:\s*1 \/ -1/)
  })
})
