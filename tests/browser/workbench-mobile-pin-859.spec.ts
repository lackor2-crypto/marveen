// #859 / #824: the Workbench pinned button box on a phone, in a real browser, with the product's real workbench.css.
// Markup mirrors the pin box of the left panel (web/workbench.js itemsPanelHtml); the CSS is the shipped file, so a
// regression of the 104px clip fails here.
import { test, expect } from '@playwright/test'
import { join } from 'node:path'

test.use({ viewport: { width: 412, height: 915 }, isMobile: true })

test('mobile: the pinned button box shows every button, nothing is clipped', async ({ page }) => {
  await page.setContent(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body>
    <aside class="wb-fr-panel wb-sh-tree wb-panel-items" style="width:378px">
      <div class="wb-pin"><div class="wb-pin-slot"><div class="wb-blk-top">
        <div class="wb-pin-acts"><button class="btn-secondary">Open</button><button class="btn-secondary">Attach folder</button></div>
        <label><input type="checkbox"> Hide finalised work items</label>
        <div class="wb-pin-acts"><button class="btn-primary wb-new-btn" id="newbtn">+ New work item</button><button class="btn-secondary" id="upbtn">Upload files</button></div>
        <div style="height:60px">trash</div><div style="height:60px">rebuild</div>
      </div><button class="wb-pin-more">v</button></div></div>
    </aside></body></html>`)
  await page.addStyleTag({ path: join(process.cwd(), 'web', 'workbench.css') })
  for (const id of ['#newbtn', '#upbtn']) {
    const b = await page.locator(id).boundingBox()
    const box = await page.locator('.wb-blk-top').boundingBox()
    expect(b).not.toBeNull()
    expect(b!.y + b!.height).toBeLessThanOrEqual(box!.y + box!.height + 1)
  }
  const cs = await page.evaluate(() => { const c = getComputedStyle(document.querySelector('.wb-blk-top') as Element); return { max: c.maxHeight, ov: c.overflowY } })
  expect(cs.max).toBe('none')
  expect(cs.ov).toBe('visible')
  expect(await page.evaluate(() => getComputedStyle(document.querySelector('.wb-pin-more') as Element).display)).toBe('none')
})
