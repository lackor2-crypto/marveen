/**
 * A MENTES TOVABB TART, MINT AMEDDIG A TOKEN EL.
 *
 * 2026-08-29, merve: a teljes raktar mentese 252 fajlt (72 MB) toltott fel,
 * utana 8900+ fajl bukott el egymas utan ezzel:
 *
 *     Drive 401: "Request had invalid authentication credentials.
 *                 Expected OAuth 2 access token..."
 *
 * Az ok nem halozat es nem jogosultsag volt: a paros futasanak ELEJEN kertunk
 * egy access tokent, azt adtuk tovabb sztringkent minden keresnek, es a Google
 * ~1 ora utan ervenytelenitette. Egy 4 GB-os mentes ennel sokkal tovabb tart,
 * tehat a mentes ilyen felallasban SOHA nem tudott vegigmenni.
 *
 * Ez a teszt a forrast orzi, mert a valodi lejaratot nem lehet kivarni:
 * a token-szolgaltato letezik, a halozati fuggvenyek NEM sztringet varnak,
 * es 401-nel van egy eroltetett ujraprobalas.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const forras = readFileSync(join(process.cwd(), 'src/web/routes/drive-sync.ts'), 'utf8')

describe('a Drive-token a futas kozben is frissul', () => {
  it('van fiokhoz kotott token-szolgaltato', () => {
    expect(forras).toContain('export function tokenSzolgaltato(account?: string)')
    // Sajat gyorsitotar, NEM modul-szintu globalis: ket paros ket fiokja nem
    // irhatja felul egymas tokenjet.
    expect(forras).not.toMatch(/^let tokenErtek = ''/m)
  })

  it('a paros szolgaltatot kap, nem egyszer lekert sztringet', () => {
    expect(forras).toContain('const token = tokenSzolgaltato(pair.account)')
    expect(forras).not.toContain('const token = await getAccessToken(pair.account)')
  })

  it('a paros indulasakor azonnal kiderul, ha nincs hozzaferes', () => {
    // Fail-fast: ne a 3000. fajlnal deruljon ki, hogy be sem vagyunk lepve.
    expect(forras).toMatch(/const token = tokenSzolgaltato\(pair\.account\)\s*\n\s*\/\/[^\n]*\n\s*await token\(\)/)
  })

  it('a halozati fuggvenyek TokenForras-t fogadnak, nem sztringet', () => {
    for (const fn of [
      'driveJson(url: string, token: TokenForras',
      'putBytes(uploadUrl: string, method: \'POST\' | \'PATCH\', localPath: string, token: TokenForras',
      'downloadTo(url: string, token: TokenForras',
      'listFolder(folderId: string, token: TokenForras',
      'uploadNewFile(name: string, parentId: string, localPath: string, token: TokenForras',
      'updateDriveFile(fileId: string, localPath: string, token: TokenForras',
      'trashDriveFile(fileId: string, token: TokenForras',
      'createDriveFolder(name: string, parentId: string, token: TokenForras',
    ]) {
      expect(forras).toContain(fn)
    }
    // A sztring tovabbra is ervenyes bemenet: a rovid, egy-keres API-vegpontok
    // (pl. /api/drive/list) valtozatlanul mukodnek.
    expect(forras).toContain("export type TokenForras = string | ((eroltetett?: boolean) => Promise<string>)")
  })

  it('401-nel EGYSZER frissit es ujraprobal, de nem nyeli el a hibat', () => {
    // Feltoltes es metaadat-keres: mindketto ujraprobal.
    const agak = forras.match(/if \(res\.status === 401 && probal === 0 && typeof token !== 'string'\) continue/g) || []
    expect(agak.length).toBe(2)
    // A masodik 401 mar valodi hozzaferes-hiba -> dobni kell.
    expect(forras).toContain('throw new Error(`Drive ${res.status}: ${szoveg}`)')
  })

  it('a feltoltes minden probalkozasnal UJ olvaso-folyamot nyit', () => {
    // Egy elhasznalt folyam ujrakuldese csendben ures torzset toltene fel --
    // az rosszabb, mint a hibauzenet.
    const putBytes = forras.slice(forras.indexOf('async function putBytes'))
    const torzs = putBytes.slice(0, putBytes.indexOf('\n}\n'))
    expect(torzs).toMatch(/for \(let probal = 0; ; probal\+\+\)[\s\S]*createReadStream\(localPath\)/)
  })

  it('a token elettartama a Google 1 oraja ALATT van', () => {
    const m = forras.match(/const TOKEN_ELETTARTAM_MS = (\d+) \* 60 \* 1000/)
    expect(m).not.toBeNull()
    expect(Number(m![1])).toBeGreaterThan(0)
    expect(Number(m![1])).toBeLessThan(60)
  })
})

/**
 * A MASODIK NEMA HIBA UGYANEBBOL A FUTASBOL.
 *
 * A paros -ja "rendben"-t irt ki, holott 252 fajl ment fel es 8926
 * bukott el. A dontesi lanc csak a VARAKOZO fajlokat nezte, azok pedig
 * elfogytak: minden fajlra sor kerult, csak epp elbukott. Zold "rendben" egy
 * ures mentes folott a legrosszabb fajta csend -- a Boss abbol azt olvassa ki,
 * hogy megvan a mentese.
 */
describe('elbukott fajlok utan nem irhat "rendben"-t', () => {
  it('a paros sajat hibait a kozos szamlalo KULONBSEGEBOL veszi', () => {
    expect(forras).toContain('const hibaElotte = job?.failed || 0')
    expect(forras).toContain('const hibas = (job?.failed || 0) - hibaElotte')
  })

  it('a hibas ag a lancban VAN, es a "folyamatban" ELE kerul', () => {
    const i = forras.indexOf('pair.lastResult = brake')
    expect(i).toBeGreaterThan(-1)
    const lanc = forras.slice(i, i + 900)
    expect(lanc).toContain('nem ment fel')
    expect(lanc.indexOf('nem ment fel')).toBeLessThan(lanc.indexOf('folyamatban:'))
    expect(lanc.indexOf('nem ment fel')).toBeLessThan(lanc.indexOf("'rendben'"))
  })

  it('a hibauzenet megmondja a KOVETKEZO lepest', () => {
    expect(forras).toContain('a Hibák dobozban látod, melyik miért')
  })
})
