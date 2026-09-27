// Card #412 check (2026-09-27): the "I don't know my password" steps sat
// INSIDE the sign-in <form>, so Enter/Go in the code or new-password field ran
// the Sign in submit -- an empty-fields error at the top, or a real failed
// login against the brake -- and /api/auth/recovery/verify was never called.
// Measured in Chromium at 390px with a mocked API, before and after the fix.
// These pin the structure that makes Enter submit the step on screen.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const app = readFileSync(join(root, 'web', 'app.js'), 'utf8')
const css = readFileSync(join(root, 'web', 'style.css'), 'utf8')

const start = app.indexOf('function showLoginOverlay(')
const tplStart = app.indexOf('overlay.innerHTML =', start)
const tplEnd = app.indexOf('document.body.appendChild(overlay)', tplStart)
const tpl = app.slice(tplStart, tplEnd)
const body = app.slice(start, app.indexOf('setTimeout(() => userEl.focus(), 50)', start))

/** The markup between a form's opening tag (found by id) and its closing tag. */
function formBody(id: string): string {
  const open = tpl.indexOf('id="' + id + '"')
  expect(open).toBeGreaterThan(-1)
  const tagStart = tpl.lastIndexOf('<form', open)
  expect(tagStart).toBeGreaterThan(-1)
  expect(tpl.slice(tagStart, open)).not.toContain('>')
  return tpl.slice(open, tpl.indexOf('</form>', open))
}

describe('sign-in overlay: Enter submits the step on screen (#412)', () => {
  it('the template is found', () => {
    expect(start).toBeGreaterThan(-1)
    expect(tpl.length).toBeGreaterThan(500)
    expect(body.length).toBeGreaterThan(tpl.length)
  })

  it('the sign-in form holds only the two fields and their button', () => {
    const f = formBody('mv-login-form')
    expect(f).toContain('id="mv-login-user"')
    expect(f).toContain('id="mv-login-pass"')
    expect(f).toContain('id="mv-login-submit"')
    expect(f).not.toContain('mv-rc-')
    expect(f).not.toContain('mv-login-recover')
    expect(f).not.toContain('mv-login-token')
  })

  it('no form is nested in another one', () => {
    let depth = 0
    for (const m of tpl.matchAll(/<form\b|<\/form>/g)) {
      depth += m[0] === '</form>' ? -1 : 1
      expect(depth).toBeGreaterThanOrEqual(0)
      expect(depth).toBeLessThanOrEqual(1)
    }
    expect(depth).toBe(0)
  })

  it('each recovery step is its own form, with its button as the submit', () => {
    const steps: Array<[string, string, string]> = [
      ['mv-rc-step1', 'id="mv-rc-user"', 'mv-rc-send'],
      ['mv-rc-step2', 'id="mv-rc-code"', 'mv-rc-verify'],
      // The new-password fields come from passField(), eye button included.
      ['mv-rc-step3', "passField('mv-rc-pass2'", 'mv-rc-save'],
    ]
    for (const [form, field, button] of steps) {
      const f = formBody(form)
      expect(f).toContain(field)
      expect(f).toMatch(new RegExp('<button type="submit" id="' + button + '"'))
      // Only one submit per step: the eye buttons must stay type="button".
      expect(f.match(/type="submit"/g)?.length).toBe(1)
    }
  })

  it('the steps run on submit and never let the browser navigate', () => {
    for (const form of ['mv-rc-step1', 'mv-rc-step2', 'mv-rc-step3']) {
      const at = body.indexOf("querySelector('#" + form + "').addEventListener('submit'")
      expect(at, form).toBeGreaterThan(-1)
      expect(body.slice(at, at + 200)).toContain('e.preventDefault()')
    }
    expect(body).not.toContain("rcSend.addEventListener('click'")
    expect(body).not.toContain("querySelector('#mv-rc-verify').addEventListener('click'")
    expect(body).not.toContain("querySelector('#mv-rc-save').addEventListener('click'")
  })

  it('a hidden step stays hidden although its form is a flex column', () => {
    expect(css).toMatch(/\.mv-auth-form \{[^}]*display: flex/)
    expect(css).toMatch(/\.mv-auth-form\[hidden\] \{ display: none; \}/)
    expect(css).toMatch(/#mv-rc-step2\[hidden\]/)
  })
})
