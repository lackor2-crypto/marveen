// #824: folder structure of the Workbench, clicked through in a real browser against a running (disposable) dashboard.
import fs from 'node:fs'
import path from 'node:path'
import { test, expect } from '@playwright/test'
import { openDashboard, openProject, dismissWizard, liveIds } from './helpers'

test.describe('Workbench folder structure (#824)', () => {
  test('the project folder tree renders every seeded folder and survives clicking folder rows', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('dialog', (d) => d.dismiss())
    await openDashboard(page)
    await openProject(page)

    const rows = await page.locator('.wb-folder-row').count()
    expect(rows).toBeGreaterThanOrEqual(12)

    await dismissWizard(page)
    for (const nm of ['Ugy 05', 'Ugy 09']) {
      const row = page.locator('.wb-grp', { hasText: nm }).first()
      await row.click({ timeout: 10_000 })
    }
    await page.waitForTimeout(1200)
    expect(await page.locator('.wb-folder-row').count()).toBeGreaterThanOrEqual(rows)
    expect(errors).toEqual([])
  })

  test('creating a folder from the UI adds it to the tree and to the disk', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    await openDashboard(page)
    await openProject(page)
    await dismissWizard(page)
    const name = 'Uj mappa ' + Date.now()
    const input = page.locator('#wbNewFolderName')
    await expect(input).toBeVisible({ timeout: 15_000 })
    await input.click()
    await page.keyboard.type(name)
    await page.locator('[data-wb-act="mkfolder"]').first().click()
    await expect(page.locator('.wb-grp, .wb-folder-row', { hasText: name }).first()).toBeVisible({ timeout: 15_000 })
    // the new folder lands inside whichever folder the screen has selected: look for it anywhere under the project folder
    const hasDir = (dir: string): boolean => fs.readdirSync(dir, { withFileTypes: true }).some((e) => e.isDirectory() && (e.name === name || hasDir(path.join(dir, e.name))))
    await expect.poll(() => hasDir(path.join(liveIds().depot, 'Projektek', 'teszt')), { timeout: 10_000 }).toBe(true)
    expect(errors).toEqual([])
  })
})
