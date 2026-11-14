import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Page } from '@playwright/test'

export interface LiveIds { pid: string; itemId: string; port: number; depot: string; root: string }

export function liveIds(): LiveIds {
  return JSON.parse(fs.readFileSync(path.join(os.tmpdir(), 'marveen-live-browser-ids.json'), 'utf8'))
}

export function dashboardToken(): string {
  return fs.readFileSync(path.join(liveIds().root, 'store', '.dashboard-token'), 'utf8').trim()
}

/** Opens the dashboard like the owner does and gets the first-run overlays out of the way. */
export async function openDashboard(page: Page, hash = '#projects'): Promise<void> {
  await page.addInitScript(() => { try { localStorage.setItem('marveen.workbench.view', 'simple') } catch { /* ignore */ } })
  await page.goto('/?token=' + dashboardToken() + hash)
  await page.waitForLoadState('load')
  await page.addStyleTag({ content: '#onboardingOverlay{display:none!important}' })
  await dismissWizard(page)
}

/** The "Marveen beállítása" wizard covers the page on a fresh install. */
export async function dismissWizard(page: Page): Promise<void> {
  await page.waitForTimeout(800)
  await page.evaluate(() => {
    const w = document.querySelector('.bk-wizard')
    if (w) { const o = w.parentElement; ((o && o !== document.body) ? o : w).remove() }
    document.body.style.overflow = ''
  })
}

export async function openProject(page: Page): Promise<void> {
  const { pid } = liveIds()
  await page.evaluate((id) => { (window as any).MarvinWorkbench.open(id, 'Teszt projekt') }, pid)
  await page.waitForFunction(() => document.querySelectorAll('.wb-folder-row').length > 0, null, { timeout: 30_000 })
  await dismissWizard(page)
}

export async function openItem(page: Page): Promise<void> {
  const { pid, itemId } = liveIds()
  await page.evaluate(([p, i]) => { (window as any).MarvinWorkbench.restore({ projectId: p, name: 'Teszt projekt', item: i }) }, [pid, itemId])
  await page.waitForTimeout(2500)
  await dismissWizard(page)
}
