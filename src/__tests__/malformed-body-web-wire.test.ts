import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// #413: the isMalformedBodyError classifier (malformed-body-is-client-error
// test, kept byte-identical with upstream) was here for weeks while src/web.ts
// never called it -- both ends green, the wire missing, and a broken body
// still answered 500. Pin the wire: the top-level catch must consult the
// classifier and turn it into a 400 before the generic 500.
describe('src/web.ts top-level catch uses the classifier', () => {
  it('imports isMalformedBodyError and answers 400 before the 500', () => {
    const src = readFileSync(fileURLToPath(new URL('../web.ts', import.meta.url)), 'utf8')
    expect(src).toMatch(/import \{ isMalformedBodyError \} from '\.\/web\/malformed-body\.js'/)
    const i400 = src.search(/if \(isMalformedBodyError\(err\)\)[\s\S]{0,900}?\}, 400\)/)
    const i500 = src.indexOf("json(res, { error: 'Szerver hiba' }, 500)")
    expect(i400).toBeGreaterThan(-1)
    expect(i500).toBeGreaterThan(i400)
  })
})
