// #396 Phase 3 -- Settings -> Backup on a phone-sized screen, in a real
// browser. Served statically (see bridgehu813.spec.ts for why a second
// dashboard is never booted on the owner's machine); the page is reached the
// way the product reaches it -- the app's own router and settings-tab builder.
//
// What is measured: the tab exists, every section renders, the main button is
// visible without scrolling sideways, and nothing overflows the viewport width.
// Run: CHROMIUM_BIN=<chrome> npx playwright test -c playwright.browser.config.ts backup-mobile
import { test, expect } from '@playwright/test'

// index.html pulls xterm/qrcode from cdn.jsdelivr.net in <head>. On a machine
// that cannot reach the CDN the render-blocking stylesheet never arrives, the
// browser never paints a frame, and every click/screenshot waits for ever
// (measured 2026-09-25: requestAnimationFrame stalled on main's own front end
// too). None of it is under test here, so it is answered locally and empty.
// Screenshots need painted frames. On 2026-09-25 23:5x headless Chrome on the
// owner's WSL stopped producing frames altogether (requestAnimationFrame never
// fired even on a blank page, every build and flag tried) -- so the layout is
// measured synchronously (getBoundingClientRect), clicks are dispatched, and a
// picture is taken only when the browser can paint one.
async function shot(loc: import('@playwright/test').Locator, path: string) {
  try { await loc.screenshot({ path, timeout: 8_000, animations: 'disabled' }) } catch { /* no painted frames here */ }
}

test.beforeEach(async ({ page }) => {
  await page.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, (r) => r.fulfill({ status: 200, contentType: r.request().resourceType() === 'stylesheet' ? 'text/css' : 'application/javascript', body: '' }))
})

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
    // One real-shaped setting: with an EMPTY list loadSettings builds no tabs at
    // all (it shows "no settings" and returns), so the Backup tab never appears.
    await page.route('**/api/settings', (r) => r.fulfill(ok({ settings: [
      { key: 'SCHEDULER_TZ', module: 'system', type: 'string', value: 'Europe/Budapest', default: 'Europe/Budapest', description: 'tz', requiresRestart: false },
    ] })))
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
    await shot(page.locator('#backupPanel'), `test-results/backup-mobile-${lang}.png`)
    expect(errors, errors.join(' | ')).toEqual([])
  })
}

const PREVIEW = {
  previewId: 'p1', confirm: 'user_password', createdAt: '2026-09-25T21:20:11+02:00', appVersion: '1.29.0', compat: { ok: true, needsMigration: false },
  categories: [
    { id: 'database', files: 1, willOverwrite: 1, willAdd: 0, held: 0 },
    { id: 'depot-config', files: 10, willOverwrite: 2, willAdd: 8, held: 0 },
    { id: 'secrets', files: 22, willOverwrite: 3, willAdd: 10, held: 9 },
    { id: 'skills', files: 300, willOverwrite: 37, willAdd: 263, held: 0 },
  ],
  optional: ['skills', 'schedules', 'agents', 'depot-config', 'knowledge', 'memory', 'settings', 'secrets'],
  dbCounts: { backup: { kanban_cards: 412, memories: 1893, projects: 12 }, current: { kanban_cards: 0, memories: 0, projects: 0 } },
  warnings: [{ code: 'old_paths', items: ['project/store/some-very-long-settings-file-name-that-could-overflow.json'] }],
  needsLogin: ['main', 'lackor3', 'usalackor', 'gypsy'], freshInstall: false, bytes: { payload: 1, free: 10, enough: true },
  pathMoved: true, agents: ['lackor3'], keyId: 'ab12cd34',
}

async function noOverflow(page: import('@playwright/test').Page, rootSel: string) {
  return page.evaluate((sel) => {
    const out: string[] = []
    document.querySelectorAll(sel + ' *').forEach((el) => {
      const r = (el as HTMLElement).getBoundingClientRect()
      if (r.width > 0 && r.right > window.innerWidth + 1) out.push(`${el.tagName}.${(el as HTMLElement).className} right=${Math.round(r.right)}`)
    })
    return out
  }, rootSel)
}

test('restore preview + held banner on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  const ok = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  await page.route('**/api/**', (r) => r.fulfill(ok({})))
  await page.route('**/api/settings', (r) => r.fulfill(ok({ settings: [{ key: 'SCHEDULER_TZ', module: 'system', type: 'string', value: 'x', default: 'x', description: 'tz', requiresRestart: false }] })))
  await page.route('**/api/auth/status', (r) => r.fulfill(ok({ method: 'token', authenticated: true })))
  await page.route('**/api/backup/status**', (r) => r.fulfill(ok(STATUS)))
  await page.route('**/api/backup/list**', (r) => r.fulfill(ok(LIST)))
  await page.route('**/api/backup/cloud-accounts**', (r) => r.fulfill(ok(ACCOUNTS)))
  await page.route('**/api/backup/restore/status**', (r) => r.fulfill(ok({ running: false, result: null, channelsHeld: true })))
  await page.route('**/api/backup/restore/open**', (r) => r.fulfill(ok(PREVIEW)))
  await page.addInitScript(() => { try { localStorage.setItem('marveen.lang', 'hu'); localStorage.setItem('settings-active-tab', 'backup') } catch { /* ignore */ } })
  await page.goto('/index.html')
  await page.evaluate(async () => { const w = window as any; w._lang = 'hu'; w.switchPage('settings'); await w.loadSettings() })
  await page.locator('#bkRestoreHost [data-bk="r-release"]').waitFor({ state: 'visible' })
  await page.locator('#backupPanel [data-bk="r-open"]').first().dispatchEvent('click')
  await page.locator('#bkRestoreHost [data-bk="r-start"]').waitFor({ state: 'visible' })
  expect(await page.locator('#bkRestoreHost').innerText()).toContain('412')
  expect(await noOverflow(page, '#backupPanel')).toEqual([])
  await shot(page.locator('#bkRestoreHost'), 'test-results/backup-restore-preview-hu.png')
  expect(errors, errors.join(' | ')).toEqual([])
})

test('fresh-install question on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  const ok = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  await page.route('**/api/**', (r) => r.fulfill(ok({})))
  await page.route('**/api/auth/status', (r) => r.fulfill(ok({ method: 'token', authenticated: true })))
  await page.route('**/api/backup/onboarding**', (r) => r.fulfill(ok(r.request().method() === 'GET' ? { ask: true } : { ok: true })))
  await page.route('**/api/backup/restore/status**', (r) => r.fulfill(ok({ running: false, result: null, channelsHeld: false })))
  await page.addInitScript(() => { try { localStorage.setItem('marveen.lang', 'hu') } catch { /* ignore */ } })
  await page.goto('/index.html')
  const yes = page.locator('.bk-wizard [data-bk="w-restore"]')
  await yes.waitFor({ state: 'visible' })
  expect(await noOverflow(page, '.bk-wizard')).toEqual([])
  await yes.dispatchEvent('click')
  await page.locator('.bk-wizard [data-bk="r-file"]').waitFor({ state: 'attached' })
  expect(await noOverflow(page, '.bk-wizard')).toEqual([])
  await shot(page.locator('.bk-wizard-card'), 'test-results/backup-wizard-hu.png')
  expect(errors, errors.join(' | ')).toEqual([])
})
