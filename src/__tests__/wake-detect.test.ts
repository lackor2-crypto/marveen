/**
 * EBREDES-ERZEKELO.
 *
 * Miert van ra teszt? Mert ez a modul KET masik ellenorzest nemit el atmenetileg
 * (a git-lehuzas halozat-sorat es a Google elo ellenorzeset). Egy elnemito
 * mechanizmus, amit nem tesztel senki, pontosan az a nema hiba, ami ellen az
 * egesz onellenorzes kartya letezik: ha beragadna „ebredtem eppen" allapotba,
 * soha tobbe nem jelezne semmi.
 *
 * A MERT ESET, amiert a modul letezik (2026-08-26):
 *  - a git-lehuzas 06:49-kor, ebredes utan azonnal futott -> nem volt DNS,
 *    het tarolo elhasalt, es a sarga sor egesz napra ott maradt;
 *  - a Google elo ellenorzese elozo este 22:50 ota nem futott, mert az orás
 *    idozito alvas kozben nem ketyeg.
 * Boss: „ne legyen mar ilyen hogy minden reggel indulasnal alandoan sargat
 * jelez. (...) minden rendben van de o szol hogy nincs."
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { onWake, fireWake, lastWakeAt, msSinceWake, resetWakeDetectForTest } from '../wake-detect.js'

describe('ebredes-erzekelo', () => {
  const MOST = Date.parse('2026-08-26T07:00:00Z')

  beforeEach(() => { resetWakeDetectForTest(MOST) })

  it('indulaskor az utolso ebredes a MOSTANI ido -- nem nulla, nem null', () => {
    // Ha nulla lenne, az "1970 ota ebren" ertelmezes minden turelmi idot
    // azonnal lejartnak mutatna, es a hamis riasztas visszaterne.
    expect(lastWakeAt()).toBe(MOST)
    expect(msSinceWake(MOST)).toBe(0)
  })

  it('ebredeskor ertesiti az osszes feliratkozot, es atadja, mennyit aludt', () => {
    const kapott: number[] = []
    onWake(ms => kapott.push(ms))
    onWake(ms => kapott.push(ms * 2))
    fireWake(8 * 60 * 60 * 1000, MOST + 1000)
    expect(kapott).toEqual([8 * 60 * 60 * 1000, 16 * 60 * 60 * 1000])
  })

  it('EGY elszallo kezelo nem viszi magaval a tobbit', () => {
    // A git-szinkron es a Google-ellenorzes egymastol fuggetlen. Ha az elso
    // kivetelt dob, a masodiknak akkor is le KELL futnia -- kulonben egy
    // halozati hiba a git-oldalon elnemitana a Google-potlast is.
    const futott: string[] = []
    onWake(() => { throw new Error('szandekos hiba') })
    onWake(() => { futott.push('masodik') })
    expect(() => fireWake(1000, MOST)).not.toThrow()
    expect(futott).toEqual(['masodik'])
  })

  it('az ebredes ELORE viszi az orat -- a turelmi ido innen szamol', () => {
    const kesobb = MOST + 9 * 60 * 60 * 1000
    fireWake(8 * 60 * 60 * 1000, kesobb)
    expect(lastWakeAt()).toBe(kesobb)
    expect(msSinceWake(kesobb + 60 * 1000)).toBe(60 * 1000)
  })

  it('msSinceWake sosem negativ -- visszaallitott rendszerora sem torheti el', () => {
    // A gep orája ebredeskor ugorhat (idozona, NTP-igazitas). Egy negativ
    // ertek a hivo oldalan "a jovoben ebredt" allapotot csinalna, es a
    // turelmi ido vegtelenne valna.
    fireWake(1000, MOST)
    expect(msSinceWake(MOST - 60 * 60 * 1000)).toBe(0)
  })
})
