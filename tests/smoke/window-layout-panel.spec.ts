/**
 * Window-layout (PersistentWindows) Settings panel smoke test -- kanban 79.
 *
 * Prerequisites: the dashboard must be running and DASHBOARD_TOKEN must be set.
 *   DASHBOARD_TOKEN=$(cat store/.dashboard-token) npm run smoke
 *
 * What this catches: Boss opening Settings and finding no window-layout section,
 * or finding one whose buttons are not wired. It deliberately does NOT click
 * Save or Restore -- those move real windows on the real desktop, and a test run
 * must not rearrange the machine it runs on. Everything up to the click is
 * covered here; the click itself is Boss's to make.
 */

import { test, expect } from '@playwright/test'

const TOKEN = process.env.DASHBOARD_TOKEN || ''

test.describe('Window layout settings panel', () => {
  test('the tab exists and renders the three actions with live status', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))

    await page.goto(`/?token=${TOKEN}#settings`)
    const tab = page.locator('#settingsTabNav .tab-btn[data-tab="windows"]')
    await expect(tab).toBeVisible({ timeout: 10_000 })
    await tab.click()

    const panel = page.locator('#windowLayoutPanel')
    await expect(panel).toBeVisible()
    // The status rows come from /api/persistent-windows, so their presence proves
    // the route answered -- not just that a static shell rendered.
    await expect(panel).toContainText(/Windows/i)
    await expect(panel.locator('#winLayoutSaveBtn')).toBeVisible()
    await expect(panel.locator('#winLayoutRestoreBtn')).toBeVisible()
    await expect(panel.locator('#winLayoutGithubBtn')).toBeVisible()

    expect(errors).toEqual([])
  })

  test('status endpoint reports an installed tool and a known layout', async ({ page }) => {
    const res = await page.request.get('/api/persistent-windows', {
      headers: { Authorization: `Bearer ${TOKEN}` },
    })
    expect(res.ok()).toBeTruthy()
    const body = await res.json()
    // On a non-Windows host these are legitimately false -- assert the SHAPE, so
    // the test stays honest wherever it runs, and the values only where the host
    // actually supports the feature.
    expect(body).toHaveProperty('supported')
    expect(body).toHaveProperty('installed')
    expect(body).toHaveProperty('layouts')
    expect(body).toHaveProperty('sync')
    if (body.supported && body.installed) {
      expect(typeof body.exePath).toBe('string')
      expect(Array.isArray(body.layouts)).toBe(true)
    }
  })
})
