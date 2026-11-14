// #824: inserting a saved signature from the Life tree into a document, in a real browser against a running dashboard.
import { test, expect } from '@playwright/test'
import { openDashboard, openProject, openItem, dismissWizard, liveIds, dashboardToken } from './helpers'

test('the signature picker lists the signature picture and puts it into the document', async ({ page, request }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('dialog', (d) => d.dismiss())
  await openDashboard(page)
  await openProject(page)
  await openItem(page)
  await dismissWizard(page)

  // put the cursor into the paragraph, then press the toolbar's signature button like the owner does
  await page.locator('[data-wb-block]').first().click({ timeout: 20_000 })
  await page.locator('button[data-wb-fmt="sign"]').first().click()

  const overlay = page.locator('#wbSignPick')
  await expect(overlay).toBeVisible({ timeout: 10_000 })
  const item = overlay.locator('.wb-sign-item', { hasText: 'Alairas teszt' })
  await expect(item).toBeVisible({ timeout: 20_000 })
  await item.click()
  await expect(overlay).toHaveCount(0)

  const { itemId } = liveIds()
  await expect.poll(async () => {
    const r = await request.get('/api/workbench/items/' + encodeURIComponent(itemId) + '/outline', { headers: { Authorization: 'Bearer ' + dashboardToken() } })
    if (!r.ok()) return 'http ' + r.status()
    const j = await r.json()
    const o = j.outline || j
    const blocks = ((o.sections || []) as Array<{ blocks?: Array<{ kind?: string; text?: string }> }>).flatMap((s) => s.blocks || [])
    return blocks.some((b) => b.kind === 'image' && String(b.text || '').includes('Alairas teszt.png')) ? 'inserted' : 'missing'
  }, { timeout: 20_000 }).toBe('inserted')
  expect(errors).toEqual([])
})
