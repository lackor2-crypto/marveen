/**
 * A GEPEM MENTESE A DRIVE-RA (#47) -- a kartya a FELULETROL.
 *
 * Elofeltetel: fusson a dashboard, es legyen DASHBOARD_TOKEN.
 *   DASHBOARD_TOKEN=$(cat store/.dashboard-token) npm run smoke
 *
 * Amit ez fog meg, es amit a unit-teszt nem tud: a kartya megjelenik-e, a
 * legordulo feltoltodik-e valodi adatbol, a gombok be vannak-e kotve, es hogy a
 * "Mentés bekötése" SZURKE marad, amig nem futott meres. Ez utobbi a lenyeg:
 * bekotes utan a gep magatol kezd feltolteni minden ejjel -- azt nem szabad
 * ugy elinditani, hogy a merteket a felhasznalo csak utana latja meg.
 *
 * A teszt SEMMIT nem kot be: a merest inditja el, a bekotest nem.
 */

import { test, expect } from '@playwright/test'

const TOKEN = process.env.DASHBOARD_TOKEN || ''

// Token nelkul a dashboard a BEJELENTKEZO kepernyot adja: a kartya elemei ott
// vannak a HTML-ben, csak soha nem telnek meg. A teszt ilyenkor 20 masodpercet
// varna egy legordulore, es ugy bukna el, mintha az romlott volna el. Ezert
// inkabb ITT allunk meg, es megmondjuk a valodi okot.
test.beforeAll(() => {
  if (!TOKEN) {
    throw new Error(
      'Nincs DASHBOARD_TOKEN. A teszt token nelkul a bejelentkezo kepernyot merne. '
      + 'Inditsd igy: scripts/smoke-mentes.sh',
    )
  }
})

// A Raktar lap frissitese TOBB vegpontot kerdez le, es a raktar egy 9p-n
// csatolt Windows-meghajto: a 30 masodperces alapertelmezes ide keves.
// Sorosan futnak, kulonben harom parhuzamos bongeszo ugyanazt a lassu
// bejarast inditja el egyszerre.
test.describe.configure({ mode: 'serial', timeout: 180_000 })

test.describe('Raktár – a gépem mentése a Drive-ra', () => {
  test('a kártya ott van, a legördülők valódi adatból telnek meg, a gombok be vannak kötve', async ({ page }) => {
    await page.goto(`/?token=${TOKEN}#depo`)
    await page.waitForSelector('#depoBackupCard', { timeout: 15000 })
    // A legordulo AJAX-bol tolt: megvarjuk, amig valodi sor lesz benne.
    await page.waitForFunction(
      () => (document.getElementById('depoBackupBranch') as HTMLSelectElement)?.options.length > 1,
      null,
      { timeout: 20000, polling: 300 },
    )

    const a = await page.evaluate(() => {
      const sel = document.getElementById('depoBackupBranch') as HTMLSelectElement
      const fiok = document.getElementById('depoBackupAccount') as HTMLSelectElement
      const opciok = Array.from(sel.options).map((o) => ({ ertek: o.value, szoveg: o.text, tiltott: o.disabled }))
      return {
        elsoErtek: opciok[0].ertek,
        elsoSzoveg: opciok[0].szoveg,
        agakSzama: opciok.length,
        tiltottak: opciok.filter((o) => o.tiltott).map((o) => o.ertek),
        fiokokSzama: fiok.options.length,
        // A megjegyzes-sor URES, ha latunk a raktarba. Ha nem latnank, ITT
        // allna, hogy miert -- nem az ures listabol kellene kitalalni.
        megjegyzes: (document.getElementById('depoBackupNote') || { textContent: '' }).textContent!.trim(),
        gombSzurke: (document.getElementById('depoBackupAddBtn') as HTMLButtonElement).disabled,
        merGombVan: !!document.getElementById('depoBackupPreviewBtn'),
      }
    })

    // Az elso sor mindig a teljes raktar (ures ertek), utana az agak.
    expect(a.elsoErtek).toBe('')
    expect(a.elsoSzoveg.length).toBeGreaterThan(0)
    expect(a.agakSzama).toBeGreaterThan(1)
    expect(a.megjegyzes).toBe('')
    // A Rendszer ag LATSZIK, de nem valaszthato -- ha egyszeruen kihagynank,
    // a Boss azt hinne, eltunt, es keresne.
    expect(a.tiltottak).toContain('Rendszer')
    expect(a.fiokokSzama).toBeGreaterThan(0)
    expect(a.merGombVan).toBe(true)
    // MERES NELKUL NINCS BEKOTES.
    expect(a.gombSzurke).toBe(true)
  })

  test('a mérés valódi számokat ír ki, és csak utána enged bekötni', async ({ page }) => {
    await page.goto(`/?token=${TOKEN}#depo`)
    await page.waitForSelector('#depoBackupCard', { timeout: 15000 })
    await page.waitForFunction(
      () => (document.getElementById('depoBackupBranch') as HTMLSelectElement)?.options.length > 1
        && (document.getElementById('depoBackupAccount') as HTMLSelectElement)?.options.length > 0,
      null,
      { timeout: 20000, polling: 300 },
    )

    // `force: true`: ebben a fejnelkuli kornyezetben a lap egyetlen kepkockat
    // sem rajzol, a Playwright "stable" ellenorzese viszont kepkockakat var --
    // enelkul MINDEN kattintas idotullepesbe fut, meg egy mozdulatlan gombon is.
    await page.click('#depoBackupPreviewBtn', { force: true })
    await page.waitForFunction(
      () => {
        const el = document.getElementById('depoBackupPreview')
        return !!el && el.textContent!.trim().length > 0 && !/Mérem|Measuring/.test(el.textContent!)
      },
      null,
      { timeout: 180000, polling: 300 },
    )

    const b = await page.evaluate(() => ({
      szoveg: document.getElementById('depoBackupPreview')!.textContent!.trim(),
      gombSzurke: (document.getElementById('depoBackupAddBtn') as HTMLButtonElement).disabled,
    }))

    // Szam es meret is van benne -- nem altalanossag.
    expect(b.szoveg).toMatch(/\d/)
    // A szabad helyrol MINDIG mond valamit: vagy hogy elfer, vagy hogy nem,
    // vagy hogy nem tudta megkerdezni -- de nem hallgat rola.
    expect(b.szoveg).toMatch(/Drive|hely|space|free/i)
    // A meres utan a bekotes engedelyezett.
    expect(b.gombSzurke).toBe(false)
  })

  test('másik ág választása érvényteleníti a mérést (a gomb újra szürke)', async ({ page }) => {
    await page.goto(`/?token=${TOKEN}#depo`)
    await page.waitForSelector('#depoBackupCard', { timeout: 15000 })
    await page.waitForFunction(
      () => (document.getElementById('depoBackupBranch') as HTMLSelectElement)?.options.length > 2,
      null,
      { timeout: 20000, polling: 300 },
    )

    // Egy valaszthato (nem tiltott) ag, ami NEM az elso sor.
    const masik = await page.evaluate(() => {
      const sel = document.getElementById('depoBackupBranch') as HTMLSelectElement
      const o = Array.from(sel.options).find((x) => !x.disabled && x.value !== '')
      return o ? o.value : ''
    })
    expect(masik).not.toBe('')

    // `force: true`: ebben a fejnelkuli kornyezetben a lap egyetlen kepkockat
    // sem rajzol, a Playwright "stable" ellenorzese viszont kepkockakat var --
    // enelkul MINDEN kattintas idotullepesbe fut, meg egy mozdulatlan gombon is.
    await page.click('#depoBackupPreviewBtn', { force: true })
    await page.waitForFunction(
      () => !(document.getElementById('depoBackupAddBtn') as HTMLButtonElement).disabled,
      null,
      { timeout: 180000, polling: 300 },
    )

    await page.selectOption('#depoBackupBranch', masik, { force: true })
    const szurke = await page.evaluate(
      () => (document.getElementById('depoBackupAddBtn') as HTMLButtonElement).disabled,
    )
    // Kulonben a Boss megmerne az egyik agat, atvaltana egy masikra, es a
    // MASIKAT kotne be a latott szamok alapjan.
    expect(szurke).toBe(true)
  })
})
