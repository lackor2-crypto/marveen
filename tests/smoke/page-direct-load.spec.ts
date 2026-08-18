/**
 * Kozvetlen betoltes (#hash) MINDEN oldalra -- frissites, konyvjelzo, kuldott link.
 *
 * Miert van ez a teszt: a Boss bejelentesere ("az iroda Depo alatti resz nem
 * mukodik. gombok nem csinalnak semmit") ket, egymastol fuggetlen hiba jott ki,
 * es MINDKETTO csak kozvetlen betoltesnel latszott:
 *   1. `Cannot access '_depoPoll' before initialization` -- a lap-iranyitas az
 *      app.js kozepen futott, mikozben az oldal allapot-valtozoi csak a fajl
 *      vegen kapnak erteket. A Depo betoltoje az elso soran elszallt, igy
 *      EGYETLEN gombja sem kapott esemenykezelot.
 *   2. A munkateruelet-visszaallitas a `.active` navigacios linkbol probalta
 *      kitalalni, hol allunk -- de indulaskor meg egyik link sem aktiv, ezert
 *      "ez nem irodai oldal" alapon atdobta a lapot az Emailre.
 *
 * Ezert KET dolgot merunk oldalankent, nem egyet: (a) nem szall el hiba,
 * (b) tenyleg AZ az oldal latszik, amit a cim kert. A masodik nelkul az elso
 * hazug: egy Emailre elugrott lap is "hibatlan".
 */
import { test, expect } from '@playwright/test'

const TOKEN = process.env.DASHBOARD_TOKEN || ''

test('minden oldal kozvetlen betoltese: nincs hiba, ES a kert oldal jon be', async ({ page }) => {
  test.setTimeout(180_000)
  await page.goto(`/?token=${TOKEN}`)
  const oldalak: string[] = await page.evaluate(() =>
    [...document.querySelectorAll('[data-page]')]
      .map((a) => (a as HTMLElement).dataset.page || '')
      .filter((p, i, all) => p && all.indexOf(p) === i && document.getElementById(p + 'Page')))
  expect(oldalak.length).toBeGreaterThan(20)

  const bajok: string[] = []
  for (const oldal of oldalak) {
    const hibak: string[] = []
    page.removeAllListeners('pageerror')
    page.on('pageerror', (e) => hibak.push(e.message))
    await page.goto(`/?token=${TOKEN}#${oldal}`, { waitUntil: 'domcontentloaded' })
      .catch((e) => { if (!/ERR_ABORTED|frame was detached/.test(String(e))) throw e })
    await page.waitForTimeout(700)
    const lathato = await page.evaluate(() =>
      [...document.querySelectorAll('[id$="Page"]')]
        .filter((e) => !(e as HTMLElement).hidden && (e as HTMLElement).offsetParent)
        .map((e) => e.id.replace(/Page$/, '')))
    if (hibak.length) bajok.push(oldal + ' -> HIBA: ' + hibak.join(' | '))
    else if (!lathato.includes(oldal)) bajok.push(oldal + ' -> helyette ez latszik: ' + (lathato.join(', ') || '(semmi)'))
  }
  expect(bajok, 'kozvetlen betoltes').toEqual([])
})

test('Depo oldal: oldalsavbol odanavigalva is bekotott gombok', async ({ page }) => {
  // A masik ut: nem kozvetlen betoltes, hanem navigalas mas oldalrol. A cim
  // valtozasa hajtja a lapvaltast (hashchange), ugyanugy, mint a menukattintas.
  const hibak: string[] = []
  page.on('pageerror', (e) => hibak.push(e.message))
  await page.goto(`/?token=${TOKEN}#overview`)
  await page.waitForTimeout(1200)
  await page.evaluate(() => { location.hash = 'depo' })
  await page.waitForTimeout(2000)
  const a = await page.evaluate(() => ({
    depoLatszik: !!(document.getElementById('depoPage') as HTMLElement)?.offsetParent,
    pickBekotve: !!(document.getElementById('depoPickBtn') as any)?._depoBound,
    root: document.getElementById('depoRootDisplay')?.textContent,
  }))
  expect(hibak).toEqual([])
  expect(a.depoLatszik).toBe(true)
  expect(a.pickBekotve).toBe(true)
  expect(a.root).not.toBe('…')
})

test('Depo oldal: a gombok be vannak kotve, es a valaszto tenyleg megnyilik', async ({ page }) => {
  const hibak: string[] = []
  page.on('pageerror', (e) => hibak.push('PAGEERROR: ' + e.message))
  await page.goto(`/?token=${TOKEN}#depo`)
  await page.waitForTimeout(2500)

  const allapot = await page.evaluate(() => {
    const info = (id: string) => {
      const el = document.getElementById(id) as any
      return el ? { lathato: !!el.offsetParent, bekotve: !!el._depoBound } : 'NINCS ILYEN ELEM'
    }
    return {
      gombok: {
        depoRefreshBtn: info('depoRefreshBtn'), depoPickBtn: info('depoPickBtn'),
        depoMigrateBtn: info('depoMigrateBtn'), depoSyncAddBtn: info('depoSyncAddBtn'),
        depoSyncRunBtn: info('depoSyncRunBtn'),
      },
      rootFelirat: (document.getElementById('depoRootDisplay') || { textContent: 'NINCS' }).textContent,
    }
  })
  expect(hibak, 'a Depo oldal betoltese nem dobhat hibat').toEqual([])
  for (const [id, a] of Object.entries(allapot.gombok)) {
    expect(a, id + ' nincs bekotve vagy nem latszik').toMatchObject({ bekotve: true, lathato: true })
  }
  // A depo helye betoltodott (nem a "…" kezdoertek all benne).
  expect(allapot.rootFelirat).not.toBe('…')

  // `force: true` MERES ALAPJAN: ebben a fejnelkuli kornyezetben a lap egyetlen
  // kepkockat sem rajzol (requestAnimationFrame soha nem sul el, barmelyik
  // oldalon -- ellenorizve overview/depo/drive lapon egyarant). A Playwright
  // "stable" ellenorzese viszont kepkockakat var, ezert MINDEN sima kattintas
  // idotullepesbe fut, meg egy mozdulatlan gombon is. Nem a gomb baja: a
  // kenyszeritett kattintas ugyanitt megnyitja a valasztot.
  await page.click('#depoPickBtn', { force: true })
  await page.waitForTimeout(1500)
  const modal = await page.evaluate(() => {
    const m = document.getElementById('folderPickModal') as any
    return { rejtett: m.hidden, lemezek: document.querySelectorAll('#folderPickList .fp-row').length }
  })
  expect(modal.rejtett, 'a valaszto ablak nem nyilt meg').toBe(false)
  expect(modal.lemezek, 'a valaszto egyetlen lemezt sem sorolt fel').toBeGreaterThan(0)
})
