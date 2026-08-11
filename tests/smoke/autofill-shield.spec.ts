/**
 * Autofill shield smoke tests (web/app.js, "=== Autofill shield ===").
 *
 * Prerequisites: the dashboard must be running and DASHBOARD_TOKEN must be set.
 *   DASHBOARD_TOKEN=$(cat store/.dashboard-token) npm run smoke
 *
 * What these catch: the regression that started this -- Chrome filling the
 * credentials saved for the dashboard itself into the Vault "new key" panel
 * (username into DESCRIPTION, password into VALUE) and into the email search
 * box. A browser's autofill cannot be driven from a test, so these assert the
 * conditions that make it impossible instead: the opt-out attributes are on the
 * field, and an empty unfocused field is readonly (Chrome never autofills a
 * readonly field). They also pin the three things the shield must NOT break:
 * typing still works, a deliberately-readonly field stays readonly, and the
 * real login fields keep their credential autocomplete.
 */

import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'

const TOKEN = process.env.DASHBOARD_TOKEN || ''

async function shieldState(page: Page, selector: string) {
  return page.$eval(selector, (el) => {
    const input = el as HTMLInputElement
    return {
      autocomplete: input.getAttribute('autocomplete'),
      onePassword: input.hasAttribute('data-1p-ignore'),
      lastPass: input.getAttribute('data-lpignore'),
      bitwarden: input.hasAttribute('data-bwignore'),
      formType: input.getAttribute('data-form-type'),
      readOnly: input.readOnly,
      value: input.value,
    }
  })
}

test.describe('Autofill shield', () => {
  test('vault "new key" panel: description and value fields are opted out and locked while empty', async ({ page }) => {
    await page.goto(`/?token=${TOKEN}#vault`)
    await page.click('#vaultPageNewBtn')
    await expect(page.locator('#vaultAddPanel')).toBeVisible()

    // The description box is the one that received the saved username.
    const desc = await shieldState(page, '#vaultPageLabelInput')
    expect(desc.autocomplete).toBe('off')
    expect(desc.onePassword).toBe(true)
    expect(desc.lastPass).toBe('true')
    expect(desc.bitwarden).toBe(true)
    expect(desc.formType).toBe('other')
    expect(desc.readOnly).toBe(true)
    expect(desc.value).toBe('')

    // The value box is the one that received the saved dashboard password.
    // "off" is not enough on a password field -- Chrome ignores it there and
    // honours "new-password", so that is what the shield must set.
    const value = await shieldState(page, '#vaultPageValueInput')
    expect(value.autocomplete).toBe('new-password')
    expect(value.readOnly).toBe(true)
    expect(value.value).toBe('')
  })

  test('locked fields still accept typing the moment they are used', async ({ page }) => {
    await page.goto(`/?token=${TOKEN}#vault`)
    await page.click('#vaultPageNewBtn')

    await page.click('#vaultPageLabelInput')
    await page.keyboard.type('OpenAI production key')
    await expect(page.locator('#vaultPageLabelInput')).toHaveValue('OpenAI production key')
    expect(await page.$eval('#vaultPageLabelInput', (el) => (el as HTMLInputElement).readOnly)).toBe(false)

    // A field with content stays writable after blur -- only empty ones re-lock.
    await page.click('#vaultPageIdInput')
    expect(await page.$eval('#vaultPageLabelInput', (el) => (el as HTMLInputElement).readOnly)).toBe(false)
  })

  test('email search box is opted out and locked while empty', async ({ page }) => {
    await page.goto(`/?token=${TOKEN}`)
    const search = await shieldState(page, '#emailSearchInput')
    expect(search.autocomplete).toBe('off')
    expect(search.onePassword).toBe(true)
    expect(search.readOnly).toBe(true)
    expect(search.value).toBe('')
  })

  test('fields rendered after load are shielded too (MutationObserver)', async ({ page }) => {
    await page.goto(`/?token=${TOKEN}`)
    const state = await page.evaluate(async () => {
      const host = document.createElement('div')
      host.innerHTML = '<input id="afsLateField" type="text"><input id="afsLatePass" type="password">'
      document.body.appendChild(host)
      // MutationObserver callbacks run as a microtask; yield once.
      await new Promise((r) => setTimeout(r, 0))
      const text = document.getElementById('afsLateField') as HTMLInputElement
      const pass = document.getElementById('afsLatePass') as HTMLInputElement
      return {
        textAutocomplete: text.getAttribute('autocomplete'),
        textReadOnly: text.readOnly,
        passAutocomplete: pass.getAttribute('autocomplete'),
        passReadOnly: pass.readOnly,
      }
    })
    expect(state.textAutocomplete).toBe('off')
    expect(state.textReadOnly).toBe(true)
    expect(state.passAutocomplete).toBe('new-password')
    expect(state.passReadOnly).toBe(true)
  })

  test('a deliberately readonly field is never unlocked by the shield', async ({ page }) => {
    await page.goto(`/?token=${TOKEN}`)
    const stillReadOnly = await page.evaluate(async () => {
      const el = document.createElement('input')
      el.type = 'text'
      el.id = 'afsLockedByOwner'
      el.readOnly = true
      document.body.appendChild(el)
      await new Promise((r) => setTimeout(r, 0))
      el.focus()
      el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
      return el.readOnly
    })
    expect(stillReadOnly).toBe(true)
  })

  test('fields that ask for a credential on purpose keep their autocomplete', async ({ page }) => {
    await page.goto(`/?token=${TOKEN}`)
    const kept = await page.evaluate(async () => {
      const host = document.createElement('div')
      host.innerHTML =
        '<input id="afsUser" type="text" autocomplete="username">' +
        '<input id="afsPass" type="password" autocomplete="current-password">'
      document.body.appendChild(host)
      await new Promise((r) => setTimeout(r, 0))
      const user = document.getElementById('afsUser') as HTMLInputElement
      const pass = document.getElementById('afsPass') as HTMLInputElement
      return {
        user: user.getAttribute('autocomplete'),
        userReadOnly: user.readOnly,
        pass: pass.getAttribute('autocomplete'),
        passReadOnly: pass.readOnly,
      }
    })
    expect(kept.user).toBe('username')
    expect(kept.userReadOnly).toBe(false)
    expect(kept.pass).toBe('current-password')
    expect(kept.passReadOnly).toBe(false)
  })
})
