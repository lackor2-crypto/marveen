import { describe, it, expect } from 'vitest'
import { isMalformedBodyError } from '../web/malformed-body.js'

// The two bodies below are not invented shapes: they are the exact failures
// that reached store/dashboard.log on 2026-09-04, one on POST /api/daily-log
// and one on POST /api/kanban. Both answered 500, so every caller-side check
// that looks at the HTTP status read them as "the server broke", and the
// writes were simply gone.
describe('isMalformedBodyError', () => {
  const parseError = (raw: string): unknown => {
    try { JSON.parse(raw); return null } catch (e) { return e }
  }

  it('recognises a raw newline inside a string literal', () => {
    const err = parseError('{"agent_id":"agent","content":"## 14:00 -- Napi\nsor"}')
    expect(err).toBeInstanceOf(SyntaxError)
    expect(isMalformedBodyError(err)).toBe(true)
  })

  it('recognises an unterminated string', () => {
    const err = parseError('{"title":"Kartya cim')
    expect(isMalformedBodyError(err)).toBe(true)
  })

  it('leaves a well-formed body alone', () => {
    expect(parseError('{"ok":true}')).toBeNull()
  })

  it('does not claim our own bugs as the caller"s fault', () => {
    expect(isMalformedBodyError(new TypeError('x is not a function'))).toBe(false)
    expect(isMalformedBodyError(new SyntaxError('Unexpected token in regex'))).toBe(false)
    expect(isMalformedBodyError(new Error('boom'))).toBe(false)
    expect(isMalformedBodyError(undefined)).toBe(false)
  })
})

// #413: the classifier above was here for weeks while src/web.ts never called
// it -- both ends green, the wire missing, and a broken body still answered
// 500. Pin the wire: the top-level catch must consult the classifier and turn
// it into a 400 before the generic 500.
describe('src/web.ts top-level catch uses the classifier', () => {
  it('imports isMalformedBodyError and answers 400 before the 500', async () => {
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const src = readFileSync(fileURLToPath(new URL('../web.ts', import.meta.url)), 'utf8')
    expect(src).toMatch(/import \{ isMalformedBodyError \} from '\.\/web\/malformed-body\.js'/)
    const i400 = src.search(/if \(isMalformedBodyError\(err\)\)[\s\S]{0,900}?\}, 400\)/)
    const i500 = src.indexOf("json(res, { error: 'Szerver hiba' }, 500)")
    expect(i400).toBeGreaterThan(-1)
    expect(i500).toBeGreaterThan(i400)
  })
})
