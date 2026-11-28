// A .md file opened in a new tab in TOKEN MODE showed broken accented letters. Red on the old app.js (the tab reads the
// blob as windows-1252), green with the byte order mark.
import { test, expect } from '@playwright/test'

const TOKEN = 'test-token-utf8'
const TEXT = 'ékezet: árvíztűrő tükörfúrógép'

test('a utf-8 markdown file opens with its accented letters intact', async ({ page, context }) => {
  await page.route('**/api/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }))
  await page.route('**/api/auth/status', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ method: 'token', authenticated: true }) }))
  await page.route('**/api/life/file**', (r) =>
    r.fulfill({ status: 200, headers: { 'Content-Type': 'text/markdown; charset=utf-8' }, body: Buffer.from(TEXT, 'utf8') }))
  await page.addInitScript((t) => {
    try { localStorage.setItem('marveen-dashboard-token', t) } catch { /* ignore */ }
  }, TOKEN)
  await page.goto('/index.html')
  await page.waitForFunction(() => typeof (window as unknown as { _apiNavigate?: unknown })._apiNavigate === 'function')
  await page.evaluate(() => {
    const a = document.createElement('a')
    a.id = 'viewMd'
    a.href = '/api/life/file?rel=x%2Fproba.md'
    a.target = '_blank'
    a.textContent = 'x'
    document.body.appendChild(a)
  })
  const [tab] = await Promise.all([context.waitForEvent('page'), page.evaluate(() => (document.getElementById('viewMd') as HTMLElement).click())])
  await expect(tab.locator('body')).toContainText(TEXT)
})
