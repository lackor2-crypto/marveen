// #916 (Boss 2026-11-14): every work item's context file starts with a "Sending details" block (recipient name / e-mail /
// postal address, mail subject and text). Clicked through in a real browser against the disposable dashboard: open the item
// like the owner does, then read the context file the system made for it.
import fs from 'node:fs'
import path from 'node:path'
import { test, expect } from '@playwright/test'
import { openDashboard, openItem, liveIds, dashboardToken } from './helpers'

const findContext = (dir: string): string | null => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { const r = findContext(p); if (r) return r } else if (/^(Kontextus|Context) - .*\.md$/.test(e.name)) return p
  }
  return null
}

test('a work item opened in the browser gets a context file that starts with the Sending details block', async ({ page, request }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('dialog', (d) => d.dismiss())
  await openDashboard(page)
  // a new item made the way the owner makes one (the Workbench write wakes the context sweep within seconds)
  const made = await request.post('/api/workbench/items', {
    headers: { Authorization: 'Bearer ' + dashboardToken() },
    data: { project_id: liveIds().pid, type: 'document', title: 'Kuldesi adatok proba level' },
  })
  expect(made.ok(), await made.text()).toBeTruthy()
  await openItem(page)
  const base = path.join(liveIds().depot, 'Projektek', 'teszt')
  await expect.poll(() => findContext(base), { timeout: 60_000 }).not.toBeNull()
  const text = fs.readFileSync(findContext(base)!, 'utf8')
  const head = text.indexOf('## Küldési adatok')
  expect(head, text.slice(0, 400)).toBeGreaterThan(0)
  // the block is above the Task section and carries every field the e-mail panel reads
  expect(head).toBeLessThan(text.indexOf('## Feladat'))
  for (const label of ['Címzett neve', 'Címzett e-mail', 'Címzett postai címe', 'E-mail tárgya', 'E-mail szövege']) expect(text).toContain(label)
  expect(errors).toEqual([])
})
