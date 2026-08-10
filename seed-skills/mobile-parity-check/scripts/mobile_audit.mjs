#!/usr/bin/env node
/**
 * Mobil-paritás söprés: minden dashboard-oldalt betölt telefon-nézetben, és
 * jelenti azokat az elemeket, amik kilógnak a képernyőről ÚGY, hogy nincs
 * görgethető ősük -- tehát ujjal sem lehet odajutni.
 *
 * A "van görgethető őse" kivétel a lényeg: egy szándékosan oldalra görgethető
 * táblázat nem hiba, egy levágott gomb igen.
 *
 * Futtatás a repo gyökeréből (a playwright onnan oldható fel):
 *   DASHBOARD_TOKEN=$(cat store/.dashboard-token) node ~/.claude/skills/mobile-parity-check/scripts/mobile_audit.mjs
 * Opció: WIDTH=360 a szűkebb telefonokhoz (alap: 390).
 */
// A skill a ~/.claude alatt el, a playwright viszont a Marveen repo
// node_modules-jaban -- ezert a MUNKAKONYVTARBOL oldjuk fel, nem a szkript
// helyerol (kulonben ERR_MODULE_NOT_FOUND, meg ha a repobol futtatod is).
import { createRequire } from 'node:module'
const { chromium } = createRequire(process.cwd() + '/')('@playwright/test')

const BASE = (process.env.DASHBOARD_URL || 'http://localhost:3420') + '/?token=' + (process.env.DASHBOARD_TOKEN || '')
const WIDTH = Number(process.env.WIDTH || 390)
const PAGES = ['overview', 'kanban', 'approvals', 'agents', 'activity', 'messages', 'tasks', 'bgTasks',
  'memories', 'naplo', 'skills', 'research', 'ideas', 'costs', 'tokenUsage', 'debate', 'openrouter',
  'status', 'docs', 'settings', 'updates', 'archived', 'federation', 'email', 'vault', 'accounts',
  'connectors', 'recall']

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: WIDTH, height: 800 }, isMobile: true, hasTouch: true })
const page = await ctx.newPage()
const jsErrors = []
page.on('pageerror', (e) => jsErrors.push(String(e).split('\n')[0]))
const bad = []

for (const p of PAGES) {
  await page.goto(`${BASE}#${p}`, { waitUntil: 'load' })
  await page.waitForTimeout(1500)
  const r = await page.evaluate(() => {
    const vw = window.innerWidth
    const vp = [...document.querySelectorAll('.page')].find((x) => !x.hidden)
    if (!vp) return null
    const out = []
    for (const el of vp.querySelectorAll('*')) {
      const rr = el.getBoundingClientRect()
      if (rr.width === 0 || rr.height === 0 || rr.right <= vw + 2) continue
      let a = el.parentElement, scrollable = false
      while (a && a !== document.body) {
        const cs = getComputedStyle(a)
        if ((cs.overflowX === 'auto' || cs.overflowX === 'scroll') && a.scrollWidth > a.clientWidth) { scrollable = true; break }
        a = a.parentElement
      }
      if (!scrollable) {
        const name = (typeof el.className === 'string' && el.className) ? el.className.slice(0, 30) : el.tagName.toLowerCase()
        out.push(`${name} (+${Math.round(rr.right - vw)}px)`)
      }
    }
    return { pageOverflow: document.body.scrollWidth > vw, out: [...new Set(out)].slice(0, 5) }
  })
  if (r && (r.pageOverflow || r.out.length)) bad.push(`${p}: ${r.pageOverflow ? 'az OLDAL is túlcsordul; ' : ''}${r.out.join(', ')}`)
}

console.log(bad.length
  ? `KILÓG (${bad.length} oldal, ${WIDTH}px):\n  ` + bad.join('\n  ')
  : `TISZTA: mind a ${PAGES.length} oldalon nincs elérhetetlen vízszintes kilógás ${WIDTH}px-en`)
if (jsErrors.length) console.log('JS-hibák:', [...new Set(jsErrors)])
await browser.close()
process.exit(bad.length ? 1 : 0)
