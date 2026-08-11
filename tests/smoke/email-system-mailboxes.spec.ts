/**
 * Email system-mailbox smoke test (kanban f27f3ddb).
 *
 * Prerequisites: the dashboard must be running and DASHBOARD_TOKEN must be set.
 *   DASHBOARD_TOKEN=$(cat store/.dashboard-token) npm run smoke
 *
 * What this catches: the report behind the card -- Beérkező / Elküldött / Kuka
 * gone from the top of the first column. Those entries only render when the
 * client's EMAIL_SYSTEM_MAILBOX_ORDER names match the strings the IMAP server
 * actually returns, and a single renamed folder (Gmail localises them) silently
 * demotes a system folder into the "labels" section below 40+ custom ones --
 * which reads as "disappeared". The assertion is therefore about ORDER and
 * PLACEMENT, not mere presence.
 */

import { test, expect } from '@playwright/test'

const TOKEN = process.env.DASHBOARD_TOKEN || ''

test.describe('Email system mailboxes', () => {
  test('the client system list matches the mailboxes the server reports', async ({ page }) => {
    await page.goto(`/?token=${TOKEN}`)
    const accounts = await (await page.request.get('/api/email/accounts', {
      headers: { Authorization: `Bearer ${TOKEN}` },
    })).json()
    expect(Array.isArray(accounts)).toBe(true)
    test.skip(accounts.length === 0, 'no email account configured on this install')

    for (const account of accounts) {
      const res = await page.request.get(`/api/email/mailboxes?account=${encodeURIComponent(account.id)}`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      })
      expect(res.ok()).toBeTruthy()
      const names: string[] = (await res.json()).map((m: { name: string }) => m.name)

      // Read the client's own list rather than hardcoding it here, so this test
      // keeps testing the real contract if the constant is ever edited.
      const clientOrder: string[] = await page.evaluate(() => {
        const w = window as unknown as { EMAIL_SYSTEM_MAILBOX_ORDER?: string[] }
        return w.EMAIL_SYSTEM_MAILBOX_ORDER ?? []
      })
      const order = clientOrder.length ? clientOrder : ['Inbox']

      // Inbox must always resolve -- if this breaks, the column has no top.
      expect(names, `${account.id}: server must expose Inbox`).toContain('Inbox')

      // Every name the client treats as a system folder must exist server-side.
      // A mismatch here is exactly the "folders disappeared" bug: the entry
      // falls through to the custom-label list instead of the top block.
      const missing = order.filter(n => !names.includes(n))
      expect(missing, `${account.id}: client system names not present on the server`).toEqual([])
    }
  })

  test('system folders render above the labels section in the sidebar', async ({ page }) => {
    await page.goto(`/?token=${TOKEN}#email`)
    const pane = page.locator('#emailMailboxList')
    await expect(pane).toBeVisible({ timeout: 15_000 })
    // Wait for the list to replace its loading placeholder.
    await expect(pane.locator('.email-mailbox-item').first()).toBeVisible({ timeout: 20_000 })

    const firstItems = await pane.locator('.email-mailbox-item').evaluateAll(els =>
      els.slice(0, 3).map(el => (el.textContent || '').trim()),
    )
    // The first entries must be system folders, not alphabetically-first custom
    // labels ("Admiral Markets" and friends) -- that inversion is the bug.
    expect(firstItems.length).toBeGreaterThan(0)
    expect(firstItems[0]).toMatch(/Beérkező|Inbox/i)
  })
})
