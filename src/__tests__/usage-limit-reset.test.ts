// Kanban 13fc793f (#255). A keret-banner "resets ..." reszenek ertelmezese.
//
// Ez a parser eddig a routes/overview.ts-ben allt, teszt NELKUL, es csak
// kijelzest vezerelt. Mostantol egy DONTEST is vezerel (a kod-hid kvota-blokk
// lejaratat), ezert a hatareseteit le kell szogezni: a rossz idopont ott nem
// csunya szam, hanem vagy egy orokke allo hazug blokk, vagy egy tul koran
// feloldott.
import { describe, it, expect } from 'vitest'
import { parseUsageLimitResetAt } from '../usage-limit-reset.js'

const at = (y: number, m: number, d: number, h: number, min = 0): number =>
  new Date(y, m, d, h, min, 0, 0).getTime()

describe('parseUsageLimitResetAt', () => {
  it('csupasz ora: a horgony napjan, ha meg nem mult el', () => {
    const anchor = at(2026, 8, 11, 2, 17) // 2026-09-11 02:17
    expect(parseUsageLimitResetAt("You've hit your session limit · resets 9am (Europe/Budapest)", anchor))
      .toBe(at(2026, 8, 11, 9))
  })

  it('csupasz ora: MASNAP, ha a horgony napjan mar elmult (ejfelt atlepo ablak)', () => {
    const anchor = at(2026, 8, 10, 23, 40)
    expect(parseUsageLimitResetAt("You've hit your session limit · resets 2am", anchor))
      .toBe(at(2026, 8, 11, 2))
  })

  it('datummal es perccel is', () => {
    const anchor = at(2026, 8, 8, 2, 17)
    expect(parseUsageLimitResetAt("You've hit your weekly limit · resets Sep 11, 9am (Europe/Budapest)", anchor))
      .toBe(at(2026, 8, 11, 9))
    expect(parseUsageLimitResetAt('usage limit reached · resets 6:20pm', anchor))
      .toBe(at(2026, 8, 8, 18, 20))
  })

  it('"reset at 9am" alak is', () => {
    const anchor = at(2026, 8, 8, 2, 0)
    expect(parseUsageLimitResetAt('limit will reset at 9am', anchor)).toBe(at(2026, 8, 8, 9))
  })

  it('EVFORDULO: a december 31-i hibauzenet "Jan 2"-je a KOVETKEZO ev, nem a mult', () => {
    const anchor = at(2026, 11, 31, 22, 0)
    const got = parseUsageLimitResetAt("You've hit your weekly limit · resets Jan 2, 9am", anchor)
    expect(got).toBe(at(2027, 0, 2, 9))
    expect(got!).toBeGreaterThan(anchor)
  })

  it('a HORGONY donti el az evet/napot, nem a mostani ido -- egy regi uzenet nem csuszik elore', () => {
    const anchor = at(2026, 0, 5, 1, 0)
    // Ugyanaz a szoveg ket kulonbozo horgonnyal ket kulonbozo -- de mindig a
    // horgonyahoz tartozo -- pillanatot ad. Ha a mostani idohoz merne, egy
    // tegnapi hibauzenet lejarata naprol napra elorecsuszna, es sosem jonne el.
    expect(parseUsageLimitResetAt('resets 3am', anchor)).toBe(at(2026, 0, 5, 3))
    expect(parseUsageLimitResetAt('resets 3am', at(2026, 5, 20, 4, 0))).toBe(at(2026, 5, 21, 3))
  })

  it('a hianyzo vagy ertelmezhetetlen idopont NULL, nem nulla es nem "most"', () => {
    const anchor = at(2026, 8, 8, 2, 0)
    expect(parseUsageLimitResetAt("You've hit your weekly limit", anchor)).toBeNull()
    expect(parseUsageLimitResetAt('', anchor)).toBeNull()
    expect(parseUsageLimitResetAt('resets Foo 3, 9am', anchor)).toBeNull()   // nem letezo honap
    expect(parseUsageLimitResetAt('resets Feb 30, 9am', anchor)).toBeNull()  // nem letezo nap
    expect(parseUsageLimitResetAt('resets 19pm', anchor)).toBeNull()         // nem 12 oras alak
    expect(parseUsageLimitResetAt('resets soon', anchor)).toBeNull()
  })
})
