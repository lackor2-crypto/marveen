// TG 3142: an arrow folds the chat's settings, folder and account rows away.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
const rd = (p: string) => readFileSync(new URL(`../../web/${p}`, import.meta.url), 'utf8')
const js = rd('workbench.js')
describe('chat head fold', () => {
  it('the arrow, the folded rendering and the remembered state exist', () => {
    expect(js).toContain('data-wb-act="chat-head-fold"')
    expect(js).toContain("a === 'chat-head-fold'")
    expect(js).toContain('(shut ? \'\' : chatSideHtml() + chatAccountHtml()')
    expect(js).toContain('marveen.workbench.chatHeadShut')
  })
  it('both languages have the arrow hints', () => {
    for (const f of ['lang/hu.js', 'lang/en.js']) {
      expect(rd(f)).toContain('"workbench.chat.head_shut"')
      expect(rd(f)).toContain('"workbench.chat.head_open"')
    }
  })
})
