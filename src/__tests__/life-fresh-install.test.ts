/**
 * FRISS TELEPITES: legyen mit nezni, es legyen odairva, mire valo.
 *
 * Boss, 2026-08-21: „ha valaki letolti a marveen omat, akkor legyen neki egy
 * alap konytarstruktura. kitalt nevekkel!" es „ees persze ezek a zarojeles
 * reszek is jelenjenek meg benne".
 *
 * Amit ez a fajl OR:
 *  - az alapertelmezett beallitas tenyleg ad pelda-agakat (nem ures a fa),
 *  - a peldak neve felismerhetoen kitalalt (nem keverheto valodi adattal),
 *  - MINDEN fa-mappahoz tartozik sugo -- ez a leggyakoribb regresszio: uj
 *    mappa kerul a NAMES tablaba, es nemán sugo nelkul marad.
 */
import { describe, it, expect } from 'vitest'
import { defaultLifeConfig, SAMPLE_PERSON, SAMPLE_COMPANY, lifeName, lifeKeyForName } from '../life-tree.js'
import { lifeHint, lifeHints, PERSON_HINT, COMPANY_HINT, SAMPLE_PERSON_HINT, SAMPLE_COMPANY_HINT } from '../life-hints.js'

describe('friss telepites alapstrukturaja', () => {
  it('a tulajdonos MELLETT ad egy pelda szemelyt es egy pelda ceget', () => {
    const cfg = defaultLifeConfig()
    expect(cfg.persons.length).toBe(2)
    expect(cfg.persons[0].role).toBe('owner')
    expect(cfg.persons.map((p) => p.name)).toContain(SAMPLE_PERSON)
    expect(cfg.companies.map((c) => c.name)).toEqual([SAMPLE_COMPANY])
  })

  it('a pelda-nevek felismerhetoen kitalaltak', () => {
    // Egy valodinak latszo nev evekig ott maradna, mert senki nem meri torolni.
    expect(SAMPLE_PERSON).toMatch(/Példa/)
    expect(SAMPLE_COMPANY).toMatch(/Példa/)
  })

  it('a pelda-sugo megmondja, hogy at lehet nevezni ES torolni is', () => {
    for (const h of [SAMPLE_PERSON_HINT, SAMPLE_COMPANY_HINT]) {
      expect(h).toMatch(/PÉLDA/)
      expect(h).toMatch(/nevezd át/)
      expect(h).toMatch(/töröld/)
    }
    // A ket sugo kulon all: egyik se kinalja fel a masik ag lehetoseget.
    expect(SAMPLE_PERSON_HINT).not.toMatch(/céged/)
    expect(SAMPLE_COMPANY_HINT).not.toMatch(/hozzátartozó/)
  })

  it('a szemely- es cegmappak sugoja nem ures', () => {
    expect(PERSON_HINT.length).toBeGreaterThan(20)
    expect(COMPANY_HINT.length).toBeGreaterThan(20)
  })
})

describe('a sugok teljessege', () => {
  it('minden sugo visszatalal egy letezo fa-mappara', () => {
    // Elgepelt kulcs eseten a sugo nemán eltunne a feluletrol.
    for (const key of Object.keys(lifeHints())) {
      expect(lifeName(key, 'hu'), `ismeretlen fa-kulcs: ${key}`).not.toBe('')
      expect(lifeKeyForName(lifeName(key, 'hu'))).toBe(key)
    }
  })

  it('a fa fontos mappai mind kapnak sugot', () => {
    const kell = [
      'inbox', 'companies', 'knowledge', 'digital', 'media', 'shared', 'archive', 'system',
      'identity', 'personal', 'family', 'finance', 'legal', 'authorities',
      'home', 'work', 'projects', 'health', 'documents',
    ]
    for (const k of kell) expect(lifeHint(k), `nincs sugo: ${k}`).not.toBe('')
  })

  it('a jelszo-tilalom ott van, ahol kesztetes lenne ra', () => {
    // Spec 21/23: jelszo, API-kulcs, token SOHA nem kerul a fába.
    expect(lifeHint('digital')).toMatch(/jelszó soha/)
    expect(lifeHint('digitalServices')).toMatch(/jelszó soha/)
  })
})
