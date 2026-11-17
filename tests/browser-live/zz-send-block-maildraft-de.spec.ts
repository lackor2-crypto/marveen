// #931 (Boss 2026-11-16): the e-mail of a letter is ALWAYS in the letter's language. The German version of a Hungarian letter
// shares its original's context file, whose plain "E-mail tárgya / szövege" lines are Hungarian; its e-mail form once opened
// with that Hungarian subject and text. Clicked through in a real browser: the Hungarian plain lines are written the way the agent's
// context.send does (the file on disk), the GERMAN version is finalised from the Finalise panel, and its e-mail panel is read.
// Runs after zz-send-block-mail (file name order); uses the seeded official letter (it has a saved German version).
import fs from 'node:fs'
import path from 'node:path'
import { test, expect } from '@playwright/test'
import { openDashboard, openProject, dismissWizard, liveIds, dashboardToken } from './helpers'

const findContext = (dir: string, name: RegExp): string | null => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { const r = findContext(p, name); if (r) return r } else if (name.test(e.name)) return p
  }
  return null
}

const HU_SUBJECT = 'Kérésem továbbítása az illetékes munkatárshoz'
const HU_BODY = 'Tisztelt Hölgyem!\n\n  Mellékelten küldöm a levelemet, amelyben segítséget kérek az ügyemben, és előre is köszönöm.'

test('the German version of a Hungarian letter opens its e-mail panel in German, never with the original\'s Hungarian subject and text', async ({ page, context, request }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('dialog', (d) => d.accept())
  const { pid, letterId, depot } = liveIds()
  await openDashboard(page)
  await openProject(page)
  const open = async (): Promise<void> => {
    await page.evaluate(([p, i]) => { (window as any).MarvinWorkbench.restore({ projectId: p, name: 'Teszt projekt', item: i }) }, [pid, letterId])
    await page.waitForTimeout(2500)
    await dismissWizard(page)
    // a finalised item (the specs before this one made some) asks "Elküldted már?" on every open: answer "not yet"
    const notYet = page.getByRole('button', { name: /Nem, még nem|No, not yet/ })
    if (await notYet.isVisible({ timeout: 3_000 }).catch(() => false)) await notYet.click()
  }
  await open()

  // the context file of the Hungarian letter: its plain subject / text are HUNGARIAN
  const base = path.join(depot, 'Projektek', 'teszt')
  const lsAll = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? lsAll(path.join(d, e.name)) : [path.join(d, e.name)])
  await expect.poll(() => findContext(base, /^(Kontextus|Context) - Hivatalos level.*\.md$/) ?? 'NONE ' + lsAll(base).join(' | '), { timeout: 30_000 }).not.toMatch(/^NONE/)
  const file = findContext(base, /^(Kontextus|Context) - Hivatalos level.*\.md$/)!
  let text = fs.readFileSync(file, 'utf8')
  expect(text).toContain('## Küldési adatok')
  text = text.replace(/^- Címzett e-mail:.*$/m, '- Címzett e-mail: info@minijob-zentrale.example')
  text = text.replace(/^- E-mail tárgya:.*$/m, '- E-mail tárgya: ' + HU_SUBJECT)
  text = text.replace(/^- E-mail szövege:.*$/m, '- E-mail szövege:\n  ' + HU_BODY)
  fs.writeFileSync(file, text)
  await open()

  // finalise the GERMAN version from the Finalise panel (the panel asks which version)
  const panel = page.locator('.wb-outline-final')
  if (!(await panel.count())) await page.getByRole('button', { name: /Véglegesítés|Finalize/ }).first().click()
  await expect(panel).toBeVisible({ timeout: 20_000 })
  const popupP = context.waitForEvent('page', { timeout: 30_000 }).catch(() => null)
  await panel.locator('a[data-wb-act="outline-review"]').click()
  const pick = page.locator('#wbFinalLangPick')
  await expect(pick).toBeVisible({ timeout: 10_000 })
  await pick.locator('.wb-finalpick-row', { hasText: /német|german|deutsch/i }).first().locator('input[type=radio]').check()
  await pick.locator('#wbFinalLangGo').click()
  const popup = await popupP
  if (popup) await popup.close().catch(() => undefined)
  const accept = panel.locator('input[data-wb-act="outline-accept"]')
  await expect(accept).toBeEnabled({ timeout: 45_000 })
  await accept.check()
  const finalBtn = panel.locator('[data-wb-act="outline-finalize"]')
  await expect(finalBtn).toBeEnabled()
  await finalBtn.click()

  // the German version's e-mail panel opens by itself: read the fields the way the owner sees them
  const subject = page.locator('#wbMailSubject')
  await expect(subject).toBeVisible({ timeout: 60_000 })
  const body = page.locator('#wbMailBody')
  await expect(body).toBeVisible()
  await expect.poll(async () => (await body.inputValue()).trim().length, { timeout: 20_000 }).toBeGreaterThan(10)
  const subjectValue = await subject.inputValue()
  const bodyValue = await body.inputValue()
  await page.screenshot({ path: path.join(depot, 'send-block-mail-panel-de.png') })
  expect(subjectValue).not.toBe(HU_SUBJECT)
  expect(bodyValue).not.toContain('Tisztelt')
  expect(bodyValue).not.toContain('Mellékelten')
  expect(bodyValue).toMatch(/Sehr geehrte|Guten Tag|Mit freundlichen/)
  console.log('MEASURED de subject=' + JSON.stringify(subjectValue) + ' body=' + JSON.stringify(bodyValue.slice(0, 160)))

  // the lock on the running server: the Hungarian original's subject and text sent for the GERMAN version are refused (the page's
  // save button needs a mail account and the empty test instance has none, so the same request is made on the endpoint the button calls)
  const auth = { Authorization: 'Bearer ' + dashboardToken() }
  const outlineRes = await request.get('/api/workbench/items/' + encodeURIComponent(letterId) + '/outline', { headers: auth })
  const o = (await outlineRes.json()).outline
  const deId = ((o.variants || []) as Array<{ lang: string; item_id: string }>).find((v) => v.lang === 'de')?.item_id
  expect(deId, 'the letter has a German version').toBeTruthy()
  const saved = await request.post('/api/workbench/items/' + encodeURIComponent(deId!) + '/outline/mail-draft', {
    headers: auth,
    data: { to: 'info@minijob-zentrale.example', subject: HU_SUBJECT, body: 'Tisztelt Hölgyem! Mellékelten küldöm a levelemet, amelyben segítséget kérek az ügyemben, és előre is köszönöm.' },
  })
  const savedText = await saved.text()
  console.log('MEASURED save status=' + saved.status() + ' answer=' + savedText.slice(0, 300))
  expect(saved.status()).toBe(400)
  expect(savedText).toMatch(/nem a levél nyelvén|not in the language of the letter/)
  expect(errors).toEqual([])
})
