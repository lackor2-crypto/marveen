// A /api/drive/list `folderId` parametere a Drive lekerdezo-kifejezesebe kerul
// szovegkent: `'<id>' in parents and trashed = false`. Az encodeURIComponent
// csak az URL-t vedi, magat a kifejezest nem -- egy aposztrofot tartalmazo id
// atirja a lekerdezest (pl. "root' in parents or 'me' in owners and 'x").
//
// A javitas nem szur, hanem elutasit: egy megcsonkitott azonosito amugy is
// rossz mappat nyitna, es a felhasznalonak jobb egy tiszta 400.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { isSafeFolderId } from '../web/routes/drive-browser.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const route = readFileSync(join(__dirname, '..', 'web', 'routes', 'drive-browser.ts'), 'utf8')

describe('isSafeFolderId', () => {
  it('a valodi Drive-azonositok es a "root" atmennek', () => {
    expect(isSafeFolderId('root')).toBe(true)
    expect(isSafeFolderId('1A2b3C-_dEfGhIjKlMnOpQrStUv')).toBe(true)
  })

  it('az aposztrof es a szokoz nem -- ez maga a tamadas', () => {
    expect(isSafeFolderId("root' in parents or 'me' in owners and 'x")).toBe(false)
    expect(isSafeFolderId("a'b")).toBe(false)
    expect(isSafeFolderId('a b')).toBe(false)
    expect(isSafeFolderId('a\\b')).toBe(false)
  })

  it('ures, tul hosszu vagy nem-string bemenet sem megy at', () => {
    expect(isSafeFolderId('')).toBe(false)
    expect(isSafeFolderId('A'.repeat(257))).toBe(false)
    expect(isSafeFolderId(null as unknown as string)).toBe(false)
    // Sorveg: az egysoros regexek klasszikus lyuka.
    expect(isSafeFolderId('root\nx')).toBe(false)
  })
})

describe('a lista-vegpont hasznalja is a kaput', () => {
  it('ellenorzes utan epul fel a lekerdezes', () => {
    expect(route).toMatch(/if \(!isSafeFolderId\(folderId\)\) \{ json\(res, \{ error: 'ervenytelen folderId' \}, 400\); return true \}/)
    // A sorrend szamit: eloszor a kapu, csak utana a token es a lekerdezes.
    expect(route.indexOf('isSafeFolderId(folderId)')).toBeLessThan(route.indexOf("' in parents and trashed = false"))
  })
})
