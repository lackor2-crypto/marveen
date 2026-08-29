// "BEJELENTKEZVE" CSAK AKKOR, HA TENYLEG BEJELENTKEZETT.
//
// Boss, 2026-08-30: "nem szol ez semmit. csak pusztan nem jeletkezik be."
// A kepernyon kozben ez a fekete csik allt: "Bejelentkezve. Ujraindítom a(z)
// lackor3 ugynokot, hogy a friss hitelesitest hasznalja."
//
// A napló (store/dashboard.log, 00:42:01 es 00:42:38) megmondta, mi tortent
// valojaban -- ketszer egymas utan:
//     WARN  MAS fiok jelentkezett be, mint amit ehhez a slothoz rogzitettunk
//     INFO  account signed out
//     WARN  a rossz fiokkal letrejott bejelentkezes visszavonva
// Vagyis a tiltas MUKODOTT, csak a felulet mondta az ellenkezojet: az
// ugynok-kartya kesz-horga nem nezte meg, letrejott-e a bejelentkezes, es a
// sikeruzenete felul is irta a mar kint allo figyelmeztetest.
//
// Ket kulon hiba, ket kulon vedelem:
//   1. LEZARULT != SIKERULT  -- a `done` a folyamat vege, nem a siker.
//   2. A figyelmeztetes nem villanhat el, es nem lehet felulirni.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const RUNNER = readFileSync('src/web/claude-auth-runner.ts', 'utf-8')
const APP = readFileSync('web/app.js', 'utf-8')

/** A feluleti dontesfuggveny kiemelve a forrasbol -- nem a szoveget nezzuk,
 *  hanem LEFUTTATJUK. Igy a teszt akkor is fog, ha a felteteleket atirjak. */
function doneOk(): (s: unknown) => boolean {
  const kezd = APP.indexOf('function _claudeAuthDoneOk(s) {')
  expect(kezd).toBeGreaterThan(-1)
  const veg = APP.indexOf('\n}\n', kezd)
  expect(veg).toBeGreaterThan(kezd)
  const forras = APP.slice(kezd, veg + 2)
  // eslint-disable-next-line no-new-func
  return new Function(`${forras}; return _claudeAuthDoneOk`)() as (s: unknown) => boolean
}

describe('lezarult != sikerult', () => {
  const ok = doneOk()

  it('a Boss esete: kesz a folyamat, de mas fiok jott be es visszavontuk -> NEM siker', () => {
    expect(ok({
      done: true, loginOk: false, error: null,
      identityDrift: { planId: 'lackor3', expected: 'lackor3@gmail.com', actual: 'usalackor@gmail.com', reverted: true },
    })).toBe(false)
  })

  it('a visszavonas BUKASA sem siker -- ott a rossz fiok ul a helyen', () => {
    expect(ok({
      done: true, loginOk: false, error: null,
      identityDrift: { planId: 'lackor3', expected: 'lackor3@gmail.com', actual: 'usalackor@gmail.com', reverted: false, revertError: 'tmux nem valaszolt' },
    })).toBe(false)
  })

  it('valodi siker: nincs elteres, nincs hiba', () => {
    expect(ok({ done: true, loginOk: true, error: null, identityDrift: null })).toBe(true)
  })

  it('a nyilvantartasba felvetel bukasa sem siker', () => {
    expect(ok({ done: true, loginOk: false, error: 'A fiók bejelentkezett, de a nyilvántartásba nem sikerült felvenni.' })).toBe(false)
  })

  it('regi valasz (nincs `loginOk` mezo): a jelekbol dont, ovatosan', () => {
    // A nulla ket dolgot jelenthet: a hianyzo mezo nem "siker".
    expect(ok({ done: true, identityDrift: { expected: 'a@b.c', actual: 'x@y.z', reverted: true } })).toBe(false)
    expect(ok({ done: true, error: 'valami elromlott' })).toBe(false)
    expect(ok({ done: true, error: null, identityDrift: null })).toBe(true)
  })

  it('ures valasz nem siker', () => {
    expect(ok(null)).toBe(false)
    expect(ok(undefined)).toBe(false)
  })
})

describe('a szerver kimondja, letrejott-e a bejelentkezes', () => {
  it('a `loginOk` kulon mezo, nem a `done`-bol kell kitalalni', () => {
    expect(RUNNER).toContain('loginOk?: boolean')
    expect(RUNNER).toContain('loginOk: !drift && registered')
  })

  it('a kesz-valaszban ott van a mezo (nem csak a tipusban)', () => {
    const i = RUNNER.indexOf('...status, done: true, planId, label')
    expect(i).toBeGreaterThan(-1)
    expect(RUNNER.slice(i, i + 500)).toContain('loginOk:')
  })
})

describe('az ugynok-kartya gombja nem mondhat sikert kudarcra', () => {
  const kezd = APP.indexOf('_claudeAuthOnDone = async (s) => {')
  const blokk = APP.slice(kezd, kezd + 2000)

  it('a horog MEGKAPJA a folyamat vegallapotat', () => {
    expect(kezd).toBeGreaterThan(-1)
    expect(APP).toContain('cb(s)')
  })

  it('eloszor a siker-ellenorzes, csak azutan a "Bejelentkezve" mondat', () => {
    const ellenorzes = blokk.indexOf('if (!_claudeAuthDoneOk(s))')
    const mondat = blokk.indexOf('agents.auth.toast_restart_after_login')
    expect(ellenorzes).toBeGreaterThan(-1)
    expect(mondat).toBeGreaterThan(ellenorzes)
  })

  it('sikertelen bejelentkezes utan az ugynok NEM indul ujra', () => {
    const ellenorzes = blokk.indexOf('if (!_claudeAuthDoneOk(s))')
    const restart = blokk.indexOf('/restart')
    expect(restart).toBeGreaterThan(ellenorzes)
  })
})

describe('a figyelmeztetes nem villanhat el es nem irhato felul', () => {
  it('az elteres csikja addig marad, amig el nem tuntetik', () => {
    const i = APP.indexOf("const key = d.reverted ? 'accounts.identity.drift_blocked'")
    expect(i).toBeGreaterThan(-1)
    const blokk = APP.slice(i, i + 600)
    expect(blokk).toContain("{ type: 'warn', big: true }")
    // A regi, magatol elhalo valtozat NEM johet vissza.
    expect(blokk).not.toContain('25000')
  })

  it('a hibauzenet is marad (kesz-ag es megszakadt folyamat egyarant)', () => {
    const kesz = APP.indexOf('if (s.error) showToast(s.error,')
    expect(kesz).toBeGreaterThan(-1)
    expect(APP.slice(kesz, kesz + 120)).toContain("{ type: 'error', big: true }")
    // A megszakadt folyamat allapotsora a kartyaval egyutt eltunhet, ezert
    // oda is kell csik.
    const megszakadt = APP.indexOf("_claudeAuthSetState(s.error, 'bad')")
    expect(megszakadt).toBeGreaterThan(-1)
    expect(APP.slice(megszakadt, megszakadt + 400)).toContain("showToast(s.error, { type: 'error', big: true })")
  })
})
