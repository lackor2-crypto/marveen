// AZ ELAVULT KEPERNYOSZOVEG NE JELENTSEN KIESEST.
//
// Boss, 2026-08-29: "a szakerto nel ott van hogy bejelentkezes pirossal, de a
// ket kis jelzo azt mondja hogy fut es hogy online???"
//
// Az ujrameres a FORRAST kerdezte meg, nem a kepernyot: a Szakerto
// `.credentials.json`-ja 20:12-kor irodott, 2026-08-30 04:12-ig ervenyes, es a
// heti kerete kozben 6%-rol 8%-ra nott -- tehat DOLGOZOTT. A panel
// allapotsora egyszeruen elavult szoveg volt: a Claude Code nem rajzolja ujra
// sikeres bejelentkezes utan.
//
// Amit ezek a tesztek oriznek:
//   * a NULLA KET DOLGOT JELENTHET: a hianyzo fajl ('missing') es az
//     olvashatatlan / ertelmezhetetlen fajl ('unknown') KET KULON verdikt --
//     az utobbi sosem hasznalhato bizonyitekkent;
//   * titok SOHA nem kerul ki: a modul csak letezest es lejaratot ad vissza.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readCredentialFreshness } from '../web/credential-freshness.js'

let dir: string
const NOW = Date.parse('2026-08-29T20:30:00Z')

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cred-')) })
afterEach(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* takaritas */ } })

function write(obj: unknown): void {
  writeFileSync(join(dir, '.credentials.json'), JSON.stringify(obj), 'utf8')
}

describe('readCredentialFreshness', () => {
  it('ervenyes hitelesitest ervenyesnek lat -- ez a Szakerto MERT esete', () => {
    const expiresAt = Date.parse('2026-08-30T04:12:00Z')
    write({ claudeAiOauth: { expiresAt, accessToken: 'TITOK-EZ-SOSE-KERULHET-KI' } })
    const got = readCredentialFreshness(dir, NOW)
    expect(got.verdict).toBe('valid')
    expect(got.expiresAt).toBe(expiresAt)
  })

  it('TITKOT sosem ad vissza', () => {
    write({ claudeAiOauth: { expiresAt: NOW + 3600_000, accessToken: 'TITOK-EZ-SOSE-KERULHET-KI', refreshToken: 'MASIK-TITOK' } })
    const got = readCredentialFreshness(dir, NOW)
    expect(JSON.stringify(got)).not.toContain('TITOK')
    expect(JSON.stringify(got)).not.toContain('MASIK-TITOK')
  })

  it('a lejart hitelesites nem ervenyes', () => {
    write({ claudeAiOauth: { expiresAt: NOW - 1000 } })
    expect(readCredentialFreshness(dir, NOW).verdict).toBe('expired')
  })

  it('a hianyzo fajl "missing" -- ez a Segedmunkas MERT esete', () => {
    expect(readCredentialFreshness(dir, NOW).verdict).toBe('missing')
  })

  it('A NULLA KET DOLGOT JELENTHET: a config-konyvtar hianya "unknown", nem "missing"', () => {
    // Nem azt tudjuk, hogy nincs bejelentkezve, hanem hogy NEM TUDJUK, hol
    // nezzuk meg. A kettot a hivonak kulon kell kezelnie.
    expect(readCredentialFreshness(null, NOW).verdict).toBe('unknown')
  })

  it('az ertelmezhetetlen fajl "unknown", nem "missing" es nem "valid"', () => {
    writeFileSync(join(dir, '.credentials.json'), '{ ez nem json', 'utf8')
    expect(readCredentialFreshness(dir, NOW).verdict).toBe('unknown')
  })

  it('az ismeretlen alaku fajl "unknown" -- nem allitjuk rola, hogy ervenyes', () => {
    write({ valamiJovobeliMezo: true })
    expect(readCredentialFreshness(dir, NOW).verdict).toBe('unknown')
  })

  it('minden verdikthez tartozik emberi mondat', () => {
    write({ claudeAiOauth: { expiresAt: NOW + 1000 } })
    expect(readCredentialFreshness(dir, NOW).detail.length).toBeGreaterThan(10)
    expect(readCredentialFreshness(null, NOW).detail.length).toBeGreaterThan(10)
  })
})

describe('mtimeMs -- a bejelentkezes bizonyitasanak alapja', () => {
  // Miert kell kulon idobelyeg: egy MAR MEGLEVO, ervenyes hitelesites
  // onmagaban semmit nem bizonyit arrol, hogy a MOSTANI kod atment. Az
  // `auth/code` vegpont ezert nem a 'valid' verdiktet nezi, hanem azt, hogy a
  // fajl a bekuldes UTAN irodott-e. Enelkul a vegpont egy hetekkel korabbi
  // fajlra is sikert jelentene -- pontosan az a hamis siker, ami miatt ez a
  // javitas keszult ("mar lent a fekete csikban mondta hogy sikeres",
  // kozben a piros sav helyesen maradt).
  it('ervenyes fajlnal visszaadja az irasi idot', () => {
    const before = Date.now()
    write({ claudeAiOauth: { expiresAt: Date.now() + 3_600_000 } })
    const got = readCredentialFreshness(dir)
    expect(got.verdict).toBe('valid')
    expect(typeof got.mtimeMs).toBe('number')
    // A fajlt EPP MOST irtuk: az idobelyegnek a meres kezdete utanra kell esnie.
    // (1 mp turés a fajlrendszer felbontasa miatt.)
    expect(got.mtimeMs as number).toBeGreaterThanOrEqual(before - 1000)
  })

  it('hianyzo fajlnal NINCS ido -- nem hazudunk nullat', () => {
    // A hivo `(mtimeMs ?? 0) >= startedAt` tesztet hasznal, tehat a hianyzo
    // ertek helyes viselkedese a "nem bizonyitott" -- nem egy kitalalt idopont.
    const got = readCredentialFreshness(dir)
    expect(got.verdict).toBe('missing')
    expect(got.mtimeMs).toBeUndefined()
  })

  it('ismeretlen config-konyvtarnal sincs ido', () => {
    const got = readCredentialFreshness(null)
    expect(got.verdict).toBe('unknown')
    expect(got.mtimeMs).toBeUndefined()
  })

  it('a lejart fajlnak is van ideje -- de az NEM bizonyitek', () => {
    // Fontos kulonbseg: a friss iras onmagaban nem eleg. A vegpont a KETTOT
    // egyutt koveteli meg (ervenyes ES friss), kulonben egy lejart, de eppen
    // ujrairt fajl is sikernek latszana.
    write({ claudeAiOauth: { expiresAt: NOW - 1000 } })
    const got = readCredentialFreshness(dir, NOW)
    expect(got.verdict).toBe('expired')
    expect(typeof got.mtimeMs).toBe('number')
  })
})
