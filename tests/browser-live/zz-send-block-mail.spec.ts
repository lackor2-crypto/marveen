// #916 (Boss 2026-11-14): after the final PDF, the e-mail panel takes the recipient, the subject and the covering text from the
// "Sending details" block at the top of the context file. Clicked through in a real browser: the block is filled the way the
// agent's context.send does (the file on disk), the item is opened like the owner opens it, and the panel's own fields are read.
// Runs after zz-finalize (file name order): the panel needs the final PDF the finalise spec made.
import fs from 'node:fs'
import path from 'node:path'
import { test, expect } from '@playwright/test'
import { openDashboard, openProject, openItem, dismissWizard, liveIds } from './helpers'

const findContext = (dir: string): string | null => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { const r = findContext(p); if (r) return r } else if (/^(Kontextus|Context) - Level.*\.md$/.test(e.name)) return p
  }
  return null
}

test('the e-mail panel after the final PDF shows the recipient, subject and text from the Sending details block', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('dialog', (d) => d.dismiss())
  await openDashboard(page)
  await openProject(page)
  await openItem(page)
  await dismissWizard(page)

  const base = path.join(liveIds().depot, 'Projektek', 'teszt')
  await expect.poll(() => findContext(base), { timeout: 60_000 }).not.toBeNull()
  const file = findContext(base)!
  let text = fs.readFileSync(file, 'utf8')
  expect(text).toContain('## Küldési adatok')
  const fill = (label: string, value: string): void => {
    const re = new RegExp('^- ' + label + ':.*$', 'm')
    expect(re.test(text), 'the block has the line "' + label + '"').toBe(true)
    text = text.replace(re, '- ' + label + ': ' + value)
  }
  fill('Címzett neve', 'Sozialamt Chemnitz')
  fill('Címzett e-mail', 'sozialamt@stadt-chemnitz.de')
  fill('Címzett postai címe', 'Weg 1, 09111 Chemnitz')
  fill('E-mail tárgya', 'Widerspruch Az. 12 browsertest')
  text = text.replace(/^- E-mail szövege:.*$/m, '- E-mail szövege:\n  Sehr geehrte Damen und Herren,\n\n  anbei mein Widerspruch browsertest.')
  fs.writeFileSync(file, text)

  // open the item again: the panel is built from the server's answer
  await openItem(page)
  await dismissWizard(page)
  // the finalised item asks "Elküldted már?" on every open (the finalise spec made the final): answer "not yet", then open the Send panel
  const notYet = page.getByRole('button', { name: /Nem, még nem|No, not yet/ })
  if (await notYet.isVisible({ timeout: 5_000 }).catch(() => false)) await notYet.click()
  const to = page.locator('#wbMailTo')
  if (!(await to.count())) await page.getByRole('button', { name: /✉ Küldés|✉ Send/ }).first().click()
  await expect(to).toBeVisible({ timeout: 30_000 })
  await expect(to).toHaveValue('sozialamt@stadt-chemnitz.de')
  await expect(page.locator('#wbMailSubject')).toHaveValue('Widerspruch Az. 12 browsertest')
  await expect(page.locator('#wbMailBody')).toHaveValue(/anbei mein Widerspruch browsertest\./)
  await page.screenshot({ path: path.join(liveIds().depot, 'send-block-mail-panel.png') })
  expect(errors).toEqual([])
})
