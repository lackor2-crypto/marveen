// #838 (Boss TG 4431/4432/4437): empty lines made with Enter in the translation column, plus the signature picture put into
// them, must all be in the SAVED language version, in place (the printed name must not slide under the picture), and must
// survive a reload of the page. Real browser against the disposable web-only instance.
import { test, expect } from '@playwright/test'
import { openDashboard, openProject, dismissWizard, liveIds, dashboardToken } from './helpers'

test('empty lines + the signature picture of the translation column are saved together, in place, and survive a reload', async ({ page, request }) => {
  test.setTimeout(150_000)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('dialog', (d) => d.dismiss())
  const { pid, letterId } = liveIds()
  const auth = { Authorization: 'Bearer ' + dashboardToken() }
  const saved = async (): Promise<Array<{ kind: string; text: string }>> => {
    const r = await request.get('/api/workbench/items/' + encodeURIComponent(letterId) + '/outline/translation?to=de', { headers: auth })
    const j = await r.json()
    const d = j.data || j
    const secs = (d.sections || []) as Array<{ blocks: Array<{ kind: string; text: string }> }>
    return secs.flatMap((s) => s.blocks.map((b) => ({ kind: b.kind, text: b.text })))
  }
  const isBlank = (b: { kind: string; text: string }): boolean => b.kind === 'paragraph' && b.text.replace(/[​\s]/g, '') === ''
  const open = async (): Promise<void> => {
    await openDashboard(page)
    await openProject(page)
    await page.setViewportSize({ width: 1900, height: 1100 })
    await page.evaluate(([p, i]) => { (window as any).MarvinWorkbench.restore({ projectId: p, name: 'Teszt projekt', item: i }) }, [pid, letterId])
    await dismissWizard(page)
    const toggle = page.locator('[data-wb-act="tw-toggle"]')
    await expect(toggle).toHaveCount(1, { timeout: 30_000 })
    if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click()
    await page.locator('#wbTwPage').waitFor({ timeout: 30_000 })
    await expect(page.locator('#wbTwPage [data-tw="block"]').last()).toBeVisible({ timeout: 30_000 })
    await page.waitForTimeout(800)
  }

  await open()
  const before = await saved()
  expect(before.filter(isBlank)).toHaveLength(0)
  const last = before.length - 1

  // like the owner: caret at the end of the last line, three Enters, then the signature button on the empty lines
  const blocks = page.locator('#wbTwPage [data-tw="block"]')
  await blocks.last().click({ timeout: 20_000 })
  await page.keyboard.press('End')
  for (let k = 0; k < 3; k++) await page.keyboard.press('Enter')
  await page.locator('button[data-wb-fmt="sign"]').first().click()
  const overlay = page.locator('#wbSignPick')
  await expect(overlay).toBeVisible({ timeout: 10_000 })
  await overlay.locator('.wb-sign-item', { hasText: 'Alairas teszt' }).click({ timeout: 20_000 })
  await expect(page.locator('#wbTwPage [data-tw="island"]')).toHaveCount(1, { timeout: 10_000 })

  await page.locator('[data-wb-act="tw-save"]').click()
  await expect.poll(async () => (await saved()).filter(isBlank).length, { timeout: 20_000 }).toBeGreaterThanOrEqual(3)
  const after = await saved()
  expect(after.filter((b) => b.kind === 'image')).toHaveLength(1)
  // nothing of the original lines is lost and the blank lines stand AFTER the last printed line, not before it
  expect(after.filter((b) => !isBlank(b) && b.kind !== 'image')).toHaveLength(before.length)
  const lastText = after.map((b, i) => (!isBlank(b) && b.kind !== 'image' ? i : -1)).filter((i) => i >= 0).pop()!
  expect(after.slice(lastText + 1).filter(isBlank).length).toBeGreaterThanOrEqual(3)
  void last

  // reload the page: the saved lines are still there
  await open()
  const again = await saved()
  expect(again.filter(isBlank).length).toBe(after.filter(isBlank).length)
  expect(again.filter((b) => b.kind === 'image')).toHaveLength(1)
  expect(errors).toEqual([])
})
