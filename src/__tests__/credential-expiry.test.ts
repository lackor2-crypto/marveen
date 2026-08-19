/**
 * A lejarat-figyelo tesztje.
 *
 * Boss, 2026-08-19: "erre tegyel egy tesztet, figyelest. ha lejar valami
 * szoljon a attekintes menupontban."
 *
 * Amit ez a teszt VED (mind a ketto MERT hiba volt aznap):
 *  - a levelkuldest hajto REGI `google-token.json` ket napja halott volt, mig
 *    a felulet minden fioknal zoldet mutatott -> ha csak a tobbfiokos tarat
 *    neznenk, a kartya "minden rendben"-t irna egy halott ut folott;
 *  - a "Testing" allapotu OAuth-app 7 naponta oli a tokent, tehat a figyelmezteto
 *    savnak ELORE kell szolnia, nem a lejaras utan.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  credentialExpiries,
  googleAccountExpiries,
  legacyGoogleTokenExpiry,
  worstExpiryStatus,
  EXPIRY_WARN_MS,
} from '../web/credential-expiry.js'

const NOW = Date.UTC(2026, 7, 19, 12, 0, 0)
const HET = 604799 // amit a Google valoban kuld Testing allapotban
const NAP = 24 * 60 * 60 * 1000

let dir: string

/** `saved_at` masodpercben, ahogy a python oldal irja. */
function tokenRec(mentveMsEzelott: number, lifetime = HET) {
  return {
    refresh_token: 'DUMMY-NEM-TITOK',
    saved_at: Math.floor((NOW - mentveMsEzelott) / 1000),
    refresh_token_expires_in: lifetime,
  }
}

function writeTokens(obj: unknown) {
  writeFileSync(join(dir, 'google-tokens.json'), JSON.stringify(obj))
}
function writeLegacy(obj: unknown) {
  writeFileSync(join(dir, 'google-token.json'), JSON.stringify(obj))
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'expiry-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('a lejarat kiszamolasa', () => {
  it('friss token = ok, es meg nem panaszkodik', () => {
    writeTokens({ lackor2: tokenRec(1 * NAP) })
    const [row] = googleAccountExpiries(NOW, dir)
    expect(row.status).toBe('ok')
    expect(row.daysLeft).toBe(5)
    expect(row.label).toBe('lackor2')
  })

  it('a hatarido elotti ket napban mar szol (soon)', () => {
    // pontosan a savon BELUL
    writeTokens({ lackor2: tokenRec(HET * 1000 - (EXPIRY_WARN_MS - 60_000)) })
    expect(googleAccountExpiries(NOW, dir)[0].status).toBe('soon')
  })

  it('a sav elott meg nem szol -- kulonben allando riogatas lenne', () => {
    writeTokens({ lackor2: tokenRec(HET * 1000 - (EXPIRY_WARN_MS + 60_000)) })
    expect(googleAccountExpiries(NOW, dir)[0].status).toBe('ok')
  })

  it('a lejart token expired, es a daysLeft negativ', () => {
    writeTokens({ lackor2: tokenRec(9 * NAP) })
    const [row] = googleAccountExpiries(NOW, dir)
    expect(row.status).toBe('expired')
    expect(row.daysLeft).toBeLessThan(0)
  })

  it('a `_default` mutato NEM fiok, nem lesz belole sor', () => {
    // Ma egyszeru szoveg ("lackor2"), es ettol a `_`-or latszolag felesleges --
    // egy szovegbol ugyis nem lesz sor. De a mezo REGEBBEN a teljes bejegyzes
    // masolatat tartalmazta, es egy visszaallo/regi store-ral a kartya
    // "_default: a hozzaferes lejart" sort irna ki egy nem letezo fiokrol.
    // Ezert mindket alakot merjuk: a szoveges mutatot ES a bejegyzes-alakut.
    writeTokens({ _default: 'lackor2', lackor2: tokenRec(1 * NAP) })
    expect(googleAccountExpiries(NOW, dir).map(r => r.label)).toEqual(['lackor2'])

    writeTokens({ _default: tokenRec(9 * NAP), lackor2: tokenRec(1 * NAP) })
    expect(googleAccountExpiries(NOW, dir).map(r => r.label)).toEqual(['lackor2'])
  })

  it('lejarati mezo nelkuli (Production) token nem kap kitalalt határidot', () => {
    writeTokens({ lackor2: { refresh_token: 'X' } })
    expect(googleAccountExpiries(NOW, dir)).toEqual([])
  })

  it('a masodperc es a milliszekundum is helyesen ertelmezodik', () => {
    const mp = { refresh_token: 'X', saved_at: Math.floor((NOW - NAP) / 1000), refresh_token_expires_in: HET }
    const ms = { refresh_token: 'X', saved_at: NOW - NAP, refresh_token_expires_in: HET }
    writeTokens({ a: mp, b: ms })
    const rows = googleAccountExpiries(NOW, dir)
    expect(rows[0].expiresAt).toBe(rows[1].expiresAt)
  })

  it('hianyzo vagy romlott fajl nem dob es nem hazudik', () => {
    expect(googleAccountExpiries(NOW, dir)).toEqual([])
    writeFileSync(join(dir, 'google-tokens.json'), '{ ez nem json')
    expect(googleAccountExpiries(NOW, dir)).toEqual([])
  })
})

describe('a REGI, egyfiokos token', () => {
  it('migracio ELOTT figyeljuk: ilyenkor ez A levelkuldo hitelesites', () => {
    writeLegacy(tokenRec(9 * NAP))
    const row = legacyGoogleTokenExpiry(NOW, dir)!
    expect(row.status).toBe('expired')
    expect(row.id).toBe('google:legacy')
  })

  it('migracio UTAN nem: mar semmi nem olvassa', () => {
    // 2026-08-19: a gmail-send.py is atallt a fiok-kulcsolt tarra. A regi fajl
    // ott marad a lemezen egy halott tokennel -- ha ezt tovabb jelentenenk,
    // egy orokke piros sor allna a kartyan egy hasznalaton kivuli
    // hitelesitesrol, es pont ez tanitja meg a felhasznalot, hogy ne nezze.
    writeTokens({ _default: 'lackor2', lackor2: tokenRec(1 * NAP) })
    writeLegacy(tokenRec(9 * NAP))
    expect(legacyGoogleTokenExpiry(NOW, dir)).toBeNull()
    const rows = credentialExpiries(NOW, dir)
    expect(worstExpiryStatus(rows)).toBe('ok')
    expect(rows.map(r => r.id)).toEqual(['google:lackor2'])
  })
})

describe('a sor MEGNEVEZI, melyik fiokrol van szo', () => {
  it('a cimet mutatja, nem a belso kulcsot', () => {
    writeTokens({ lackor2: { ...tokenRec(9 * NAP), email: 'lackor2@gmail.com' } })
    expect(googleAccountExpiries(NOW, dir)[0].label).toBe('lackor2@gmail.com')
  })

  it('ha nincs cim, a kulcsot mutatja -- de nevtelen sor nincs', () => {
    writeTokens({ lackor2: tokenRec(9 * NAP) })
    expect(googleAccountExpiries(NOW, dir)[0].label).toBe('lackor2')
  })
})

describe('az osszesitett kep', () => {
  it('a jo eseteket IS visszaadja, hogy a kartya kiirhassa: minden rendben', () => {
    writeTokens({ lackor2: tokenRec(1 * NAP) })
    const rows = credentialExpiries(NOW, dir)
    expect(rows).toHaveLength(1)
    expect(worstExpiryStatus(rows)).toBe('ok')
  })

  it('a sorrend: lejart, majd hamarosan, majd a tobbi', () => {
    writeTokens({
      jo: tokenRec(1 * NAP),
      hamarosan: tokenRec(HET * 1000 - NAP),
      halott: tokenRec(9 * NAP),
    })
    expect(credentialExpiries(NOW, dir).map(r => r.label))
      .toEqual(['halott', 'hamarosan', 'jo'])
  })

  it('ha nincs semmi lejaro, a legrosszabb allapot ok (nem hiba)', () => {
    expect(credentialExpiries(NOW, dir)).toEqual([])
    expect(worstExpiryStatus([])).toBe('ok')
  })
})
