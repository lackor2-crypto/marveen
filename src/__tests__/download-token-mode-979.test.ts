// #979: in token mode a page navigation (window.open / <a href target=_blank>) cannot send the Authorization
// header, so a file Download showed {"error":"Unauthorized"}. The behaviour is proven in a real browser by
// tests/browser/download-token-mode-979.spec.ts; this guards the wiring and both language strings.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(__dirname, '..', '..')
const app = readFileSync(join(root, 'web/app.js'), 'utf8')

describe('#979 download carries the token', () => {
  it('overrides window.open for /api/ downloads and routes it through the token-adding fetch', () => {
    expect(app).toContain('window.open = function (url, target, features)')
    expect(app).toMatch(/startsWith\('\/api\/'\) && \/\[\?&\]download=1/)
    expect(app).toContain('async function apiNavigate(url, download, nameHint)')
    expect(app).toContain('const res = await window.fetch(url)')
  })
  it('handles <a href=/api/...> clicks in the capture phase', () => {
    expect(app).toMatch(/void apiNavigate\(href, wantsDownload, a\.getAttribute\('download'\) \|\| ''\)\n  \}, true\)/)
  })
  it('has the failure message in both languages', () => {
    for (const f of ['hu', 'en']) {
      expect(readFileSync(join(root, `web/lang/${f}.js`), 'utf8')).toContain("'intezo.open_failed'")
    }
  })
})
