// #851 (Boss TG 4734/4737/4742): the translated letter's head stands where the original's does. Measured in a real browser on the
// two pages side by side: the sender's framed table (left edge, width, top, as a share of the page's text width) and the recipient block
// (how far below the page's text top its label stands) are the same on the original page and on the translation page.
import { test, expect, type Page } from '@playwright/test'
import { openDashboard, openProject, dismissWizard, liveIds } from './helpers'

interface Head { tableLeft: number; tableWidth: number; tableTop: number; recipientTop: number; labelLeft: number }

/** Where the head stands on one page, relative to that page's own text box (padding removed), width as a share of the text width. */
async function measureHead(page: Page, pageSel: string, senderLabel: string, recipientLabel: string): Promise<Head> {
  return page.evaluate(([sel, sLabel, rLabel]) => {
    const pg = document.querySelector(sel as string) as HTMLElement
    const cs = getComputedStyle(pg)
    const r = pg.getBoundingClientRect()
    const scale = pg.offsetWidth ? r.width / pg.offsetWidth : 1
    const left = r.left + (parseFloat(cs.paddingLeft) || 0) * scale
    const top = r.top + (parseFloat(cs.paddingTop) || 0) * scale
    const width = r.width - ((parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0)) * scale
    const cell = Array.from(pg.querySelectorAll('th, td')).find((c) => (c.textContent || '').trim().startsWith(sLabel as string)) as HTMLElement
    const tbl = cell.closest('table') as HTMLElement
    const tr = tbl.getBoundingClientRect()
    // the label of the recipient block: the line of text that starts with it
    const walker = document.createTreeWalker(pg, NodeFilter.SHOW_TEXT)
    let lab: Range | null = null
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const i = (n.textContent || '').indexOf(rLabel as string)
      if (i >= 0 && !(n.parentElement && n.parentElement.closest('table'))) { lab = document.createRange(); lab.setStart(n, i); lab.setEnd(n, i + (rLabel as string).length); break }
    }
    const lr = lab!.getBoundingClientRect()
    return {
      tableLeft: (tr.left - left) / width, tableWidth: tr.width / width, tableTop: (tr.top - top) / scale,
      recipientTop: (lr.top - top) / scale, labelLeft: (lr.left - left) / width,
    }
  }, [pageSel, senderLabel, recipientLabel])
}

test('the translated letter keeps the head of the original: sender table and recipient window at the same place and size', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('dialog', (d) => d.dismiss())
  await openDashboard(page)
  await openProject(page)
  await page.setViewportSize({ width: 1900, height: 1100 })
  const { pid, letterId } = liveIds()
  await page.addInitScript(() => { try { localStorage.setItem('wb.tw.on', '1') } catch { /* ignore */ } })
  await page.evaluate(([p, i]) => { (window as any).MarvinWorkbench.restore({ projectId: p, name: 'Teszt projekt', item: i }) }, [pid, letterId])
  await dismissWizard(page)

  // the side-by-side view: show the translation next to the original (the button toggles; click only when it is off)
  const toggle = page.locator('[data-wb-act="tw-toggle"]')
  await expect(toggle).toHaveCount(1, { timeout: 30_000 })
  if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click()
  await page.locator('#wbTwPage').waitFor({ timeout: 30_000 })
  await expect(page.locator('#wbTwPage th, #wbTwPage td').first()).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('.wb-tw-left .wb-dp-page th, .wb-tw-left .wb-dp-page td').first()).toBeVisible({ timeout: 30_000 })
  await page.waitForTimeout(800)

  const orig = await measureHead(page, '.wb-tw-left .wb-dp-page', 'Feladó', 'Címzett')
  const tran = await measureHead(page, '#wbTwPage', 'Absender', 'Empfänger')
  console.log('ORIGINAL ', JSON.stringify(orig))
  console.log('TRANSLATE', JSON.stringify(tran))

  // sender: same left edge and width (shares of the text width), same top (the chapter heading row above it is as tall as the original's); recipient: same distance below the text top, same left
  expect(Math.abs(tran.tableLeft - orig.tableLeft)).toBeLessThan(0.02)
  expect(Math.abs(tran.tableWidth - orig.tableWidth)).toBeLessThan(0.02)
  expect(Math.abs(tran.tableTop - orig.tableTop)).toBeLessThan(1.5)
  expect(Math.abs(tran.recipientTop - orig.recipientTop)).toBeLessThan(1.5)
  expect(Math.abs(tran.labelLeft - orig.labelLeft)).toBeLessThan(0.02)
  expect(errors).toEqual([])
})
