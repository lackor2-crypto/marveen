import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// The Workbench chat sits in a narrow column in both layouts (~270px on
// desktop, ~360px on a phone). With the Send button beside it the message box
// was squeezed to 110-160px and the placeholder broke onto three lines, so in
// both chat columns the box is stacked full width above the button.
const css = fs.readFileSync(path.join(__dirname, '..', '..', 'web', 'workbench.css'), 'utf8')

function ruleFor(selector: string): string {
  const re = new RegExp('([^{}]*' + selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[^{}]*)\\{([^}]*)\\}', 'g')
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(css))) out.push(m[2])
  return out.join(';')
}

describe('Munkapad chat: a szovegmezo nem nyomodik ossze a Kuldes gomb mellett', () => {
  for (const col of ['.wb-grid-chat', '.wb-split-chat']) {
    it(col + ': a mezo teljes szelessegben, a gomb alatta', () => {
      expect(ruleFor(col + ' .wb-chat-row')).toMatch(/flex-direction:\s*column/)
      expect(ruleFor(col + ' .wb-chat-row')).toMatch(/align-items:\s*stretch/)
    })
  }

  it('nincs szelessegi @media mogott: telefonon is egymas alatt allnak', () => {
    const idx = css.indexOf('.wb-grid-chat .wb-chat-row')
    expect(idx).toBeGreaterThan(-1)
    // Count unclosed braces before the rule: 0 means it is top level.
    const before = css.slice(0, idx).replace(/\/\*[\s\S]*?\*\//g, '')
    const depth = (before.match(/\{/g) || []).length - (before.match(/\}/g) || []).length
    expect(depth).toBe(0)
  })
})
