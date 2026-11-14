// #824: finalising a document from the Finalise panel (review the PDF, tick, make the final PDF), in a real browser.
// Runs LAST (file name): finalising makes the item ask "was it sent?" on every later open, which would cover the other specs.
// The suite shares one disposable server, so state a spec leaves behind is seen by the specs after it.
import { test, expect } from '@playwright/test'
import { openDashboard, openProject, openItem, dismissWizard, liveIds, dashboardToken } from './helpers'

test('the Finalise panel walks review -> tick -> final PDF and the server records the final', async ({ page, request, context }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('dialog', (d) => d.accept())
  await openDashboard(page)
  await openProject(page)
  await openItem(page)
  await dismissWizard(page)

  const panel = page.locator('.wb-outline-final')
  if (!(await panel.count())) {
    await page.getByRole('button', { name: /Véglegesítés|Finalize/ }).first().click()
  }
  await expect(panel).toBeVisible({ timeout: 20_000 })

  const finalBtn = panel.locator('[data-wb-act="outline-finalize"]')
  const accept = panel.locator('input[data-wb-act="outline-accept"]')
  // before the review: both steps are closed and the panel says which step is next
  await expect(finalBtn).toBeDisabled()
  await expect(accept).toBeDisabled()
  await expect(panel.locator('.wb-outline-next')).not.toBeEmpty()

  // review: the link opens the PDF in a new tab, the server records the review when the PDF is made
  const popupP = context.waitForEvent('page', { timeout: 30_000 }).catch(() => null)
  await panel.locator('a[data-wb-act="outline-review"]').click()
  // with a second language version (the language spec made one) the screen asks which version is reviewed: pick the one marked "here"
  const pick = page.locator('#wbFinalLangPick')
  if (await pick.isVisible({ timeout: 3_000 }).catch(() => false)) {
    const here = pick.locator('.wb-finalpick-row', { has: page.locator('.wb-muted') }).first()
    await (await here.count() ? here : pick.locator('.wb-finalpick-row').first()).locator('input[type=radio]').check()
    await pick.locator('#wbFinalLangGo').click()
  }
  const popup = await popupP
  if (popup) await popup.close().catch(() => undefined)
  await expect(accept).toBeEnabled({ timeout: 45_000 })

  await accept.check()
  await expect(finalBtn).toBeEnabled()
  await finalBtn.click()

  const { itemId } = liveIds()
  await expect.poll(async () => {
    const r = await request.get('/api/workbench/items/' + encodeURIComponent(itemId) + '/outline', { headers: { Authorization: 'Bearer ' + dashboardToken() } })
    if (!r.ok()) return 'http ' + r.status()
    const j = await r.json()
    const o = j.outline || j
    return o.final && o.final.label ? 'final' : 'none'
  }, { timeout: 60_000 }).toBe('final')
  expect(errors).toEqual([])
})
