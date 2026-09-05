/**
 * KULSO (Drive-oldali) TORLES ELLENI VEDELEM -- a bekotes, nem a modul.
 *
 * A `external-delete-guard.test.ts` mar alaposan meri magat a modult
 * (`noteExternalScan`, `recordExternalChange`, `externalGuardEnabled`,
 * `externalSummaryText`) elszigetelten. Ez a fajl mast merte: TENYLEG hivja-e
 * a valodi szinkron-motor a modult, a HELYES pillanatban es a HELYES
 * adatokkal -- es a felulet tenyleg megmutatja-e, amit a modul feljegyzett.
 *
 * A `drive-sync.ts` bejarasa valodi Drive-API-hivasokat es fajlrendszert
 * felteteez, ezert -- a `drive-sync-teljes.test.ts` mintajat kovetve -- a
 * bekotest a FORRASSZOVEGBEN ellenorizzuk: azt merjuk, hogy a hivas a HELYES
 * felteteltel, a HELYES adatokkal all-e ott, nem azt, hogy lefut.
 *
 * A felulet oldalan (`web/app.js`) ugyanez a korlat all fenn, mint az
 * `intezo-source-badge.test.ts`-ben: a fajl tul nagy ahhoz, hogy modulkent
 * betoltodjon, ezert a fuggveny-testet szoveges kivonatkent vizsgaljuk.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..', '..')
const route = readFileSync(join(ROOT, 'src', 'web', 'routes', 'drive-sync.ts'), 'utf8')
const app = readFileSync(join(ROOT, 'web', 'app.js'), 'utf8')
const html = readFileSync(join(ROOT, 'web', 'index.html'), 'utf8')
const hu = readFileSync(join(ROOT, 'web', 'lang', 'hu.js'), 'utf8')
const en = readFileSync(join(ROOT, 'web', 'lang', 'en.js'), 'utf8')

function fnBody(fej: string): string {
  const i = app.indexOf(fej)
  if (i < 0) throw new Error('nincs ilyen fuggveny: ' + fej)
  const veg = app.indexOf('\n}', i)
  return app.slice(i, veg < 0 ? undefined : veg + 2)
}

describe('a szinkron-motor tenyleg hivja a vedelmi modult', () => {
  it('a modul fuggvenyei a valodi motorbol jonnek, nem egy sajat masolatbol', () => {
    expect(route).toMatch(/import \{\s*noteExternalScan, recordExternalChange, externalGuardEnabled, loadExternalChanges,\s*clearExternalChanges, setExternalGuardEnabled, externalSummaryText,?\s*\} from '\.\.\/\.\.\/external-delete-guard\.js'/)
  })

  it('atnevezesnel a kapcsolo ELOTT all: kikapcsolva egy sor sem keletkezik', () => {
    const i = route.indexOf("kind: 'átnevezés'")
    expect(i).toBeGreaterThan(-1)
    const elozmeny = route.slice(Math.max(0, i - 400), i)
    expect(elozmeny).toContain('if (externalGuardEnabled())')
  })

  it('az atnevezes feljegyzese kimondja: a tartalomhoz nem nyult', () => {
    expect(route).toContain(
      'note: `A Drive-on átnevezték, ezért a gépeden is átneveztem: ${known.path} → ${rel}. A tartalomhoz nem nyúltam.`,',
    )
  })

  it('mentes-parosnal a torles-vizsgalat KI van kapcsolva -- ott a Drive a cel, nem forras', () => {
    const i = route.indexOf('noteExternalScan({')
    expect(i).toBeGreaterThan(-1)
    const elozmeny = route.slice(Math.max(0, i - 400), i)
    expect(elozmeny).toContain('if (!pair.backup)')
  })

  it('a nyilvantartott halmaz csak a VALODI (nem-ures) utvonalu bejegyzeseket adja at', () => {
    // Egy ures `path` mezovel rendelkezo bejegyzes nem szamithat "latott
    // fajlnak" -- kulonben egy felig irt allapot hamis torles-jelzest adna.
    expect(route).toContain('if (st && typeof st.path === \'string\' && st.path) tracked.set(id, st.path)')
  })

  it('a "latott-e most" halmaz a bejaras SAJAT halmaza, nem ujraszamolt', () => {
    const i = route.indexOf('noteExternalScan({')
    const call = route.slice(i, route.indexOf('})', i) + 2)
    expect(call).toContain('seen: latottIdk')
  })

  it('a teljesseg a CSONKOLAS listajabol szamitodik, nem kulon jelzobol', () => {
    const i = route.indexOf('noteExternalScan({')
    const call = route.slice(i, route.indexOf('})', i) + 2)
    expect(call).toContain('complete: csonkolt.length === 0')
    expect(call).toContain("incompleteReason: csonkolt.length ? csonkoltSzoveg(csonkolt, MAX_FOLDERS, MAX_FILES) : ''")
  })

  it('a torles-vizsgalat a feltoltesi ag (uploadPhase) ELOTT fut le', () => {
    // Sorrend-fuggo: a torles-jelzesnek a fajlok VEGSO allapotan (state) kell
    // futnia, mielott a felmeno ag barmit is elkezdene.
    expect(route.indexOf('noteExternalScan({')).toBeLessThan(route.indexOf('uploadPhase('))
  })
})

describe('a REST vegpont a modult szolgaltatja ki, nem talal ki semmit', () => {
  it('GET: a friss telepitesen is valaszol -- a ures naplo okat a modul adja, nem a vegpont', () => {
    const i = route.indexOf("path === '/api/drive/sync/external' && method === 'GET'")
    expect(i).toBeGreaterThan(-1)
    const body = route.slice(i, route.indexOf('return true', i))
    expect(body).toContain('enabled: externalGuardEnabled()')
    expect(body).toContain('changes: load.list')
    expect(body).toContain('fileExists: load.fileExists')
    expect(body).toContain('readError: load.readError')
    expect(body).toContain('summary: externalSummaryText(load, lang)')
  })

  it('POST clear: csak a naplot uriti, fajlt nem torol', () => {
    const i = route.indexOf('if (data.clear === true)')
    expect(i).toBeGreaterThan(-1)
    const body = route.slice(i, route.indexOf('return true', i))
    expect(body).toContain('clearExternalChanges()')
    // A kommentnek is ki kell mondania -- ez az, ami a felhasznaloi
    // megerositest (`dguard.clear_confirm`) alatamasztja: tenyleg nincs mit
    // elveszteni a torzsfajlokban.
    expect(route).toContain('// Csak a NAPLOT uriti. Fajlt nem torol -- itt nincs mit elveszteni.')
  })

  it('POST enabled: a kapcsolo allapota tenyleg elmentodik', () => {
    expect(route).toContain('setExternalGuardEnabled(data.enabled)')
  })

  it('POST: hianyos test eseten emberi hibauzenet + gepi kod, nem csendes 200', () => {
    expect(route).toContain("if (typeof data.enabled !== 'boolean')")
    expect(route).toContain("json(res, { error: 'Hiányzik, hogy be- vagy kikapcsoljam a védelmet.', code: 'bad_request' }, 400)")
  })
})

describe('a felulet tenyleg kiolvassa es megjeleniti, amit a modul mond', () => {
  const refresh = fnBody('async function _depoGuardRefresh()')

  it('a valodi hibauzenetet mutatja, nem tippelt okot', () => {
    expect(refresh).toContain('hiba = (e && e.message) ? e.message : String(e)')
    expect(refresh).toContain("sum.textContent = t('dguard.load_failed') + ' ' + hiba")
  })

  it('a kapcsolo allapota a szervertol jon, hianyzo mezonel BEKAPCSOLTNAK szamit', () => {
    // `!== false`: ha a mezo hianyozna, a vedelem NE tunjon kikapcsoltnak.
    expect(refresh).toContain("chk.checked = d.enabled !== false")
  })

  it('az osszefoglalo szoveget a szervertol kapott summary adja, nem itt szamitott', () => {
    expect(refresh).toContain("sum.textContent = d.summary || ''")
  })

  it('a tablazat a NAPLO mind a negy mezojet kiirja', () => {
    expect(refresh).toContain("t('dguard.col_when')")
    expect(refresh).toContain("t('dguard.col_what')")
    expect(refresh).toContain("t('dguard.col_file')")
    expect(refresh).toContain("t('dguard.col_note')")
    expect(refresh).toContain('c.localPath')
    expect(refresh).toContain('c.note')
  })

  it('a kapcsolo atallitasa a szerverre irja, majd ujratolti az allapotot', () => {
    const toggle = fnBody('async function _depoGuardToggle(enabled)')
    expect(toggle).toContain("_depoPost('/api/drive/sync/external', { enabled: !!enabled })")
    expect(toggle).toContain('await _depoGuardRefresh()')
  })

  it('a naplo uritese elott MEGERdOSITEST ker -- visszafordithatatlan (a sorok nem jonnek vissza)', () => {
    const clear = fnBody('async function _depoGuardClear()')
    expect(clear).toContain('if (!confirm(t(\'dguard.clear_confirm\'))) return')
    expect(clear).toContain("_depoPost('/api/drive/sync/external', { clear: true })")
  })

  it('a vedelem allapota FUGGETLENUL frissul a szinkron-lista lekeresetol', () => {
    // Ha a `/api/drive/sync` elhasal, a vedelem allapotat AKKOR is latni kell
    // -- eppen olyankor a legfontosabb tudni, mi tortent a Drive-on.
    const i = app.indexOf('await _depoGuardRefresh()', app.indexOf('async function _depoRefresh'))
    expect(i).toBeGreaterThan(-1)
  })

  it('a gombok es a kapcsolo egyszer vannak bekotve (nem sokszorozodik ujratoltesnel)', () => {
    const wiring = fnBody('async function loadDepoPage()')
    expect(wiring).toContain("bind('depoGuardRefreshBtn', () => _depoGuardRefresh())")
    expect(wiring).toContain("bind('depoGuardClearBtn', () => _depoGuardClear())")
    expect(wiring).toContain('grd._depoBound = 1')
  })
})

describe('a beallito-panel a kepernyon ott van, mindket nyelven', () => {
  it('a panel elemei jelen vannak a HTML-ben', () => {
    expect(html).toContain('id="depoGuardEnabled"')
    expect(html).toContain('id="depoGuardSummary"')
    expect(html).toContain('id="depoGuardList"')
    expect(html).toContain('id="depoGuardRefreshBtn"')
    expect(html).toContain('id="depoGuardClearBtn"')
  })

  it('a feliratok data-i18n-en at johnnek, nem huzva egy nyelven', () => {
    expect(html).toMatch(/data-i18n="dguard\.title"/)
    expect(html).toMatch(/data-i18n="dguard\.what"/)
    expect(html).toMatch(/data-i18n="dguard\.watch_label"/)
    expect(html).toMatch(/data-i18n="dguard\.refresh"/)
    expect(html).toMatch(/data-i18n="dguard\.clear"/)
  })

  const keys = [
    'dguard.title', 'dguard.what', 'dguard.watch_label', 'dguard.refresh', 'dguard.clear',
    'dguard.col_when', 'dguard.col_what', 'dguard.col_file', 'dguard.col_note',
    'dguard.load_failed', 'dguard.save_failed', 'dguard.clear_failed', 'dguard.clear_confirm',
  ]

  it.each(keys)('%s szerepel a magyar es az angol szotarban is, nem uresen', (key) => {
    const mHu = hu.match(new RegExp(`'${key.replace('.', '\\.')}':\\s*'([^']*)'`))
    const mEn = en.match(new RegExp(`'${key.replace('.', '\\.')}':\\s*'([^']*)'`))
    expect(mHu, `hu.js: hianyzik a ${key}`).toBeTruthy()
    expect(mEn, `en.js: hianyzik a ${key}`).toBeTruthy()
    expect((mHu as RegExpMatchArray)[1].trim().length).toBeGreaterThan(0)
    expect((mEn as RegExpMatchArray)[1].trim().length).toBeGreaterThan(0)
  })
})
