// Card #412 (owner, TG 6597, 2026-09-26): the sign-in box gets a small eye
// that shows the typed password -- on a phone keyboard a typo is otherwise
// invisible. Checked in a real browser at 390px; this pins the wiring.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const app = readFileSync(join(root, 'web', 'app.js'), 'utf8')
const css = readFileSync(join(root, 'web', 'style.css'), 'utf8')

describe('sign-in password eye (#412)', () => {
  it('the eye sits next to the password field, as a non-submitting button', () => {
    const i = app.indexOf('id="mv-login-pass"')
    const eye = app.indexOf('id="mv-login-eye"')
    expect(i).toBeGreaterThan(-1)
    expect(eye).toBeGreaterThan(i)
    expect(app.slice(eye - 80, eye)).toContain('type="button"')
    expect(app.slice(eye, eye + 200)).toContain('aria-pressed="false"')
  })

  it('clicking flips the field between password and text and relabels itself', () => {
    const h = app.slice(app.indexOf("eyeEl.addEventListener('click'"), app.indexOf("eyeEl.addEventListener('click'") + 600)
    expect(h).toMatch(/passEl\.type = show \? 'text' : 'password'/)
    expect(h).toContain("'auth.login.hide_password'")
    expect(h).toContain("'auth.login.show_password'")
  })

  it('the eye is not painted as the orange submit button', () => {
    expect(css).toMatch(/\.mv-auth-card \.mv-pass-eye \{[^}]*background: transparent/)
  })

  it('both languages have the labels', () => {
    for (const f of ['hu.js', 'en.js']) {
      const lang = readFileSync(join(root, 'web', 'lang', f), 'utf8')
      expect(lang).toContain("'auth.login.show_password'")
      expect(lang).toContain("'auth.login.hide_password'")
    }
  })
})
