// #824: the "Move to the Life tree" dialog of a work item, in a real browser against a running dashboard.
import { test, expect } from '@playwright/test'
import { openDashboard, openProject, openItem, dismissWizard } from './helpers'

test('the Life-tree move dialog opens for the item, names it and lists its folder without an error', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('dialog', (d) => d.dismiss())
  await openDashboard(page)
  await openProject(page)
  await openItem(page)
  await dismissWizard(page)

  await page.locator('[data-wb-act="life-move"]').first().click({ timeout: 20_000 })
  await expect(page.locator('#wbLifeMoveScope')).toBeVisible({ timeout: 20_000 })
  await expect(page.locator('#wbLifeMoveScope')).toContainText('Level')
  await expect(page.locator('.wb-error')).toHaveCount(0)
  await expect(page.locator('text=irat.txt').first()).toBeVisible()
  expect(errors).toEqual([])
})
