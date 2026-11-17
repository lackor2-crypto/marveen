// #836 regression: the "Missing a work item? Rebuild from the folders" dropdown sits in the pinned top box. On the Simple
// start page the left panel is only as tall as its content (an emptied project, which is exactly when the owner rebuilds,
// has next to nothing in it), and the panel clips what drops out of it: the dropdown's "Rebuild" button sat BELOW the
// panel's bottom edge and no scrolling reached it. Real browser, the shipped web/workbench.css, the markup shape of
// web/workbench.js itemsPanelHtml (start-page layout: .wb-sh-start-tree > aside.wb-sh-tree > section.wb-panel-items).
import { test, expect } from '@playwright/test'
import { join } from 'node:path'

const HINT = 'Every work item also gets a save file (marveen-item.json) in its own folder in the Depot. If the database is lost or emptied, the work items disappear from the list, but these files stay in the folders. '
const HOW = 'What the button does: it looks through the project folders and puts the missing work items back on the list from the save files. It never overwrites what is already listed and never deletes anything. What you deleted for good is not brought back.'

async function open(page: import('@playwright/test').Page, width: number, height: number): Promise<void> {
  await page.setViewportSize({ width, height })
  await page.setContent(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body>
    <div class="wb-sh-start-tree">
      <aside class="wb-fr-panel wb-sh-tree" style="width:320px">
        <section class="wb-panel wb-panel-items"><div class="wb-pin"><div class="wb-pin-slot wb-pin-open"><div class="wb-blk wb-blk-top">
          <div class="wb-panel-head"><span class="wb-head-btns"><button class="wb-btn">Open</button> <button class="wb-btn">Attach folder</button></span></div>
          <label><input type="checkbox"> Hide finalised work items</label>
          <div class="wb-pin-acts">
            <button class="btn-primary wb-new-btn">+ New work item</button>
            <div class="wb-treeup"><button class="btn-secondary">Upload files</button></div>
            <div class="wb-trash"><button class="wb-trash-toggle">&#9656; Trash (empty)</button></div>
            <div class="wb-trash wb-rescue"><button class="wb-trash-toggle" data-wb-act="rescue-toggle">&#9662; Missing a work item? Rebuild from the folders</button>
              <div class="wb-pop"><p class="wb-hint">${HINT}</p><p class="wb-hint">${HOW}</p>
                <div class="wb-actions"><button class="wb-mini" id="restore">Rebuild missing work items</button></div>
                <p class="wb-hint">If the file of an older presentation or drawing is in the folder but not on the list, this button adds it as a new work item.</p>
                <div class="wb-actions"><button class="wb-mini" id="adopt">Add presentations and drawings without a save file</button></div>
              </div></div>
          </div><button class="wb-pin-more">&#9652;</button></div></div></div>
          <div class="wb-blk wb-blk-tree"><h2 class="wb-panel-title">Robotok</h2><ul class="wb-items"><li>one work item</li></ul></div>
        </section>
      </aside>
      <div class="wb-sh-main" style="height:1200px">start page</div>
    </div></body></html>`)
  await page.addStyleTag({ path: join(process.cwd(), 'web', 'workbench.css') })
  await page.waitForTimeout(100)
}

// The visible part of the panel is what the owner can reach: both buttons must lie inside it.
async function reachable(page: import('@playwright/test').Page, sel: string): Promise<{ inside: boolean; btm: number; panelBtm: number }> {
  return page.evaluate((s) => {
    const b = (document.querySelector(s) as HTMLElement)
    b.scrollIntoView({ block: 'nearest' })
    const r = b.getBoundingClientRect()
    const p = (document.querySelector('.wb-sh-tree') as HTMLElement).getBoundingClientRect()
    // what the panel (overflow:auto) shows, intersected with the viewport
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    return { inside: !!hit && (hit === b || b.contains(hit)), btm: Math.round(r.bottom), panelBtm: Math.round(p.bottom) }
  }, sel)
}

for (const [name, w, h] of [['desktop', 1400, 900], ['phone', 390, 844]] as const) {
  test(`${name}: the open rebuild dropdown can be reached on the start page of a near-empty project`, async ({ page }) => {
    await open(page, w, h)
    for (const sel of ['#restore', '#adopt']) {
      const r = await reachable(page, sel)
      expect(r.inside, `${sel}: bottom ${r.btm}, panel bottom ${r.panelBtm}: the button is cut off by the panel`).toBe(true)
    }
  })
}
