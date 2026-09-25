// #396 Phase 3 -- Settings -> Backup on a phone-sized screen, in a real
// browser. Served statically (see bridgehu813.spec.ts for why a second
// dashboard is never booted on the owner's machine); the page is reached the
// way the product reaches it -- the app's own router and settings-tab builder.
//
// What is measured: the tab exists, every section renders, the main button is
// visible without scrolling sideways, and nothing overflows the viewport width.
// Run: CHROMIUM_BIN=<chrome> npx playwright test -c playwright.browser.config.ts backup-mobile
import { test, expect } from '@playwright/test'

const STATUS = {
  health: { id: 'backup_single_copy', status: 'warn', params: { h: 2 } },
  loginOn: true,
  state: {
    lastRun: { at: Date.now() - 2 * 3600e3, kind: 'manual', ok: true, durationMs: 11000 },
    lastSuccessAt: Date.now() - 2 * 3600e3,
    lastSuccessName: 'marveen-backup-20260925-212011-desktop-g1r2rin.mbk',
    replicas: { local: { at: Date.now(), ok: true, reachable: true }, depot: { at: Date.now(), ok: false, reachable: false, reason: 'depot_unreachable' } },
    lastVerify: null,
  },
  config: { depot: { enabled: null }, cloud: { kind: 'gdrive', account: 'owner@example.com', folderName: null }, schedule: { enabled: true, time: '03:30' }, includeLogs: false },
  destinations: [
    { id: 'local', kind: 'local', enabled: true, where: '/home/x/marveen/store/backups' },
    { id: 'depot', kind: 'depot', enabled: true, where: '/mnt/f/Marveen/Rendszer/Marveen/Mentések' },
    { id: 'cloud', kind: 'gdrive', enabled: true, where: 'owner@example.com / Marveen mentések', account: 'owner@example.com', folderName: 'Marveen mentések' },
  ],
  defaultCloudFolder: 'Marveen mentések',
  key: { exists: true, keyId: 'ab12cd34', createdAt: '2026-09-25T19:20:11.000Z', confirmedAt: null, custom: false, previous: 0 },
  running: null,
}
const LIST = {
  backups: [
    { name: 'marveen-backup-20260925-212011-desktop-g1r2rin.mbk', size: 30562198, time: Date.now() - 2 * 3600e3, where: ['local', 'cloud'], kind: 'manual', verified: true },
    { name: 'marveen-backup-20260924-033000-desktop-g1r2rin.mbk', size: 30412198, time: Date.now() - 26 * 3600e3, where: ['local'], kind: 'pre-restore', verified: null },
  ],
  sources: { local: { ok: true, count: 2 }, depot: { ok: false, reachable: false, reason: 'depot_unreachable' }, cloud: { ok: true, count: 1 } },
}
const ACCOUNTS = { accounts: [{ kind: 'gdrive', account: 'owner@example.com', label: 'owner@example.com' }, { kind: 'mega', account: 'owner', label: 'owner@example.com' }] }

for (const lang of ['hu', 'en'] as const) {
  test(`backup tab on a phone (${lang})`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    const ok = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
    await page.route('**/api/**', (r) => r.fulfill(ok({})))
    await page.route('**/api/settings', (r) => r.fulfill(ok({ settings: [] })))
    await page.route('**/api/auth/status', (r) => r.fulfill(ok({ method: 'token', authenticated: true })))
    await page.route('**/api/backup/status**', (r) => r.fulfill(ok(STATUS)))
    await page.route('**/api/backup/list**', (r) => r.fulfill(ok(LIST)))
    await page.route('**/api/backup/cloud-accounts**', (r) => r.fulfill(ok(ACCOUNTS)))
    await page.addInitScript((l) => {
      try { localStorage.setItem('marveen.lang', l); localStorage.setItem('settings-active-tab', 'backup') } catch { /* ignore */ }
    }, lang)
    await page.goto('/index.html')
    await page.evaluate(async (l) => {
      const w = window as any
      w._lang = l
      w.switchPage('settings')
      await w.loadSettings()
    }, lang)
    const run = page.locator('#backupPanel [data-bk="run"]')
    await run.waitFor({ state: 'visible' })
    await expect(page.locator('#settingsTabNav .tab-btn[data-tab="backup"]')).toHaveCount(1)
    for (const sel of ['[data-bk="kit-show"]', '[data-bk="depot-toggle"]', '#bkCloudAcc', '#bkTime', '[data-bk="download"]']) {
      await expect(page.locator(`#backupPanel ${sel}`).first(), sel).toBeAttached()
    }
    const panelText = await page.locator('#backupPanel').innerText()
    expect(panelText).toContain('F:\\Marveen')
    expect(panelText).not.toMatch(/\bfbk\./)
    // Nothing wider than the phone: no sideways scrolling on the panel.
    const overflow = await page.evaluate(() => {
      const host = document.getElementById('backupPanel')!
      const out: string[] = []
      host.querySelectorAll('*').forEach((el) => {
        const r = (el as HTMLElement).getBoundingClientRect()
        if (r.width > 0 && r.right > window.innerWidth + 1) out.push(`${el.tagName}.${(el as HTMLElement).className} right=${Math.round(r.right)}`)
      })
      return out
    })
    expect(overflow, overflow.join('\n')).toEqual([])
    const box = await run.boundingBox()
    expect(box!.x + box!.width).toBeLessThanOrEqual(390)
    await page.screenshot({ path: `test-results/backup-mobile-${lang}.png`, fullPage: true })
    expect(errors, errors.join(' | ')).toEqual([])
  })
}
