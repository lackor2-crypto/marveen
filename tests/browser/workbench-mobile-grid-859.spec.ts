// #859 / #824: on a phone the Workbench left grid must never be wider than the screen, however wide its content is
// (deep folders, long unbreakable names). The grid column was `1fr` (= minmax(auto, 1fr)), so a 700px child pushed it to
// 807px in a 412px viewport and the right side was cut off. Real browser, real shipped workbench.css.
import { test, expect } from '@playwright/test'
import { join } from 'node:path'

test.use({ viewport: { width: 412, height: 915 }, isMobile: true })

for (const [name, cls, style] of [
  ['plain grid', 'wb-grid', ''],
  ['aside grid', 'wb-grid wb-grid-aside', ''],
  ['aside grid with a dragged tree width', 'wb-grid wb-grid-aside', '--wb-tree-w:600px'],
] as const) {
  test(`mobile: ${name} stays inside the viewport with very wide content`, async ({ page }) => {
    await page.setContent(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0">
      <div id="g" class="${cls}" style="${style}">
        <section id="panel" class="wb-panel wb-panel-items wb-panel-current"><div style="white-space:nowrap;min-width:700px">a very deep folder row that cannot wrap</div></section>
      </div></body></html>`)
    await page.addStyleTag({ path: join(process.cwd(), 'web', 'workbench.css') })
    const w = await page.evaluate(() => ({
      panel: Math.round((document.getElementById('panel') as Element).getBoundingClientRect().width),
      vw: document.documentElement.clientWidth,
    }))
    expect(w.panel).toBeLessThanOrEqual(w.vw)
  })
}
