// #919: the signature picker remembers where it found a signature. In a real browser against a running dashboard:
// the owner moves the picture in the Life tree, throws it into the Kuka, empties it from there -- and opens the picker
// again each time. The picker must show where the picture is NOW, never the place it was at last time.
import fs from 'node:fs'
import path from 'node:path'
import { test, expect, type Page } from '@playwright/test'
import { openDashboard, openProject, openItem, dismissWizard, liveIds, dashboardToken } from './helpers'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
const NAME = 'alairas memoria proba.png'

async function api(request: import('@playwright/test').APIRequestContext, method: 'GET' | 'POST', url: string, data?: unknown) {
  const r = await request.fetch(url, { method, headers: { Authorization: 'Bearer ' + dashboardToken() }, data })
  return { status: r.status(), body: await r.json().catch(() => ({})) }
}

/**
 * The owner's way: the cursor in the paragraph, the toolbar's signature button. The picker may answer at once from the
 * remembered paths and bring the news a moment later, so it is read until it shows what is expected (or the time is up).
 */
async function pickerFolders(page: Page, expected: string[] | RegExp): Promise<string[]> {
  await page.locator('[data-wb-block]').first().click({ timeout: 20_000 })
  await page.locator('button[data-wb-fmt="sign"]').first().click()
  const overlay = page.locator('#wbSignPick')
  await expect(overlay).toBeVisible({ timeout: 10_000 })
  const read = () => overlay.locator('.wb-sign-item', { hasText: NAME }).locator('.wb-sign-folder').allTextContents()
  const ok = async () => { const f = await read(); return Array.isArray(expected) ? JSON.stringify(f) === JSON.stringify(expected) : f.length === 1 && expected.test(f[0]) }
  await expect.poll(ok, { timeout: 20_000, message: 'picker shows ' + String(Array.isArray(expected) ? JSON.stringify(expected) : expected) }).toBe(true)
  const folders = await read()
  await overlay.locator('[data-wb-sign-close]').click()
  await expect(overlay).toHaveCount(0)
  return folders
}

test('the signature picker follows a move, the Kuka and an emptied Kuka', async ({ page, request }) => {
  test.setTimeout(240_000)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('dialog', (d) => d.dismiss())
  const { depot, root } = liveIds()
  fs.mkdirSync(path.join(depot, 'Emberek', 'Elso'), { recursive: true })
  fs.mkdirSync(path.join(depot, 'Emberek', 'Masodik'), { recursive: true })
  fs.writeFileSync(path.join(depot, 'Emberek', 'Elso', NAME), PNG)

  await openDashboard(page)
  await openProject(page)
  await openItem(page)
  await dismissWizard(page)

  // 1. found once: listed, and the path is remembered on disk
  expect(await pickerFolders(page, ['Emberek/Elso'])).toEqual(['Emberek/Elso'])
  const memory = JSON.parse(fs.readFileSync(path.join(root, 'store', 'signature-memory.json'), 'utf8'))
  expect(JSON.stringify(memory.entries)).toContain('Emberek/Elso/' + NAME)

  // 2. moved in the Life tree (the real endpoint): the very next opening shows the NEW place, not the old one
  const mv = await api(request, 'POST', '/api/life/move', { from: 'Emberek/Elso/' + NAME, to: 'Emberek/Masodik' })
  expect(mv.status, JSON.stringify(mv.body)).toBeLessThan(300)
  expect(await pickerFolders(page, ['Emberek/Masodik'])).toEqual(['Emberek/Masodik'])

  // 3. thrown into the Kuka: still offered, from the Kuka
  const tr = await api(request, 'POST', '/api/life/trash', { rel: 'Emberek/Masodik/' + NAME })
  expect(tr.status, JSON.stringify(tr.body)).toBeLessThan(300)
  expect(await pickerFolders(page, /^Kuka(\/|$)/)).toHaveLength(1)

  // 4. emptied from the Kuka too: forgotten, no signature is listed any more
  const gone = (function find(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? find(path.join(dir, e.name)) : e.name === NAME ? [path.join(dir, e.name)] : [])
  })(path.join(depot, 'Kuka'))
  expect(gone).toHaveLength(1)
  fs.rmSync(gone[0], { force: true })
  expect(await pickerFolders(page, [])).toEqual([])
  expect(errors).toEqual([])
})
