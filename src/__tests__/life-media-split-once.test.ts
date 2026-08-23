/**
 * A MEDIA CSAK EGYSZER SZEREPELHET az orszagbontas jelolonegyzetei kozott.
 *
 * Boss, 2026-08-23: „Projektek / Média / Egészség / Digitális / Média (fotók,
 * videók) … miert van ketszer felsorolva?"
 *
 * A hiba oka egy KULCSUTKOZES, nem elgepeles:
 *   - `PERSON_CATEGORIES` tartalmaz egy `media` kulcsot (a szemely MEDIA aga),
 *   - `MEDIA_COUNTRY_KEY` erteke szinten `'media'`.
 * A felulet a kategoria-listahoz HOZZAFUZTE a media-kulcsot, igy ket
 * jelolonegyzet keletkezett UGYANARRA az egy beallitasra (`countrySplit`
 * `'media'` eleme). Ket kovetkezmenye volt: a lista duplan sorolta fel a
 * Mediat, es az egyik negyzetet atkattintva a masik pipaja ujrarajzolasig
 * hazudott.
 *
 * A ket kulcs osszevonasa NEM opcio: a `planLifeTree` szandekosan ugorja at a
 * `media`-t a kategoria-ciklusban (a MEDIA felso ag mas szerkezetu, mint egy
 * sima kategoria). Ezert a szerveren marad az utkozes, es a FELULETNEK kell
 * osszevonnia a ket tetelt egy sorra.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PERSON_CATEGORIES, MEDIA_COUNTRY_KEY } from '../life-tree.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

describe('media-kulcs utkozes', () => {
  it('a ket kulcs tenyleg utkozik -- ezert kell a feluleten osszevonni', () => {
    // Ha ez egyszer megvaltozik (a media sajat, kulon kulcsot kap), ez a teszt
    // szol: akkor a feluleti osszevonas mar nem kell, es KET sor a helyes.
    expect(PERSON_CATEGORIES).toContain(MEDIA_COUNTRY_KEY)
  })

  it('a felulet nem fuzi hozza vakon a media-kulcsot a kategoriakhoz', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'web', 'app.js'), 'utf-8')
    const i = src.indexOf('function _intezoSplitBoxes(')
    expect(i, 'nincs meg a _intezoSplitBoxes -- atneveztek?').toBeGreaterThan(0)
    const fn = src.slice(i, src.indexOf('\n}', i))

    // A javitas lenyege: a MEGLEVO tetelt cimkezzuk at, es csak akkor teszunk
    // hozza ujat, ha nincs mar a listaban.
    expect(fn, 'a media-kulcsot meg kell keresni a listaban, nem hozzafuzni')
      .toMatch(/findIndex\(\s*\(?\s*o\s*\)?\s*=>\s*o\.key === mk\s*\)/)
    expect(fn).toMatch(/if \(at >= 0\)/)

    // Feltetel nelkuli `push` = a regi hiba. Csak az `else` agban szabad.
    const pushIdx = fn.indexOf('items.push(')
    expect(pushIdx, 'nincs tartalek-ag arra, ha a szerver kulon kulcsot ad').toBeGreaterThan(0)
    expect(fn.slice(0, pushIdx), 'a media-tetel hozzafuzese feltetel nelkuli')
      .toMatch(/else\s*$/)
  })
})
