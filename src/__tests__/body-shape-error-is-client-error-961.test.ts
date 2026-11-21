import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { isBodyShapeError } from '../web/malformed-body.js'

// #961: a fuzz run of 169 write endpoints found 57 answering 500 for a well-formed body of the wrong shape.
describe('isBodyShapeError', () => {
  const real = (fn: () => void): unknown => { try { fn(); return null } catch (e) { return e } }
  it('recognises the real V8 shape failures on a write with a body', () => {
    const nul: any = null
    const num: any = 5
    expect(isBodyShapeError(real(() => nul.project), 'POST', '4')).toBe(true)
    expect(isBodyShapeError(real(() => num.trim()), 'PUT', '12')).toBe(true)
    expect(isBodyShapeError(real(() => { const { a } = nul; return a }), 'POST', '4')).toBe(true)
    expect(isBodyShapeError(real(() => { for (const _x of nul as any) { /* */ } }), 'POST', '2')).toBe(true)
  })
  it('leaves our own bugs, reads and body-less requests as 500', () => {
    const nul: any = null
    const e = real(() => nul.project)
    expect(isBodyShapeError(e, 'GET', '4')).toBe(false)
    expect(isBodyShapeError(e, 'POST', undefined)).toBe(false)
    expect(isBodyShapeError(e, 'POST', '0')).toBe(false)
    expect(isBodyShapeError(new Error('Cannot read properties of null'), 'POST', '4')).toBe(false)
    expect(isBodyShapeError(new TypeError('fetch failed'), 'POST', '4')).toBe(false)
  })
  it('is wired into the top-level catch before the generic 500', () => {
    const src = readFileSync(fileURLToPath(new URL('../web.ts', import.meta.url)), 'utf8')
    const i400 = src.search(/if \(isBodyShapeError\(err[\s\S]{0,900}?\}, 400\)/)
    const i500 = src.indexOf("json(res, { error: 'Szerver hiba' }, 500)")
    expect(i400).toBeGreaterThan(-1)
    expect(i500).toBeGreaterThan(i400)
  })
})

// The six handlers that catch their own errors never reach the top-level catch: a `null` body must fall through to
// their own validation (a 400), not be destructured. Fuzz on 2026-11-22: all six answered 500 for the body `null`.
describe('handlers with their own try/catch tolerate a null body', () => {
  const cases: Array<[string, string]> = [
    ['../web/routes/autonomy.ts', 'const { key, level } = JSON.parse(body.toString()) ?? {}'],
    ['../web/routes/autonomy.ts', 'const { agent, admin } = JSON.parse(body.toString()) ?? {}'],
    ['../web/routes/connectors-hu.ts', '(JSON.parse(body.toString()) ?? {}) as { token: string }'],
    ['../web/routes/settings.ts', 'const { key, value, actor } = JSON.parse(body.toString()) ?? {}'],
    ['../web/routes/vault-ssh.ts', 'const data = JSON.parse(body.toString()) ?? {}'],
    ['../web/routes/debate-run.ts', "body = JSON.parse((await readBody(req)).toString()) ?? {}"],
  ]
  for (const [file, needle] of cases) {
    it(`${file}: ${needle.slice(0, 40)}`, () => {
      expect(readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8')).toContain(needle)
    })
  }
})
