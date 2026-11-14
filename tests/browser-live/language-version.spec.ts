// #824: creating a language version of a document from the editor, in a real browser against a running dashboard.
import { test, expect } from '@playwright/test'
import { openDashboard, openProject, openItem, dismissWizard, liveIds, dashboardToken } from './helpers'

test('the language picker creates a German version that shows up in the item list', async ({ page, request }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('dialog', (d) => d.dismiss())
  await openDashboard(page)
  await openProject(page)
  await openItem(page)
  await dismissWizard(page)

  // the language-version box sits in the draft tab's collapsed "more" block: open it like the owner does
  const more = page.locator('details.wb-dp-more:has(#wbVariantLang)')
  await expect(more).toHaveCount(1, { timeout: 20_000 })
  await more.locator('summary').first().click()

  const picker = page.locator('#wbVariantLang')
  await expect(picker).toBeVisible({ timeout: 20_000 })
  await picker.selectOption('de')
  await page.locator('[data-wb-act="outline-lang-create"]').click()

  // the server confirms it: the item now has a German variant
  const { itemId } = liveIds()
  await expect.poll(async () => {
    const r = await request.get('/api/workbench/items/' + encodeURIComponent(itemId) + '/outline', { headers: { Authorization: 'Bearer ' + dashboardToken() } })
    if (!r.ok()) return 'http ' + r.status()
    const j = await r.json()
    const o = j.outline || j
    return ((o.variants || []) as Array<{ lang: string }>).map((v) => v.lang).join(',')
  }, { timeout: 20_000 }).toContain('de')
  expect(errors).toEqual([])
})
