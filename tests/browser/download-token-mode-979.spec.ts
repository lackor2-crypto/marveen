// #979: in TOKEN MODE a file Download opened a new tab that answered {"error":"Unauthorized"}, because a page
// navigation cannot send the Authorization header. The fix fetches the address through the token-adding fetch and
// saves it as a blob. This test is red on the old app.js (no download event, the request goes out WITHOUT the token)
// and green on the fix. The fake server answers 401 to any /api/life/file request that carries no bearer token, exactly
// like the real one in token mode.
import { test, expect } from '@playwright/test'

const TOKEN = 'test-token-979'

async function prepare(page: import('@playwright/test').Page): Promise<string[]> {
  const unauthorized: string[] = []
  await page.route('**/api/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }))
  await page.route('**/api/auth/status', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ method: 'token', authenticated: true }) }))
  await page.route('**/api/life/file**', (r) => {
    const auth = r.request().headers()['authorization'] || ''
    if (auth !== 'Bearer ' + TOKEN) {
      unauthorized.push(r.request().url())
      return r.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"Unauthorized"}' })
    }
    return r.fulfill({
      status: 200,
      headers: { 'Content-Type': 'application/x-shockwave-flash', 'Content-Disposition': "attachment; filename*=UTF-8''csiga%20nagy.swf" },
      body: 'FWS-fake-bytes',
    })
  })
  await page.addInitScript((t) => {
    try { localStorage.setItem('marveen-dashboard-token', t) } catch { /* ignore */ }
  }, TOKEN)
  await page.goto('/index.html')
  await page.waitForFunction(() => typeof (window as unknown as { _apiNavigate?: unknown })._apiNavigate === 'function')
  return unauthorized
}

test.describe('#979 -- Download carries the token in token mode', () => {
  test('window.open(download=1) saves the file instead of opening an Unauthorized tab', async ({ page }) => {
    const unauthorized = await prepare(page)
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.evaluate(() => { window.open('/api/life/file?rel=Csal%C3%A1d%2Fcsiga%20nagy.swf&lang=hu&download=1', '_blank') }),
    ])
    expect(download.suggestedFilename()).toBe('csiga nagy.swf')
    expect(unauthorized, `requests that went out without the token: ${unauthorized.join(' | ')}`).toEqual([])
  })

  test('an <a download href=/api/...> link saves the file too', async ({ page }) => {
    const unauthorized = await prepare(page)
    await page.evaluate(() => {
      const a = document.createElement('a')
      a.id = 'dl979'
      a.href = '/api/life/file?rel=x%2Fcsiga%20nagy.swf&download=1'
      a.target = '_blank'
      a.textContent = 'x'
      document.body.appendChild(a)
    })
    const [download] = await Promise.all([page.waitForEvent('download'), page.evaluate(() => (document.getElementById('dl979') as HTMLElement).click())])
    expect(download.suggestedFilename()).toBe('csiga nagy.swf')
    expect(unauthorized).toEqual([])
  })
})
