// A CSEND KET DOLGOT JELENTHET -- A BEJELENTKEZESNEL IS.
//
// Boss, 2026-08-30: "hat amikor bejelentkeztem a jo email cimmel akkor meg nem
// sikerult a bejelentkezes" -- es kulon mondatban: "de amikor rosz email
// cimmel probaltam legalabb mar szolt hogy mi van..."
//
// A ket mondat egyutt irja le a hibat. A ROSSZ cimnel az or ket WARN sort
// hagyott a naploban es egy figyelmeztetest a kepernyon; a JO cimnel a
// store/dashboard.log 01:01:17.796-os `login session started` sora utan
// SEMMI nem kovetkezett -- se siker, se hiba. Kivulrol a "sikerult" es a
// "felbeszakadt" pontosan egyforman nezett ki: csend. A felhasznalo ebbol
// bukast olvasott, es ujra meg ujra a bejelentkezest javitotta.
//
// Harom kulon meres, harom kulon vedelem:
//   1. A SIKER IS NAPLOZ -- utolag eldontheto legyen, melyik tortent.
//   2. A NEMA LEZARULAS IS MEGSZOLAL -- hibauzenet nelkul is mondatot kap.
//   3. A BEJELENTKEZES UTAN A KERET-LIMITET IS KIMONDJUK -- a lackor3
//      hitelesitese rendben volt, a heti keret (7d 100%) allitotta meg.
//      Enelkul a felhasznalo a rossz dolgot javitja.
// Es negyedikkent a datum: a kartyan "Mon 09:00 PM" allt egy magyar mondat
// kozepen, mert a formazas a BONGESZO nyelvet vette.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const RUNNER = readFileSync('src/web/claude-auth-runner.ts', 'utf-8')
const APP = readFileSync('web/app.js', 'utf-8')
const HU = readFileSync('web/lang/hu.js', 'utf-8')
const EN = readFileSync('web/lang/en.js', 'utf-8')

/** A datum-formazot kiemeljuk a forrasbol es LEFUTTATJUK -- a szoveg-egyezes
 *  nem bizonyitana, hogy tenyleg magyar datum jon ki. */
function quotaResetText(lang: string): (ms: number) => string | null {
  const kezd = APP.indexOf('function quotaResetText(resetsAt) {')
  expect(kezd).toBeGreaterThan(-1)
  const veg = APP.indexOf('\n}\n', kezd)
  const forras = APP.slice(kezd, veg + 2)
  const gyar = new Function('window', 't', `${forras}; return quotaResetText`)
  return gyar({ _lang: lang }, (k: string) => k) as (ms: number) => string | null
}

describe('1) a siker is nyomot hagy a naploban', () => {
  it('a rendben-ag INFO sort ir', () => {
    expect(RUNNER).toContain("'claude-auth: bejelentkezes SIKERULT'")
  })

  it('a dontes EGY valtozoban all, es a valasz abbol veszi a loginOk-ot', () => {
    expect(RUNNER).toContain('const rendben = !drift && registered')
    expect(RUNNER).toContain('loginOk: rendben,')
    // A regi, ket helyen kiszamolt alak nem johet vissza.
    expect(RUNNER).not.toContain('loginOk: !drift && registered')
  })

  it('a nyilvantartasba felvetel bukasa is naplozik, nem csak a valaszban all', () => {
    expect(RUNNER).toContain('a bejelentkezes letrejott, de a nyilvantartasba felvetel BUKOTT')
  })

  it('a naplozas a killSession UTAN, de a valasz ELOTT all (a drift mar eldolt)', () => {
    const driftDontes = RUNNER.indexOf('const rendben = !drift && registered')
    const visszavonas = RUNNER.indexOf('a rossz fiokkal letrejott bejelentkezes visszavonva')
    expect(visszavonas).toBeGreaterThan(-1)
    expect(driftDontes).toBeGreaterThan(visszavonas)
  })
})

describe('2) a nema lezarulas is megszolal', () => {
  it('a nem-aktiv agnak van else-ága, hibauzenet nelkul is', () => {
    expect(APP).toContain("showToast(t('claudeauth.ended_unknown'), { type: 'warn', big: true })")
  })

  it('a mondat NEM talalgat okot -- azt mondja, hogy nem tudja', () => {
    const sor = HU.match(/'claudeauth\.ended_unknown':\s*'([^']*)'/)
    expect(sor).not.toBeNull()
    const szoveg = sor![1]
    expect(szoveg).toContain('NEM tudom megmondani')
    // Es megmondja a KOVETKEZO LEPEST.
    expect(szoveg.toLowerCase()).toContain('ágens kártyáján'.toLowerCase())
  })

  it('a figyelmeztetes ragadós (nem villan el 8 masodperc alatt)', () => {
    const kezd = APP.indexOf("} else {\n      // A CSEND NEM VALASZ.")
    expect(kezd).toBeGreaterThan(-1)
    const blokk = APP.slice(kezd, kezd + 1200)
    expect(blokk).toContain("{ type: 'warn', big: true }")
    expect(blokk).not.toMatch(/showToast\(t\('claudeauth\.ended_unknown'\),\s*\d/)
  })

  it('a sajat Megse gomb nem jut ide: elobb allitja le a lekerdezest', () => {
    const kezd = APP.indexOf("document.getElementById('claudeAuthCancelBtn')")
    expect(kezd).toBeGreaterThan(-1)
    const blokk = APP.slice(kezd, kezd + 400)
    const stop = blokk.indexOf('_claudeAuthStopPoll()')
    const hivas = blokk.indexOf('/api/accounts/claude/login/cancel')
    expect(stop).toBeGreaterThan(-1)
    expect(stop).toBeLessThan(hivas)
  })
})

describe('3) sikeres bejelentkezes utan a keret-limit is elhangzik', () => {
  it('van segedfuggveny, es a KARTYATOL kerdezi meg az allapotot', () => {
    expect(APP).toContain('async function _claudeAuthWarnIfQuotaBlocked(agentName) {')
    const kezd = APP.indexOf('async function _claudeAuthWarnIfQuotaBlocked(agentName) {')
    const blokk = APP.slice(kezd, kezd + 1000)
    expect(blokk).toContain("fetch('/api/agents')")
    expect(blokk).toContain("row.contextState !== 'quota-blocked'")
  })

  it('ha nem tudja megkerdezni, HALLGAT -- nem talalgat okot', () => {
    const kezd = APP.indexOf('async function _claudeAuthWarnIfQuotaBlocked(agentName) {')
    const blokk = APP.slice(kezd, kezd + 1000)
    expect(blokk).toContain('nem talalgatok')
    expect(blokk).not.toContain("showToast(t('agents.auth.login_ok_but_quota'), 8000)")
  })

  it('csak a SIKERES ag hivja, az ujrainditas utan', () => {
    // A horgon BELUL nezzuk a sorrendet: a lapon tobb helyen is van
    // /restart hivas, a globalis indexOf a legelsot talalna meg. 2026-09-01
    // ota a `_claudeAuthOnDone = async (s) => {` szoveg MASODSZOR is
    // megjelenik a fajlban (wireAccountLogoutButton, a Beallitasok
    // dobozhoz -- az korabban all, mint handleAgentLogin) -- ezert a
    // keresest a fuggveny SAJAT kezdetehez rogzitjuk, nem az elso
    // egyezeshez az egesz fajlban.
    const fnStart = APP.indexOf('async function handleAgentLogin(')
    expect(fnStart, 'handleAgentLogin not found').toBeGreaterThan(-1)
    const kezd = APP.indexOf('_claudeAuthOnDone = async (s) => {', fnStart)
    expect(kezd).toBeGreaterThan(-1)
    const horog = APP.slice(kezd, APP.indexOf('\n    }\n', kezd))
    const okKapu = horog.indexOf('if (!_claudeAuthDoneOk(s)) { loadAgents(); return }')
    const ujrainditas = horog.indexOf("/restart`, { method: 'POST' })")
    const hivas = horog.indexOf('await _claudeAuthWarnIfQuotaBlocked(agentName)')
    expect(okKapu).toBeGreaterThan(-1)
    expect(ujrainditas).toBeGreaterThan(okKapu)
    expect(hivas).toBeGreaterThan(ujrainditas)
  })

  it('a mondat kimondja, hogy UJABB BEJELENTKEZES NEM SEGIT', () => {
    for (const k of ['agents.auth.login_ok_but_quota', 'agents.auth.login_ok_but_quota_unknown']) {
      const sor = HU.match(new RegExp(`'${k.replace(/\./g, '\\.')}':\\s*'([^']*)'`))
      expect(sor, k).not.toBeNull()
      expect(sor![1]).toContain('nem segít')
      expect(sor![1]).toContain('NEM tud dolgozni')
    }
  })

  it('a ket eset kulon kulcs: tudjuk-e, mikor nyilik ujra', () => {
    expect(HU).toContain("'agents.auth.login_ok_but_quota':")
    expect(HU).toContain("'agents.auth.login_ok_but_quota_unknown':")
    const ismert = HU.match(/'agents\.auth\.login_ok_but_quota':\s*'([^']*)'/)![1]
    const ismeretlen = HU.match(/'agents\.auth\.login_ok_but_quota_unknown':\s*'([^']*)'/)![1]
    expect(ismert).toContain('{when}')
    expect(ismeretlen).not.toContain('{when}')
    expect(ismeretlen).toContain('nem írta le')
  })
})

describe('4) a kvota-datum a LAP nyelven all, nem a bongeszoen', () => {
  it('a formazas nem a bongeszo nyelvet veszi', () => {
    expect(APP).not.toContain('toLocaleString(undefined, {')
  })

  it('magyar feluleten magyar datum jon ki (lefuttatva)', () => {
    const holnap = Date.now() + 26 * 3600 * 1000
    const hu = quotaResetText('hu')(holnap)
    expect(hu).not.toBeNull()
    // Az angol formatum ket arulkodo jele: AM/PM es a harombetus angol napnev.
    expect(hu!).not.toMatch(/\b(AM|PM)\b/)
    expect(hu!).not.toMatch(/\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b/)
  })

  it('angol feluleten angol datum jon ki (lefuttatva)', () => {
    const holnap = Date.now() + 26 * 3600 * 1000
    const en = quotaResetText('en')(holnap)
    expect(en).not.toBeNull()
    expect(en!).toMatch(/\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b/)
  })

  it('a mar lejart idopontra tovabbra sem datumot mond', () => {
    expect(quotaResetText('hu')(Date.now() - 60_000)).toBe('agents.ctx.quota_reset_now')
  })
})

describe('5) minden uj szoveg ketnyelvu', () => {
  const kulcsok = [
    'claudeauth.ended_unknown',
    'agents.auth.login_ok_but_quota',
    'agents.auth.login_ok_but_quota_unknown',
  ]
  for (const k of kulcsok) {
    it(`${k} megvan hu-ban es en-ben is`, () => {
      expect(HU).toContain(`'${k}':`)
      expect(EN).toContain(`'${k}':`)
    })
  }
})
