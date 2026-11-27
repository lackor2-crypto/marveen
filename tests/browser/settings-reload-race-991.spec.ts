// Two overlapping builds of the Settings page (the router starts one, a button or a deep link starts another before the
// first answered). The one that answers last used to wipe the panels again and destroy the login card the other had
// already moved into the Security panel; a login render still in flight then threw "reading 'addEventListener'".
// Served statically, like backup-mobile.spec.ts.
import { test, expect } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, (r) => r.fulfill({ status: 200, contentType: r.request().resourceType() === 'stylesheet' ? 'text/css' : 'application/javascript', body: '' }))
})

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms))

for (const outcome of ['answers', 'fails'] as const) {
  test(`the login card survives a second settings load that ${outcome} late`, async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.stack || e.message))
    const ok = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
    await page.route('**/api/**', (r) => r.fulfill(ok({})))
    let armed = false
    let n = 0
    await page.route('**/api/settings', async (r) => {
      const mine = armed ? ++n : 0
      // The first of the two answers early, the second late.
      if (mine === 2) await pause(900)
      else if (mine === 1) await pause(150)
      if (mine === 2 && outcome === 'fails') return r.fulfill({ status: 500, body: '' })
      await r.fulfill(ok({ settings: [{ key: 'SCHEDULER_TZ', module: 'system', type: 'string', value: 'Europe/Budapest', default: 'Europe/Budapest', description: 'tz', requiresRestart: false }] }))
    })
    await page.route('**/api/auth/status', async (r) => { if (armed) await pause(500); await r.fulfill(ok({ method: 'token', authenticated: true })) })
    await page.goto('/index.html')
    await page.evaluate(() => (window as any).switchPage('overview'))
    armed = true
    await page.evaluate(async () => {
      const w = window as any
      const first = w.loadSettings()
      const second = w.loadSettings()
      await Promise.all([first, second])
    })
    await pause(900)
    await expect(page.locator('#authCard')).toHaveCount(1)
    await expect(page.locator('#authCardBody #authResetUser')).toHaveCount(1)
    if (outcome === 'answers') await expect(page.locator('#settings-panel-security #authCard')).toHaveCount(1)
    expect(errors, errors.join(' | ')).toEqual([])
  })
}
