// #837 (Boss TG 4408/4410): the signature picture put "Szabadon a szöveg fölött" must be draggable OVER a line of the text and
// stay there -- on the Hungarian draft AND on the German translation column -- instead of snapping back below. Real browser
// against the disposable web-only instance: insert the signature after the last line, switch it to "over the text", drag it
// with the mouse over the third line, and read the SAVED order back (and after a reload). Red when the drop is not
// re-anchored to the line under it (the picture lands after the last line again).
import { test, expect, type Page, type Locator } from '@playwright/test'
import { openDashboard, openProject, dismissWizard, liveIds, dashboardToken } from './helpers'

type Blk = { id?: string; kind: string; text: string }

async function dragBy(page: Page, from: Locator, dy: number): Promise<void> {
  const b = (await from.boundingBox())!
  const x = b.x + b.width / 2
  const y = b.y + b.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x, y + dy / 2, { steps: 6 })
  await page.mouse.move(x, y + dy, { steps: 6 })
  await page.mouse.up()
}

test('the German column: the free signature dragged over the third line stays there, saved and after a reload', async ({ page, request }) => {
  test.setTimeout(150_000)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('dialog', (d) => d.dismiss())
  const { pid, letterId } = liveIds()
  const auth = { Authorization: 'Bearer ' + dashboardToken() }
  type Sec = { source_section: string; title: string; blocks: Blk[] }
  const savedSections = async (): Promise<Sec[]> => {
    const r = await request.get('/api/workbench/items/' + encodeURIComponent(letterId) + '/outline/translation?to=de', { headers: auth })
    const j = await r.json()
    return ((j.data || j).sections || []) as Sec[]
  }
  const savedBlocks = async (): Promise<Blk[]> => (await savedSections()).flatMap((s) => s.blocks)
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
  // the disposable instance is shared with the next specs (#840 expects the German version as it was): it is put back at the end
  const original = await savedSections()
  const before = await savedBlocks()
  expect(before.map((b) => b.kind)).toEqual(['table', 'paragraph', 'paragraph', 'paragraph'])

  // the signature after the last line, like the owner does it
  const blocks = page.locator('#wbTwPage [data-tw="block"]')
  await blocks.last().click({ timeout: 20_000 })
  await page.keyboard.press('End')
  await page.locator('button[data-wb-fmt="sign"]').first().click()
  const overlay = page.locator('#wbSignPick')
  await expect(overlay).toBeVisible({ timeout: 10_000 })
  await overlay.locator('.wb-sign-item', { hasText: 'Alairas teszt' }).click({ timeout: 20_000 })
  const island = page.locator('#wbTwPage [data-tw="island"]')
  await expect(island).toHaveCount(1, { timeout: 10_000 })

  // "Szabadon a szöveg fölött": the mode button of the picture's own tools
  await island.locator('[data-wb-act="dp-img-mode"][data-wb-mode="over"]').dispatchEvent('click')
  const picture = page.locator('#wbTwPage [data-wb-over-img]')
  await expect(picture).toHaveCount(1, { timeout: 10_000 })
  await page.waitForTimeout(500)

  // drag it with the mouse up over the third line ("Sehr geehrte Damen!")
  const third = page.locator('#wbTwPage [data-tw="block"]').nth(2)
  const t = (await third.boundingBox())!
  const p = (await picture.boundingBox())!
  await dragBy(page, picture, t.y + 2 - p.y)
  await page.waitForTimeout(500)

  // the island stands before the third line (not back below the last one) -- in the page ...
  const order = await page.evaluate(() => Array.from(document.querySelectorAll('#wbTwPage > *')).map((el) => (el as HTMLElement).classList.contains('wb-tw-island') ? 'IMG' : 'line'))
  expect(order.indexOf('IMG')).toBeGreaterThanOrEqual(0)
  expect(order.indexOf('IMG')).toBeLessThan(order.length - 1)

  // ... and in the saved version
  await page.locator('[data-wb-act="tw-save"]').click()
  await expect.poll(async () => (await savedBlocks()).filter((b) => b.kind === 'image').length, { timeout: 20_000 }).toBe(1)
  const after = await savedBlocks()
  const at = after.findIndex((b) => b.kind === 'image')
  expect(at).toBeLessThan(after.length - 1)
  expect(after.slice(at + 1).filter((b) => b.kind === 'paragraph').length).toBeGreaterThanOrEqual(1)

  // reload: the picture is still over the text, not below it
  await open()
  const again = await savedBlocks()
  expect(again.findIndex((b) => b.kind === 'image')).toBe(at)
  expect(errors).toEqual([])

  const back = await request.post('/api/workbench/items/' + encodeURIComponent(letterId) + '/outline/translation-save', { headers: auth, data: { lang: 'de', sections: original } })
  expect(back.ok()).toBe(true)
  expect(await savedBlocks()).toEqual(before)
})

test('the Hungarian draft: the free signature dragged over the third line stays there, saved and after a reload', async ({ page, request }) => {
  test.setTimeout(150_000)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('dialog', (d) => d.dismiss())
  const { pid, letterId } = liveIds()
  const auth = { Authorization: 'Bearer ' + dashboardToken() }
  const outline = async (): Promise<Blk[]> => {
    const r = await request.get('/api/workbench/items/' + encodeURIComponent(letterId) + '/outline', { headers: auth })
    const j = await r.json()
    return (((j.outline || j).sections || []) as Array<{ blocks: Blk[] }>).flatMap((s) => s.blocks)
  }
  const open = async (): Promise<void> => {
    await openDashboard(page)
    await openProject(page)
    await page.setViewportSize({ width: 1900, height: 1100 })
    await page.evaluate(([p, i]) => { (window as any).MarvinWorkbench.restore({ projectId: p, name: 'Teszt projekt', item: i }) }, [pid, letterId])
    await dismissWizard(page)
    await expect(page.locator('[data-wb-block]').last()).toBeVisible({ timeout: 30_000 })
    await page.waitForTimeout(800)
  }

  const before = await outline()
  expect(before.map((b) => b.kind)).toEqual(['table', 'paragraph', 'paragraph', 'paragraph'])
  await open()

  // the signature after the last line
  const last = page.locator('[data-wb-block]').last()
  await last.click({ timeout: 20_000 })
  await page.keyboard.press('End')
  await page.locator('button[data-wb-fmt="sign"]').first().click()
  const overlay = page.locator('#wbSignPick')
  await expect(overlay).toBeVisible({ timeout: 10_000 })
  await overlay.locator('.wb-sign-item', { hasText: 'Alairas teszt' }).click({ timeout: 20_000 })
  await expect.poll(async () => (await outline()).filter((b) => b.kind === 'image').length, { timeout: 20_000 }).toBe(1)
  const imgId = (await outline()).find((b) => b.kind === 'image')!.id!

  try {
    // "Szabadon a szöveg fölött"
    const fig = page.locator('[data-wb-img-block="' + imgId + '"]')
    await expect(fig).toHaveCount(1, { timeout: 15_000 })
    await fig.locator('[data-wb-act="dp-img-mode"][data-wb-mode="over"]').dispatchEvent('click')
    const picture = page.locator('[data-wb-over-img="' + imgId + '"]')
    await expect(picture).toHaveCount(1, { timeout: 15_000 })
    await page.waitForTimeout(600)

    // drag it with the mouse over the third line ("Tisztelt Hölgyem!")
    const rows = page.locator('.wb-dp-page [data-wb-row]')
    const third = (await rows.nth(2).boundingBox())!
    const p = (await picture.boundingBox())!
    await dragBy(page, picture, third.y + 2 - p.y)
    await expect.poll(async () => {
      const o = await outline()
      return o.length - 1 - o.findIndex((b) => b.kind === 'image')
    }, { timeout: 15_000 }).toBeGreaterThanOrEqual(1)
    const at = (await outline()).findIndex((b) => b.kind === 'image')

    // reload: still over the text
    await open()
    expect((await outline()).findIndex((b) => b.kind === 'image')).toBe(at)
    expect(errors).toEqual([])
  } finally {
    // the shared instance goes back to how it was
    const o = await outline()
    for (const b of o.filter((x) => x.kind === 'image')) {
      await request.delete('/api/workbench/items/' + encodeURIComponent(letterId) + '/outline/blocks/' + encodeURIComponent(b.id!), { headers: auth })
    }
  }
  expect((await outline()).map((b) => b.kind)).toEqual(before.map((b) => b.kind))
})
