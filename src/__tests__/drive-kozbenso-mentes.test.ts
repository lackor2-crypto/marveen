/**
 * A MEGSZAKADT MENTES NEM DOBHATJA EL AZ ELVEGZETT MUNKAT.
 *
 * 2026-08-29, merve: a mentes-paros egy futasa tobb oras volt, es kozben egy
 * masik folyamat ujrainditotta a szolgaltatast (a `dist/` 11:51:07-kor epult
 * ujra, a service 11:51:12-kor indult). A korben feltoltott 1704 fajl FENT
 * volt a Drive-on, de a nyilvantartasba nem kerult be: azt csak a paros vegen
 * irtuk ki, az a pillanat pedig soha nem jott el.
 *
 * Ket kar egy okbol:
 *   - a kovetkezo futas ugyanazt az 1704 fajlt kezdte elolrol, igy a hatralek
 *     korrol korre nem fogyott;
 *   - a felulet egy orakkal korabbi szamot mutatott ("meg 2922 fajl var"),
 *     mintha kozben semmi nem tortent volna.
 *
 * Ez a teszt a forrast orzi: a valodi lejatszashoz tobb oras futast es egy
 * kivulrol jovo ujrainditast kellene eloallitani.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const forras = readFileSync(join(process.cwd(), 'src/web/routes/drive-sync.ts'), 'utf8')

describe('a paros allapota MENET KOZBEN is lemezre kerul', () => {
  it('van kozos kiiro fuggveny, es a paros vege IS azt hasznalja', () => {
    expect(forras).toContain('function mentsdAParost(pair: SyncPair, cfg: SyncConfig): void')
    // A paros vegen mar nem sajat kezzel masolja ossze -- kulonben a ket ut
    // elcsuszna egymastol, es csak az egyik orizne meg a nyilvantartast.
    // `lastIndexOf`: a kozbenso mentes ugyanezzel a sorral kezdodik, a paros
    // VEGE az utolso elofordulas.
    const vege = forras.slice(forras.lastIndexOf('pair.lastRunAt = new Date().toISOString()'))
    expect(vege.slice(0, 500)).toContain('mentsdAParost(pair, cfg)')
  })

  it('minden feltoltes utan meghivja a kozbenso mentest', () => {
    // A hivas a SZAMLALO utan all: amit mar feltoltottunk, az mar a `state`-ben
    // van, tehat amit kiirunk, az igaz.
    expect(forras).toMatch(/feltoltve\+\+[\s\S]{0,200}kozbenMentes\(\)/)
  })

  it('az ELSO feltoltes azonnal kiir (nem var egy teljes idoszeletet)', () => {
    // `0` kezdoertek: kulonben az elso perc feltoltesei egy megszakadasnal
    // ugyanugy elvesznenek, es a felulet meg mindig a korabbi futast mutatna.
    expect(forras).toContain('let utoljaraMentve = 0')
  })

  it('a kiiras suruseget ido szabja, nem darabszam', () => {
    const m = forras.match(/const KOZBEN_MENTES_MS = (\d+) \* 1000/)
    expect(m).not.toBeNull()
    // Egy perc korul: surubben felesleges IO, ritkabban mar sokat vesztenenk.
    expect(Number(m![1])).toBeGreaterThanOrEqual(15)
    expect(Number(m![1])).toBeLessThanOrEqual(300)
  })

  it('a kozbenso sor MEGMONDJA, hogy futas kozben keszult', () => {
    // Ha a futas felbeszakad, ez a sor marad ott. Akkor sem hazudhat: eppen
    // azt kell mondania, hogy megszakadt.
    expect(forras).toContain('ha ez a sor megmarad, a futás félbeszakadt')
  })

  it('futas kozben NEM talalgatja a hatralevo fajlok szamat', () => {
    // A `lastPending` egy BEFEJEZETT futas szama. Menet kozben nem tudjuk,
    // mennyi van hatra -- egy talalgatott szam rosszabb lenne a reginel.
    const blokk = forras.slice(forras.indexOf('const kozbenMentes'), forras.indexOf('for (const rel of helyiek)'))
    expect(blokk).toContain('pair.lastResult =')
    expect(blokk).not.toContain('pair.lastPending =')
  })

  it('a kiiras hibaja nem allithatja meg magat a mentest', () => {
    const blokk = forras.slice(forras.indexOf('const kozbenMentes'), forras.indexOf('for (const rel of helyiek)'))
    expect(blokk).toContain('try {')
    expect(blokk).toContain('logger.warn')
  })
})
