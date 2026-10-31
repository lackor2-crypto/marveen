// A plain link to /api/life/file carries no Authorization header, so a browser without a sign-in session got
// {"error":"Unauthorized"} (Boss, 2026-10-30). The Workbench click handler must fetch the bytes with the page's auth.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

describe('Workbench file links open through an authenticated fetch', () => {
  const js = readFileSync('web/workbench.js', 'utf8')
  it('intercepts a click on every /api/ link that opens in a new tab (Piszkozat PDF too) and opens a blob', () => {
    expect(js).toContain("closest('a[href^=\"/api/\"]')")
    expect(js).toContain('function openAuthed(')
    expect(js).toContain('res.blob()')
    expect(js).toContain('tab.location.href = url')
  })
  it('the local-program fallback goes through the same path, not a bare window.open', () => {
    expect(js).toContain("a.setAttribute('data-wb-no-local', '1')")
    expect(js).not.toContain("window.open(a.getAttribute('href'), '_blank', 'noopener')")
  })
  it('the draft-PDF language pick and the language switch open the PDF through openAuthed, never a bare window.open of the link', () => {
    expect(js).toContain("openAuthed(rvHref, 'draft.pdf', false, rvTab)")
    expect(js).not.toContain("window.open(rvHref, '_blank', 'noopener')")
    expect(js).not.toContain("else window.open(href, '_blank', 'noopener')")
  })
  it('has the failure message in HU and EN', () => {
    for (const f of ['web/lang/hu.js', 'web/lang/en.js']) expect(readFileSync(f, 'utf8')).toContain('"workbench.file.open_failed"')
  })
})
