// Token mode (a fresh install, before a dashboard login exists): <img> cannot send the
// Authorization header, so /api/ pictures answered 401 and showed broken. The fix lives in
// web/app.js as a capture-phase `error` listener; this pins its contract (source-contract style,
// like the other app.js tests), because the behaviour is only visible in a real browser.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const app = readFileSync(join(__dirname, '..', '..', 'web', 'app.js'), 'utf-8')

describe('token-mode pictures', () => {
  it('retries a failed /api/ <img>/<audio> once per address through the token-adding fetch', () => {
    expect(app).toContain("document.addEventListener('error'")
    expect(app).toContain("el.tagName !== 'IMG' && el.tagName !== 'AUDIO'")
    expect(app).toContain("src.startsWith('/api/')")
    expect(app).toContain('el.dataset.authBlobFor === src')
    expect(app).toContain('window.fetch(src)')
  })
  it('does not download whole videos and keeps the cache bounded', () => {
    expect(app).not.toMatch(/tagName !== 'VIDEO'/)
    expect(app).toContain('authBlobCache.size > 80')
    expect(app).toContain('URL.revokeObjectURL(authBlobCache.get(oldest))')
  })
})

describe('document page save', () => {
  const wb = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.js'), 'utf-8')
  it('sends one save per field at a time (Enter + blur must not duplicate a new line)', () => {
    expect(wb).toContain('WB.dpInflight')
    expect(wb).toContain('function dpSaveNow(el)')
    expect(wb).toContain("if (el.getAttribute('data-wb-saved')) return Promise.resolve(null)")
  })
})
