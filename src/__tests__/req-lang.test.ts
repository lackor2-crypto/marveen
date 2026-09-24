import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type http from 'node:http'
import { reqLang, L } from '../web/http-helpers.js'

// #376: Iroda server messages (depot, storages, Drive, email) follow the UI
// language. The dashboard's fetch wrapper sends it as `X-Ui-Lang`.
function req(headers: Record<string, string> = {}): http.IncomingMessage {
  return { headers } as unknown as http.IncomingMessage
}

describe('reqLang', () => {
  it('prefers ?lang= over the header', () => {
    expect(reqLang(req({ 'x-ui-lang': 'hu' }), new URL('http://x/api/a?lang=en'))).toBe('en')
  })
  it('uses the X-Ui-Lang header when there is no ?lang=', () => {
    expect(reqLang(req({ 'x-ui-lang': 'en' }), new URL('http://x/api/a'))).toBe('en')
    expect(reqLang(req({ 'x-ui-lang': 'hu' }), new URL('http://x/api/a'))).toBe('hu')
  })
  it('ignores unknown values and falls back to hu or en', () => {
    expect(['hu', 'en']).toContain(reqLang(req({ 'x-ui-lang': 'de' })))
  })
  it('does not throw on a request without headers (route tests pass bare mocks)', () => {
    expect(['hu', 'en']).toContain(reqLang({} as unknown as http.IncomingMessage))
  })
  it('L picks the sentence for the language', () => {
    expect(L('en', 'magyar', 'english')).toBe('english')
    expect(L('hu', 'magyar', 'english')).toBe('magyar')
  })
})

describe('dashboard fetch wrapper', () => {
  it('sends the UI language on every same-origin API call', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'web', 'app.js'), 'utf8')
    expect(src).toMatch(/lh\.set\('X-Ui-Lang', window\._lang === 'en' \? 'en' : 'hu'\)/)
  })
})
