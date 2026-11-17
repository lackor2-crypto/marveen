// #831 regression: the controls of the Projects panel are pinned on top and the tree scrolls beneath; what DROPS DOWN from that
// pinned box (the trash list, the new-item form, the upload steps) is pinned with it, so scrolling the panel can never bring
// its bottom into view. The CSS cap alone (60vh) let the pop-up reach past the panel's bottom edge on a window shorter than
// about 1050 px: the last part of the trash list (the "Delete for good" button of the last card) sat behind the edge.
// Real browser, the shipped web/style.css + web/workbench.css + web/workbench.js (its fit runs on the window's resize event),
// the markup shape of web/workbench.js itemsPanelHtml: a scrolling .wb-fr-panel holding section.wb-panel-items with the
// sticky .wb-pin box (slot, top block, .wb-pin-acts > .wb-trash > toggle + .wb-pop) and the tree below it.
import { test, expect } from '@playwright/test'
import { join } from 'node:path'

const CARDS = Array.from({ length: 15 }, (_, i) => `
  <li class="wb-trash-card"><div class="wb-trash-card-title">Work item ${i + 1}</div>
    <div class="wb-trash-card-actions"><button type="button" class="wb-item-del">Restore</button>
    <button type="button" class="wb-item-del wb-mini-danger" id="purge${i}">Delete for good</button></div></li>`).join('')
const ROWS = Array.from({ length: 45 }, (_, i) => `<li class="wb-item-row"><button type="button" class="wb-item">Work item ${i + 1}</button></li>`).join('')

async function open(page: import('@playwright/test').Page, height: number): Promise<void> {
  await page.setViewportSize({ width: 1400, height })
  await page.setContent(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0">
    <div style="height:180px">app header</div>
    <aside class="wb-fr-panel" id="panel" style="width:340px;height:calc(100vh - 220px);overflow-y:auto;padding:10px;box-sizing:border-box">
      <section class="wb-panel wb-panel-items">
        <div class="wb-pin"><div class="wb-pin-slot"><div class="wb-blk wb-blk-top">
          <div class="wb-panel-head"><span class="wb-head-btns"><button class="wb-btn">Open</button> <button class="wb-btn">Attach folder</button></span></div>
          <label><input type="checkbox"> Hide finalised work items</label>
          <div class="wb-pin-acts">
            <button class="btn-primary wb-new-btn">+ New work item</button>
            <div class="wb-treeup"><button class="btn-secondary">Upload files</button></div>
            <div class="wb-trash"><button class="wb-trash-toggle" aria-expanded="true">&#9662; Trash (15)</button>
              <div class="wb-pop"><p class="wb-hint">What you delete lands here first.</p><ul class="wb-items">${CARDS}</ul></div></div>
          </div></div></div></div>
        <div class="wb-blk wb-blk-tree"><h2 class="wb-panel-title">Project</h2><ul class="wb-items">${ROWS}</ul></div>
      </section></aside></body></html>`)
  await page.addStyleTag({ path: join(process.cwd(), 'web', 'style.css') })
  await page.addStyleTag({ path: join(process.cwd(), 'web', 'workbench.css') })
  await page.addScriptTag({ path: join(process.cwd(), 'web', 'workbench.js') })
  await page.waitForTimeout(300)
}

// Where the last control of the pop-up ends up once it is scrolled to its end, against what the panel shows. The panel is also
// scrolled (the box then sits at its sticky place, on top), to the top and a long way down: neither may bring the edge closer.
async function lastControl(page: import('@playwright/test').Page, panelScroll: number): Promise<{ inPanel: boolean; reachable: boolean; bottom: number; panelBottom: number }> {
  return page.evaluate((st) => {
    const panel = document.getElementById('panel') as HTMLElement
    panel.scrollTop = st
    const pop = document.querySelector('.wb-pop') as HTMLElement
    pop.scrollTop = pop.scrollHeight
    const last = document.getElementById('purge14') as HTMLElement
    const r = last.getBoundingClientRect()
    const pr = panel.getBoundingClientRect()
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    return { inPanel: r.bottom <= pr.bottom + 1, reachable: !!hit && (hit === last || last.contains(hit)), bottom: Math.round(r.bottom), panelBottom: Math.round(pr.bottom) }
  }, panelScroll)
}

for (const height of [700, 900]) {
  test(`window ${height} px tall: the last button of the open trash list can be reached`, async ({ page }) => {
    await open(page, height)
    await page.evaluate(() => window.dispatchEvent(new Event('resize'))) // the product's fit runs on resize and after every render
    await page.waitForTimeout(100)
    for (const scroll of [0, 100000]) {
      const r = await lastControl(page, scroll)
      expect(r.inPanel, `panel scrolled to ${scroll}: the button's bottom ${r.bottom} lies below the panel's bottom ${r.panelBottom}`).toBe(true)
      expect(r.reachable, `panel scrolled to ${scroll}: something covers the button (bottom ${r.bottom}, panel bottom ${r.panelBottom})`).toBe(true)
    }
  })
}

test('the pop-up follows the window when it gets shorter', async ({ page }) => {
  await open(page, 1000)
  await page.evaluate(() => window.dispatchEvent(new Event('resize')))
  await page.setViewportSize({ width: 1400, height: 650 })
  // The fit runs on the window's resize event; poll instead of a fixed sleep so a slow event delivery cannot make this flaky.
  await expect.poll(async () => (await lastControl(page, 0)).inPanel, { timeout: 5000, message: 'after the window got shorter the last button must come inside the panel' }).toBe(true)
})
