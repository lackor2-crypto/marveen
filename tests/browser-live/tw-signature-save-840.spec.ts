// #840 (Boss TG 4458/4471): a signature picture put into the translation column must be in the SAVED language version, as it
// stands on the column -- also when the original changed after the translation was made (the column then shows an old translation).
// Real browser against the disposable web-only instance: change the original (the saved German version turns old), put the
// signature into the column through the toolbar's signature button, press "Fordítás mentése", read the saved version back.
import { test, expect } from '@playwright/test'
import { openDashboard, openProject, dismissWizard, liveIds, dashboardToken } from './helpers'

test('a signature picture put into an old translation column is saved into the language version', async ({ page, request }) => {
  test.setTimeout(150_000)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('dialog', (d) => d.dismiss())
  const { pid, letterId } = liveIds()
  const auth = { Authorization: 'Bearer ' + dashboardToken() }
  const saved = async (): Promise<{ state: string; kinds: string[] }> => {
    const r = await request.get('/api/workbench/items/' + encodeURIComponent(letterId) + '/outline/translation?to=de', { headers: auth })
    const j = await r.json()
    const d = j.data || j
    const secs = (d.sections || []) as Array<{ state: string; blocks: Array<{ kind: string }> }>
    return { state: secs.map((s) => s.state).join(','), kinds: secs.flatMap((s) => s.blocks.map((b) => b.kind)) }
  }

  // the original changes after the German version was saved: that version is now OLD
  const ol = await (await request.get('/api/workbench/items/' + encodeURIComponent(letterId) + '/outline', { headers: auth })).json()
  const sectionId = ((ol.outline || ol).sections as Array<{ id: string }>)[0]!.id
  const add = await request.post('/api/workbench/items/' + encodeURIComponent(letterId) + '/outline/blocks', { headers: auth, data: { section: sectionId, kind: 'paragraph', text: 'Egy mondat, ami a fordítás után került az eredetibe.' } })
  expect(add.ok()).toBe(true)
  const before = await saved()
  expect(before.state).toBe('stale')
  expect(before.kinds).not.toContain('image')

  await openDashboard(page)
  await openProject(page)
  await page.setViewportSize({ width: 1900, height: 1100 })
  await page.evaluate(([p, i]) => { (window as any).MarvinWorkbench.restore({ projectId: p, name: 'Teszt projekt', item: i }) }, [pid, letterId])
  await dismissWizard(page)
  // the side-by-side view: show the translation next to the original (the button toggles; click only when it is off)
  const toggle = page.locator('[data-wb-act="tw-toggle"]')
  await expect(toggle).toHaveCount(1, { timeout: 30_000 })
  if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click()
  await page.locator('#wbTwPage').waitFor({ timeout: 30_000 })
  const blocks = page.locator('#wbTwPage [data-tw="block"]')
  await expect(blocks.last()).toBeVisible({ timeout: 30_000 })
  await page.waitForTimeout(800)

  // the signature goes into the column like the owner does it: caret into a line, the signature button, pick the picture
  await blocks.last().click({ timeout: 20_000 })
  await page.locator('button[data-wb-fmt="sign"]').first().click()
  const overlay = page.locator('#wbSignPick')
  await expect(overlay).toBeVisible({ timeout: 10_000 })
  await overlay.locator('.wb-sign-item', { hasText: 'Alairas teszt' }).click({ timeout: 20_000 })
  await expect(page.locator('#wbTwPage [data-tw="island"]')).toHaveCount(1, { timeout: 10_000 })

  await page.locator('[data-wb-act="tw-save"]').click()
  await expect.poll(async () => (await saved()).kinds.filter((k) => k === 'image').length, { timeout: 20_000 }).toBe(1)
  // the saved version is what the column held: the four lines of the translation + the picture, nothing lost
  expect((await saved()).kinds).toEqual(['table', 'paragraph', 'paragraph', 'paragraph', 'image'])
  expect(errors).toEqual([])
})
