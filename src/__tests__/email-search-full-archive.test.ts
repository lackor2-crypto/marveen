import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Boss 2026-11-09: a court e-mail was not found by the UI search ("Nincs talalat" after 108 s) although the server
// found it in the all-mail folder. Source contract only; the real check is the browser click-through.
const app = readFileSync(join(__dirname, '..', '..', 'web', 'app.js'), 'utf-8')
const fn = app.slice(app.indexOf('async function emailRunContentSearch('), app.indexOf('function emailUpdateBulkDeleteUI()'))

describe('e-mail full archive search', () => {
  it('Enter / Keresés searches the archive for every scope, not only "content"', () => {
    const form = app.slice(app.indexOf("getElementById('emailSearchForm')"), app.indexOf("getElementById('emailSearchScope')"))
    expect(form).toContain('emailRunContentSearch(input?.value)')
    expect(form).not.toContain("=== 'content'")
  })
  it('uses the all-mail folder with bounded concurrency and reports failures', () => {
    expect(fn).toContain("emailMailboxRole(m) === 'all'")
    expect(fn).toContain('Math.min(3, names.length)')
    expect(fn).toContain("t('email.search_failed'")
  })
  it('a failed mailbox read is not cached as empty', () => {
    expect(app).toContain('if (Array.isArray(list)) emailScopedMailboxCache[cacheKey] = result')
  })
})
