// One missing `}` in web/style.css silently drops EVERY rule after it: the
// browser swallows the rest of the file into the open block. It happened
// (the autofill rule, card 21311fdb) and the Git repositories and Inbox card
// styles were dead for weeks while every other test stayed green.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('web/style.css', () => {
  it('every block is closed (no rule is swallowed by an unclosed brace)', () => {
    const raw = readFileSync(join(__dirname, '..', '..', 'web', 'style.css'), 'utf8')
    const lines = raw.replace(/\/\*[\s\S]*?\*\//g, (c) => '\n'.repeat(c.split('\n').length - 1)).split('\n')
    const open: number[] = []
    lines.forEach((line, i) => {
      for (const ch of line) {
        if (ch === '{') open.push(i + 1)
        else if (ch === '}') {
          expect(open.length, `stray "}" on line ${i + 1}`).toBeGreaterThan(0)
          open.pop()
        }
      }
    })
    expect(open, 'unclosed "{" opened on these lines').toEqual([])
  })
})
