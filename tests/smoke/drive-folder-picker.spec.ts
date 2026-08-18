/**
 * Drive-mappa valaszto a Depó oldalon -- VALODI bongeszoben, VALODI Drive-fiokkal.
 *
 * Boss: "miert kezzel kell beirnia a komuvesnek mindig mindent?" -- ez a teszt
 * pontosan azt meri, hogy NEM kell: a mappa-azonosito es a nev a valasztasbol
 * jon. A forras-horgonyokat a src/__tests__/drive-folder-picker.test.ts orzi,
 * ez itt a bizonyitas, hogy vegig is megy.
 *
 * SZANDEKOSAN nem nyomunk "Hozzáadás"-t: az valodi szinkron-parost hozna letre
 * es letoltest inditana. A teszt a valasztas atvetelenel megall.
 *
 * `force: true`: ebben a fejnelkuli kornyezetben a lap egyetlen kepkockat sem
 * rajzol (requestAnimationFrame soha nem sul el), ezert a Playwright "stable"
 * ellenorzese minden sima kattintast idotullepesbe visz. Lasd a
 * page-direct-load.spec.ts megjegyzeset.
 */
import { test, expect, type Page } from '@playwright/test'

const TOKEN = process.env.DASHBOARD_TOKEN || ''

/**
 * Varakozas NEVVEL. A puszta `waitForFunction` idotullepesbol nem derul ki,
 * MELYIK lepes allt meg (fioklista? mappalista? fajlszamlalo?), ezert hiba
 * eseten kiirjuk a lepes nevet ES a kepernyo allapotat. Egy egyszer felbukkano
 * akadas igy nem talany marad, hanem leiras.
 */
async function varj(page: Page, fn: () => boolean, cimke: string, ms = 30_000) {
  try {
    // `polling: 300` KOTELEZO itt. A Playwright alapbol requestAnimationFrame-mel
    // ertekeli ujra a feltetelt -- ebben a fejnelkuli kornyezetben viszont a lap
    // EGYETLEN kepkockat sem rajzol (ezert kell a `force: true` is), vagyis a rAF
    // soha nem sul el. Az alapertelmezessel a varakozas csak akkor sikerult, ha a
    // feltetel MAR az elso ellenorzeskor igaz volt: amikor a Drive valasza kesett
    // egy kicsit, a teszt 30 masodperc utan elbukott -- ugy, hogy kozben a 13
    // mappa ott volt a kepernyon. (Ezt a cimkezett hibauzenet mutatta meg.)
    await page.waitForFunction(fn, null, { timeout: ms, polling: 300 })
  } catch (e) {
    const allapot = await page.evaluate(() => ({
      fiokDb: document.querySelectorAll('#depoSyncAccount option').length,
      valasztoRejtve: (document.getElementById('drivePickModal') as HTMLElement | null)?.hidden,
      sorDb: document.querySelectorAll('#drivePickList [data-dp-go]').length,
      lista: (document.getElementById('drivePickList')?.textContent || '').slice(0, 120),
      uzenet: document.getElementById('drivePickMsg')?.textContent || '',
      valasztva: document.getElementById('depoSyncPicked')?.textContent || '',
      depoAllapot: (document.getElementById('depoHealthText')?.textContent || '').slice(0, 120),
    })).catch(() => null)
    throw new Error(`"${cimke}" nem jott ossze ${ms} ms alatt. Kepernyo: ${JSON.stringify(allapot)}`)
  }
}

/**
 * A mappa-valasztohoz vezeto utat KI KELL NYITNI.
 *
 * A fo ut mostantol egyetlen gomb (a teljes Drive), az egy-mappas valasztas
 * pedig egy osszecsukott `<details>` moge kerult. Egy csukott `details`-ben a
 * gomb ott van a DOM-ban, de nincs layout-doboza, ezert a kattintas -- meg
 * `force: true`-val is -- SEMMIT nem talal el: a valaszto nem nyilik meg, es a
 * teszt kesobb, egy varakozasnal bukik el, latszolag ok nelkul. (Igy bukott el
 * ez a harom teszt elsore.)
 *
 * A `offsetParent` NEM jo merce ra: a Chromium a csukott `details` tartalmat
 * `content-visibility: hidden`-nel rejti, amitol az `offsetParent` tovabbra is
 * nem-null -- vagyis "lathatonak" latszana. A doboz MERETE a valodi merce.
 */
async function nyisdKiAzEgyMappasUtat(page: Page): Promise<void> {
  await page.evaluate(() => {
    const reszletek = document.getElementById('depoSyncOnlyOne') as HTMLDetailsElement | null
    if (reszletek) reszletek.open = true
  })
  await varj(page, () => {
    const b = document.getElementById('depoSyncPickBtn')
    return !!b && b.getBoundingClientRect().height > 0
  }, 'a "csak egy mappát" resz kinyilik, es a valaszto gomb valoban ott van')
}

test('Drive-mappa: kivalasztas utan magatol kitoltodik az azonosito es a nev', async ({ page }) => {
  test.setTimeout(90_000)
  const hibak: string[] = []
  page.on('pageerror', (e) => hibak.push('PAGEERROR: ' + e.message))
  await page.goto(`/?token=${TOKEN}#depo`)
  // Rogzitett varakozas helyett ALLAPOTRA varunk: a fioklista a Google-tol jon,
  // es terhelt gepen tobb masodperc is lehet. (Egy 2,5 mp-es fix varakozas
  // egyszer meg is bukott, pedig a kepernyon minden rendben volt.)
  await varj(page, () => document.querySelectorAll('#depoSyncAccount option').length > 0,
    'a Drive-fiokok legorduloje feltoltodik')

  // Kiindulas: nincs valasztas, ezert a "Hozzáadás" nem indulhat el. Az EGY-
  // mappas ut osszecsukva all (a fo ut a teljes Drive), ezert elobb kinyitjuk.
  const kezdet = await page.evaluate(() => {
    const reszletek = document.getElementById('depoSyncOnlyOne') as HTMLDetailsElement
    const csukva = !reszletek?.open
    if (reszletek) reszletek.open = true
    return {
      csukva,
      // Meret, nem `offsetParent`: lasd a `nyisdKiAzEgyMappasUtat` megjegyzeset.
      pickLathato: ((document.getElementById('depoSyncPickBtn') as HTMLElement)?.getBoundingClientRect().height || 0) > 0,
      addTiltott: (document.getElementById('depoSyncAddBtn') as HTMLButtonElement)?.disabled,
      azonosito: (document.getElementById('depoSyncFolderId') as HTMLInputElement)?.value,
      nev: (document.getElementById('depoSyncName') as HTMLInputElement)?.value,
      fiok: (document.getElementById('depoSyncAccount') as HTMLSelectElement)?.value,
    }
  })
  expect(hibak).toEqual([])
  // Boss: "ne kelljen kivalasztani itt mappakat. az nem kell ide" -- a mappa-
  // valaszto NEM allhat a fo uton, csak a kinyitott "csak egy mappát" alatt.
  expect(kezdet.csukva, 'a mappavalaszto a fo uton all, pedig oda nem valo').toBe(true)
  expect(kezdet.pickLathato, 'nincs kivalaszto gomb').toBe(true)
  expect(kezdet.addTiltott, 'a Hozzáadás valasztas nelkul is aktiv').toBe(true)
  expect(kezdet.azonosito).toBe('')
  expect(kezdet.nev).toBe('')
  expect(kezdet.fiok, 'nincs egyetlen Drive-fiok sem').toBeTruthy()

  // 1. A valaszto megnyilik, es a SAJAT MEGHAJTO tartalmat mutatja.
  await page.click('#depoSyncPickBtn', { force: true })
  // A Drive-lekerdezes valaszara varunk, nem az orara: amig a lista a
  // "Betöltés…" feliratot mutatja, nincs mit merni.
  await varj(page, () =>
    document.querySelectorAll('#drivePickList [data-dp-go]').length > 0
    || !!document.getElementById('drivePickMsg')?.textContent,
  'a Saját meghajtó tartalma megjon a Drive-tol')
  const gyoker = await page.evaluate(() => ({
    rejtett: (document.getElementById('drivePickModal') as HTMLElement).hidden,
    hol: document.getElementById('drivePickHere')?.textContent,
    mappak: [...document.querySelectorAll('#drivePickList [data-dp-go]')]
      .map((b) => b.getAttribute('data-dp-name')),
    okTiltott: (document.getElementById('drivePickOk') as HTMLButtonElement).disabled,
    uzenet: document.getElementById('drivePickMsg')?.textContent,
  }))
  expect(gyoker.rejtett, 'a valaszto nem nyilt meg').toBe(false)
  // A gyokerben nem hibauzenet all, hanem az ELIGAZITAS: miert szurke a gomb,
  // es mi a teendo. (Boss: "fogalmam sincsen ... mit kell kivalasztani".)
  // MINDKET utat ki kell mondania: a gyoker maga nem valaszthato, mert arra a
  // kartyan van egy sajat gomb (a teljes Drive) -- egy mappahoz pedig be kell lepni.
  expect(gyoker.uzenet, 'nem mondja meg, hogy az EGESZ Drive-hoz a kartyan van gomb').toContain('teljes Drive')
  expect(gyoker.uzenet, 'nem mondja meg, hogy egy mappahoz be kell lepni').toContain('lépj bele')
  expect(gyoker.uzenet, 'hiba a Drive lekerdezesekor').not.toContain('nem sikerült')
  expect(gyoker.mappak.length, 'egyetlen Drive-mappat sem sorolt fel').toBeGreaterThan(0)
  // A gyokeret magat nem lehet valasztani: az az EGESZ Drive lenne.
  expect(gyoker.okTiltott, 'a gyokeret is engedne kivalasztani').toBe(true)

  // 2. Belepunk az elso mappaba: innen mar valaszthato.
  await page.click('#drivePickList [data-dp-go]', { force: true })
  // Ismet allapotra varunk: a mappa akkor toltott be, ha mar kiirta, hany fajl
  // van benne (ezt a _dpLoad a valasz UTAN teszi ki).
  await varj(page, () => /\d/.test(document.getElementById('drivePickMsg')?.textContent || ''),
    'a megnyitott mappa tartalma megjon (fajlszamlalo)')
  const bent = await page.evaluate(() => ({
    hol: document.getElementById('drivePickHere')?.textContent || '',
    okTiltott: (document.getElementById('drivePickOk') as HTMLButtonElement).disabled,
    vissza: (document.getElementById('drivePickUp') as HTMLButtonElement).disabled,
    uzenet: document.getElementById('drivePickMsg')?.textContent || '',
  }))
  expect(bent.hol, 'az utvonal nem bovult').toContain(' / ')
  expect(bent.okTiltott).toBe(false)
  expect(bent.vissza, 'a Vissza gomb nem elheto egy mappaban').toBe(false)
  expect(bent.uzenet, 'nem irja ki, hany fajl van itt').toMatch(/\d/)

  // 3. Elfogadjuk: ettol tolodik ki az azonosito ES a nev -- gepeles nelkul.
  await page.click('#drivePickOk', { force: true })
  await page.waitForTimeout(600)
  const utana = await page.evaluate(() => ({
    modalRejtve: (document.getElementById('drivePickModal') as HTMLElement).hidden,
    azonosito: (document.getElementById('depoSyncFolderId') as HTMLInputElement).value,
    nev: (document.getElementById('depoSyncName') as HTMLInputElement).value,
    nevTipus: (document.getElementById('depoSyncName') as HTMLInputElement).type,
    addTiltott: (document.getElementById('depoSyncAddBtn') as HTMLButtonElement).disabled,
    felirat: document.getElementById('depoSyncPicked')?.textContent || '',
  }))
  expect(utana.modalRejtve).toBe(true)
  expect(utana.azonosito, 'az azonosito nem toltodott ki').toMatch(/^[A-Za-z0-9_-]{6,}$/)
  expect(utana.nev, 'a nev nem toltodott ki').not.toBe('')
  // A nev REJTETT: nem lehet atirni. Boss: "a lackor2 legyen lackor2. igy nincs
  // keveredes" -- egy atirt nev ket fiok tartalmat sodorhatna egy mappaba.
  expect(utana.nevTipus, 'a nevet at lehet irni a kepernyon').toBe('hidden')
  expect(utana.addTiltott, 'a Hozzáadás valasztas utan is tiltott').toBe(false)
  expect(utana.felirat, 'nem irja ki, mit valasztottunk').toContain(utana.nev)
  expect(hibak).toEqual([])

  // 4. Fiokvaltas: a masik fiokban ez az azonosito ervenytelen, tehat el kell
  //    dobni. (Csak akkor merheto, ha tobb fiok van; egynel az esemeny is jo.)
  const eldobva = await page.evaluate(() => {
    const sel = document.getElementById('depoSyncAccount') as HTMLSelectElement
    sel.dispatchEvent(new Event('change'))
    return {
      azonosito: (document.getElementById('depoSyncFolderId') as HTMLInputElement).value,
      addTiltott: (document.getElementById('depoSyncAddBtn') as HTMLButtonElement).disabled,
      nev: (document.getElementById('depoSyncName') as HTMLInputElement).value,
    }
  })
  expect(eldobva.azonosito, 'fiokvaltas utan bennemaradt a regi azonosito').toBe('')
  expect(eldobva.addTiltott).toBe(true)
  expect(eldobva.nev, 'fiokvaltas utan bennemaradt a regi nev').toBe('')
})

/**
 * A FO UT: egesz Drive egy gombbal. Boss, 2026-08-15: "mit akarok
 * szinkronizalni. hat a lackor2 drivot mindenestul! akkor itt nincs tovabb
 * kerdes semmi."
 *
 * A hozzaadast ELFOGJUK: valodi parost nem hozunk letre (az 5,47 GB-ot kezdene
 * el lehozni a hatterben), de a KULDOTT keresre ranezunk -- eppen az a lenyeg,
 * hogy `root` megy es NINCS nev.
 */
test('egy gombbal a TELJES Drive kerul a listara -- mappavalasztas nelkul', async ({ page }) => {
  test.setTimeout(60_000)
  const hibak: string[] = []
  page.on('pageerror', (e) => hibak.push('PAGEERROR: ' + e.message))
  let kuldott: any = null
  await page.route('**/api/drive/sync/add', async (route) => {
    kuldott = JSON.parse(route.request().postData() || '{}')
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ ok: true, pair: { id: 'teszt', account: kuldott.account, folderId: 'root', name: '' } }),
    })
  })
  // A megerosites-parbeszedet automatikusan elfogadjuk (a fejnelkuli bongeszo
  // kulonben magatol elutasitana, es a keres el sem indulna).
  page.on('dialog', (d) => void d.accept())

  await page.goto(`/?token=${TOKEN}#depo`)
  await varj(page, () => document.querySelectorAll('#depoSyncAccount option').length > 0,
    'a Drive-fiokok legorduloje feltoltodik')

  const fiok = await page.evaluate(() => (document.getElementById('depoSyncAccount') as HTMLSelectElement).value)
  await page.click('#depoSyncWholeBtn', { force: true })
  // A megerosites + a keres egy korfordulo; a valaszra varunk, nem az orara.
  await page.waitForResponse((r) => r.url().includes('/api/drive/sync/add'), { timeout: 20_000 })

  expect(hibak).toEqual([])
  expect(kuldott, 'a teljes Drive gombja nem kuldott hozzaadas-kerest').toBeTruthy()
  expect(kuldott.folderId, 'nem a Drive gyokeret kuldte').toBe('root')
  expect(kuldott.name, 'megis nevet kuldott -- pedig nincs mit elnevezni').toBe('')
  expect(kuldott.account).toBe(fiok)
  // A modal NEM nyilt meg: ez volt a Boss panasza ("ne kelljen kivalasztani itt
  // mappakat"). Ha megnyilt volna, a fo ut megint mappavalasztassal kezdodne.
  const modalRejtve = await page.evaluate(() => (document.getElementById('drivePickModal') as HTMLElement).hidden)
  expect(modalRejtve, 'a teljes Drive gombja megnyitotta a mappavalasztot').toBe(true)
})

/**
 * ELLENSEGES MAPPANEV. A mappa nevet a Google adja vissza, es BARKI adhat nevet
 * egy mappanak, amit aztan megoszt veled -- tehat ez IDEGEN szoveg, nem a mi
 * adatunk. Itt nem allitjuk, hogy biztonsagos: MEGMERJUK, hamis valaszt adva a
 * /api/drive/list helyett.
 */
test('a Drive-bol jovo mappanev nem tud kodot futtatni', async ({ page }) => {
  test.setTimeout(60_000)
  const CSUNYA_1 = 'x" onmouseover="window.__pwned=1'
  const CSUNYA_2 = '<img src=x onerror="window.__pwned=2">'
  await page.route('**/api/drive/list*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ files: [
        { id: 'AAA111', name: CSUNYA_1, isFolder: true },
        { id: 'BBB222', name: CSUNYA_2, isFolder: true },
      ] }),
    }))
  await page.goto(`/?token=${TOKEN}#depo`)
  await varj(page, () => document.querySelectorAll('#depoSyncAccount option').length > 0,
    'a Drive-fiokok legorduloje feltoltodik')
  await nyisdKiAzEgyMappasUtat(page)
  await page.click('#depoSyncPickBtn', { force: true })
  await varj(page, () => document.querySelectorAll('#drivePickList [data-dp-go]').length === 2,
    'a ket ellenseges nevu mappa kirajzolodik')

  const a = await page.evaluate(() => ({
    sorok: [...document.querySelectorAll('#drivePickList [data-dp-go]')]
      .map((b) => (b.querySelector('.fp-name') as HTMLElement).textContent),
    kepek: document.querySelectorAll('#drivePickList img').length,
    pwned: (window as any).__pwned,
  }))
  // A nev SZOVEGKENT jelenik meg, betuhiven -- nem elemkent, nem esemenykent.
  expect(a.sorok).toEqual([CSUNYA_1, CSUNYA_2])
  expect(a.kepek, 'a mappanevbol <img> elem lett').toBe(0)
  expect(a.pwned, 'a mappanev kodot futtatott').toBeUndefined()

  // Belepve is: a nev az utvonalba is szovegkent kerul.
  await page.click('#drivePickList [data-dp-go]', { force: true })
  await page.waitForTimeout(800)
  const b = await page.evaluate(() => ({
    hol: document.getElementById('drivePickHere')?.textContent || '',
    pwned: (window as any).__pwned,
  }))
  expect(b.hol).toContain(CSUNYA_1)
  expect(b.pwned).toBeUndefined()
})

/**
 * GYORS KATTINTAS. Ha ket mappat kattint egymas utan, a LASSABB (korabbi)
 * valasz nem irhatja felul a frissebbet -- kulonben mas mappa tartalmat latna,
 * mint amiben all, es a rossz mappat adna hozza.
 */
test('a keson beeso valasz nem irja felul a frissebb mappat', async ({ page }) => {
  test.setTimeout(60_000)
  await page.route('**/api/drive/list*', async (route) => {
    const id = new URL(route.request().url()).searchParams.get('folderId')
    const valasz = (files: any[]) => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify({ files }),
    })
    if (id === 'LASSU') {
      // Ez a valasz KESIK: a masodik kattintas valasza elobb er be.
      await new Promise((r) => setTimeout(r, 2500))
      return valasz([{ id: 'LASSU-GYEREK', name: 'lassu gyerek', isFolder: true }])
    }
    if (id === 'GYORS') return valasz([{ id: 'GYORS-GYEREK', name: 'gyors gyerek', isFolder: true }])
    return valasz([
      { id: 'LASSU', name: 'lassu mappa', isFolder: true },
      { id: 'GYORS', name: 'gyors mappa', isFolder: true },
    ])
  })
  await page.goto(`/?token=${TOKEN}#depo`)
  await varj(page, () => document.querySelectorAll('#depoSyncAccount option').length > 0,
    'a Drive-fiokok legorduloje feltoltodik')
  await nyisdKiAzEgyMappasUtat(page)
  await page.click('#depoSyncPickBtn', { force: true })
  await varj(page, () => !!document.querySelector('[data-dp-go="LASSU"]'),
    'a lassu es a gyors mappa kirajzolodik')

  await page.click('[data-dp-go="LASSU"]', { force: true })
  await page.waitForTimeout(150)
  // A lassu meg tolt, de mi mar tovabbleptunk egy masik mappaba.
  await page.evaluate(() => { (window as any)._dpEnter('GYORS', 'gyors mappa') })
  await page.waitForTimeout(3500)   // a lassu valasz addigra biztosan beert

  const v = await page.evaluate(() => ({
    hol: document.getElementById('drivePickHere')?.textContent || '',
    sorok: [...document.querySelectorAll('#drivePickList [data-dp-go]')]
      .map((b) => b.getAttribute('data-dp-name')),
  }))
  expect(v.hol, 'az utvonal a lassu mappat mutatja').toContain('gyors mappa')
  expect(v.sorok, 'a keson beeso valasz irta felul a listat').toEqual(['gyors gyerek'])
})

/**
 * A KET DOLOGNAK SEMMI KOZE EGYMASHOZ. A fioklista korabban a depo-allapot
 * lekerdezese UTAN toltodott fel, annak a hibaaga pedig `return`-nel kilep --
 * vagyis egy dontott depo-allapot NEMAN megette a Drive-fiokokat is, es a
 * valaszto csak annyit mondott: "Előbb válaszd ki, melyik fiókból nézzük."
 * Itt szandekosan eldontjuk a depo-allapotot, es megmerjuk, hogy a valaszto
 * ettol fuggetlenul mukodik.
 */
test('dontott depo-allapot mellett is hasznalhato a Drive-valaszto', async ({ page }) => {
  test.setTimeout(60_000)
  await page.route('**/api/depot/status*', (route) =>
    route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'szandekos teszthiba' }) }))
  await page.goto(`/?token=${TOKEN}#depo`)
  await varj(page, () => document.querySelectorAll('#depoSyncAccount option').length > 0,
    'a fioklista a dontott depo-allapot ellenere is feltoltodik')

  await nyisdKiAzEgyMappasUtat(page)
  const v = await page.evaluate(() => ({
    fiokDb: document.querySelectorAll('#depoSyncAccount option').length,
    depoHiba: document.getElementById('depoHealthText')?.textContent || '',
    pickLathato: ((document.getElementById('depoSyncPickBtn') as HTMLElement)?.getBoundingClientRect().height || 0) > 0,
    foGombVan: ((document.getElementById('depoSyncWholeBtn') as HTMLElement)?.getBoundingClientRect().height || 0) > 0,
    foGombTiltott: !!(document.getElementById('depoSyncWholeBtn') as HTMLButtonElement)?.disabled,
  }))
  // A depo-allapot valoban elromlott -- vagyis a meres ELES helyzetet mer.
  expect(v.depoHiba, 'a depo-allapot hibaja nem latszik').toContain('szandekos teszthiba')
  expect(v.fiokDb, 'a depo-hiba magaval rantotta a fioklistat').toBeGreaterThan(0)
  expect(v.pickLathato).toBe(true)
  // A FO gomb (a teljes Drive) sem tunhet el egy dontott allapot-lekerdezestol:
  // ha a depo tenyleg nem irhato, azt a kiszolgalo mondja meg (409), nem egy
  // nemán letiltott gomb.
  expect(v.foGombVan, 'a teljes Drive gombja eltunt a depo-hibatol').toBe(true)
  expect(v.foGombTiltott, 'a teljes Drive gombja nemán le van tiltva').toBe(false)

  // Es a valaszto is megnyilik: nem csak a legordulo van meg, hanem mukodik is.
  await page.click('#depoSyncPickBtn', { force: true })
  await varj(page, () =>
    document.querySelectorAll('#drivePickList [data-dp-go]').length > 0
    || !!document.getElementById('drivePickMsg')?.textContent,
  'a valaszto a depo-hiba utan is megnyilik')
  const nyilt = await page.evaluate(() => ({
    rejtett: (document.getElementById('drivePickModal') as HTMLElement).hidden,
    sorDb: document.querySelectorAll('#drivePickList [data-dp-go]').length,
  }))
  expect(nyilt.rejtett).toBe(false)
  expect(nyilt.sorDb, 'egyetlen mappat sem sorolt fel').toBeGreaterThan(0)
})
