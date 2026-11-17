// #834 regression (Boss TG 4375): pointing the mouse at a tinted folder row (the red one first of all) turned its letters
// pale red -- the accent colour -- and they could not be read. Real browser, the shipped web/style.css + web/workbench.css, the
// row markup of web/workbench.js (li.wb-folder-row.wb-grp with the group colour in --wb-grp, a .wb-folder-toggle button, a
// work item row .wb-item-row > .wb-item). The letters of every row must keep their colour on hover AND stay readable
// (contrast >= 4.5) against the tinted background, in the light and in the dark theme, for all six folder colours.
import { test, expect } from '@playwright/test'
import { join } from 'node:path'

// The six folder colours of web/workbench.js GRP_FOLDER (the first, hue 355, is the red one) and one work item blue.
const GROUPS = ['hsl(355 85% 62%)', 'hsl(175 85% 50%)', 'hsl(55 95% 48%)', 'hsl(145 70% 48%)', 'hsl(25 95% 52%)', 'hsl(115 75% 46%)', 'hsl(230 60% 22%)']

async function open(page: import('@playwright/test').Page, theme: 'light' | 'dark'): Promise<void> {
  const rows = GROUPS.map((g, i) => `
    <li class="wb-folder-row wb-grp wb-depth-1" style="--wb-grp: ${g}; --wb-grp-a: 24%; --wb-grp-a-on: 30%">
      <button type="button" class="wb-folder-toggle" id="f${i}">&#9662; Folder number ${i} <span class="wb-muted">(3)</span></button></li>
    <li class="wb-item-row wb-grp" style="--wb-grp: ${g}; --wb-grp-a: 24%">
      <button type="button" class="wb-item" id="i${i}"><span class="wb-item-title">Work item ${i}</span> <span class="wb-item-meta">Letter</span></button></li>`).join('')
  await page.setContent(`<!doctype html><html data-theme="${theme}"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head>
    <body><ul class="wb-items" style="list-style:none;padding:8px;width:340px">${rows}</ul></body></html>`)
  await page.addStyleTag({ path: join(process.cwd(), 'web', 'style.css') })
  await page.addStyleTag({ path: join(process.cwd(), 'web', 'workbench.css') })
  await page.waitForTimeout(500) // style.css fades every colour (transition: all); measure the settled colour
}

type Probe = { color: string; decoration: string; bg: string }
async function probe(page: import('@playwright/test').Page, sel: string): Promise<Probe> {
  return page.evaluate((s) => {
    const el = document.querySelector(s) as HTMLElement
    // the row's own tinted background (the li), composited over what lies under it
    let node: HTMLElement | null = el
    const layers: string[] = []
    while (node) { layers.push(getComputedStyle(node).backgroundColor); node = node.parentElement }
    return { color: getComputedStyle(el).color, decoration: getComputedStyle(el).textDecorationLine, bg: layers.join('|') }
  }, sel)
}

function rgba(c: string): [number, number, number, number] {
  const m = c.match(/rgba?\(([^)]+)\)/) ?? c.match(/color\(srgb ([^)]+)\)/)
  if (!m) throw new Error('unparsable colour: ' + c)
  const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number)
  const srgb = c.startsWith('color(')
  return [srgb ? p[0] * 255 : p[0], srgb ? p[1] * 255 : p[1], srgb ? p[2] * 255 : p[2], p[3] ?? 1]
}
function lum([r, g, b]: number[]): number {
  const f = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4) }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}
// composite the background layers (innermost first) over opaque white or black page colour
function composite(layers: string, base: [number, number, number]): number[] {
  const cols = layers.split('|').map((l) => { try { return rgba(l) } catch { return [0, 0, 0, 0] as [number, number, number, number] } }).reverse()
  let cur = base.slice()
  for (const [r, g, b, a] of cols) cur = [r * a + cur[0] * (1 - a), g * a + cur[1] * (1 - a), b * a + cur[2] * (1 - a)]
  return cur
}
function contrast(fg: string, bgLayers: string, base: [number, number, number]): number {
  const bg = composite(bgLayers, base)
  const a = lum(rgba(fg)); const b = lum(bg)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

for (const theme of ['light', 'dark'] as const) {
  test(`${theme}: hovering a folder row or a work item row keeps the letters' colour and they stay readable`, async ({ page }) => {
    test.setTimeout(120_000)
    await open(page, theme)
    const base: [number, number, number] = await page.evaluate(() => {
      const c = getComputedStyle(document.body).backgroundColor.match(/[\d.]+/g)!.map(Number)
      return [c[0], c[1], c[2]] as [number, number, number]
    })
    for (let i = 0; i < GROUPS.length; i++) {
      for (const sel of [`#f${i}`, `#i${i}`, `#i${i} .wb-item-title`, `#i${i} .wb-item-meta`]) {
        await page.mouse.move(0, 0)
        await page.waitForTimeout(450)
        const before = await probe(page, sel)
        await page.hover(sel.split(' ')[0])
        await page.waitForTimeout(450)
        const after = await probe(page, sel)
        expect(after.color, `${theme} ${sel}: hover changed the letter colour ${before.color} -> ${after.color}`).toBe(before.color)
        const c = contrast(after.color, after.bg, base)
        expect(c, `${theme} ${sel}: hovered letters ${after.color} have contrast ${c.toFixed(2)} on the tinted row`).toBeGreaterThanOrEqual(4.5)
      }
      // the folder name says "this is the one under the mouse" by an underline, not by a colour
      await page.hover(`#f${i}`)
      await page.waitForTimeout(450)
      expect((await probe(page, `#f${i}`)).decoration).toContain('underline')
    }
  })
}
