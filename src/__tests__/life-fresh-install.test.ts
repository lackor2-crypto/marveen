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
import {
  lifeHint, lifeHints, hintTables, personHint, companyHint,
  samplePersonHint, sampleCompanyHint, devKnowledgeHint, devMoreHint,
} from '../life-hints.js'

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
    for (const h of [samplePersonHint('hu'), sampleCompanyHint('hu')]) {
      expect(h).toMatch(/PÉLDA/)
      expect(h).toMatch(/nevezd át/)
      expect(h).toMatch(/töröld/)
    }
    // A ket sugo kulon all: egyik se kinalja fel a masik ag lehetoseget.
    expect(samplePersonHint('hu')).not.toMatch(/céged/)
    expect(sampleCompanyHint('hu')).not.toMatch(/hozzátartozó/)
  })

  it('a szemely- es cegmappak sugoja nem ures', () => {
    expect(personHint('hu').length).toBeGreaterThan(20)
    expect(companyHint('hu').length).toBeGreaterThan(20)
  })
})

describe('a sugok teljessege', () => {
  it('minden sugo visszatalal egy letezo fa-mappara', () => {
    // Elgepelt kulcs eseten a sugo nemán eltunne a feluletrol.
    for (const key of Object.keys(lifeHints('hu'))) {
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
    for (const k of kell) expect(lifeHint(k, 'hu'), `nincs sugo: ${k}`).not.toBe('')
  })

  it('a jelszo-tilalom ott van, ahol kesztetes lenne ra', () => {
    // Spec 21/23: jelszo, API-kulcs, token SOHA nem kerul a fába.
    expect(lifeHint('digital', 'hu')).toMatch(/jelszó soha/)
    expect(lifeHint('digitalServices', 'hu')).toMatch(/jelszó soha/)
  })
})

describe('a ket egyforma nevu Tudasbazis szetvalasztasa', () => {
  // A `Fejlesztés` alatt es a projekt/ceg szintjen is all `Tudásbázis` es
  // `További anyagok` -- a specifikacio 17. pontja szerint ket kulon reteg,
  // de a nevuk beture azonos. Aki a kepernyot nezi, duplikaciot lat. Ezert a
  // ket helyen KULONBOZO sugonak kell allnia.
  it('a fejlesztes alatti sugo mas, mint a projekt szintjen allo', () => {
    expect(devKnowledgeHint('hu')).not.toBe(lifeHint('knowledgeBase', 'hu'))
    expect(devMoreHint('hu')).not.toBe(lifeHint('moreMaterial', 'hu'))
  })

  it('a fejlesztesi tudasbazis kimondja, hogy nem ugyanaz', () => {
    expect(devKnowledgeHint('hu')).toMatch(/nem ugyanaz/)
  })

  it('a szint-fuggetlen sugok nem beszelnek cegrol', () => {
    // Ugyanez a mappa egy SZEMELYES projekt (Marvin) alatt is all.
    expect(lifeHint('knowledgeBase', 'hu')).not.toMatch(/cég/)
    expect(lifeHint('moreMaterial', 'hu')).not.toMatch(/cég/)
  })
})

describe('a sugok ketnyelvusege', () => {
  // Boss, 2026-08-23: „nincs meg angol nyelven!!!!!". A sugok latszanak a
  // kepernyon, tehat ugyanugy forditando feluleti szoveg, mint a gombfelirat --
  // csak eppen nem a lang-fajlokban all, ezert a nyelvi paritas-teszt nem latta.
  const { hints, special } = hintTables()
  const minden = { ...hints, ...special }

  it('minden sugonak van magyar ES angol valtozata', () => {
    for (const [key, h] of Object.entries(minden)) {
      expect(h.hu.trim(), `ures magyar sugo: ${key}`).not.toBe('')
      expect(h.en.trim(), `ures angol sugo: ${key}`).not.toBe('')
    }
  })

  it('az angol valtozat nem a magyar atmasolva', () => {
    // A leggyakoribb „forditas": ctrl-c, ctrl-v, majd senki nem er vissza ra.
    for (const [key, h] of Object.entries(minden)) {
      expect(h.en, `az angol sugo azonos a magyarral: ${key}`).not.toBe(h.hu)
      expect(h.en, `magyar ekezetek az angol sugoban: ${key}`).not.toMatch(/[őűáéíóöúüŐŰÁÉÍÓÖÚÜ]/)
    }
  })

  it('a valaszto tenyleg a kert nyelvet adja', () => {
    // Ha a `lang` parameter valahol elveszne, ez a ket sor mindig egyenlo lenne.
    expect(lifeHint('inbox', 'en')).toBe(minden.inbox.en)
    expect(lifeHint('inbox', 'hu')).toBe(minden.inbox.hu)
    expect(Object.keys(lifeHints('en'))).toEqual(Object.keys(lifeHints('hu')))
  })

  it('a jelszo-tilalom angolul is ott all', () => {
    // Spec 21/23 nem nyelvfuggo: a Szef-szabaly minden telepitesen latszik.
    expect(lifeHint('digital', 'en')).toMatch(/never|Vault/i)
    expect(lifeHint('digitalServices', 'en')).toMatch(/never|Vault/i)
  })
})
