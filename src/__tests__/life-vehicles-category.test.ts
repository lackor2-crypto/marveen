/**
 * A JARMU AG (Boss, 2026-09-20).
 *
 * Miert kell ra teszt: a jarmu-iratoknak (forgalmi, muszaki vizsga, biztositas,
 * szervizszamlak) korabban EGYETLEN szemely-kategoria sem adott helyet, es a
 * felhasznalo a feluletrol nem tud uj kategoriat felvenni -- a lista a kodban
 * all. Ha valaki kesobb kiveszi innen, a hianyt semmi mas nem jelezne: a fa
 * ettol meg felepulne, csak az autos papirok szorodnanak szet ujra.
 *
 * Amit ez a teszt kimond:
 *   1. a `vehicles` kulcs OTT VAN a szemely-kategoriak kozott,
 *   2. MINDEN felvett szemely megkapja (nincs "csokkentett" szemely),
 *   3. van hozza KETNYELVU mappanev es KETNYELVU sugo (a CLAUDE.md ketnyelvu-
 *      szabalya), es egyik nyelven sem ures,
 *   4. orszagbontasra ugyanugy valaszthato, mint a tobbi kategoria.
 */
import { describe, it, expect } from 'vitest'
import { PERSON_CATEGORIES, planLifeTree, lifeName, lifeKeyForName } from '../life-tree.js'
import { lifeHint } from '../life-hints.js'

/** Ket szemely, szandekosan kulonbozo beallitasokkal. */
const CFG: any = {
  persons: [
    {
      id: 'p1', name: 'Példa felhasználó 1', role: 'owner',
      countries: ['Magyarország', 'Németország'],
      countrySplit: ['legal', 'finance', 'authorities'],
      mediaKinds: ['photos'], mediaGroups: ['Család'], projects: [],
    },
    {
      id: 'p2', name: 'Példa felhasználó 2', role: 'person',
      countries: [], countrySplit: [],
      mediaKinds: ['photos'], mediaGroups: ['Család'], projects: [],
    },
  ],
  companies: [],
}

describe('eletfa: Jarmu kategoria', () => {
  it('a `vehicles` kulcs a szemely-kategoriak kozott all', () => {
    expect(PERSON_CATEGORIES).toContain('vehicles')
  })

  it('MINDEN szemely megkapja a Jarmu mappat -- az is, akinek nincs orszaga', () => {
    for (const lang of ['hu', 'en']) {
      const rels = planLifeTree(CFG, lang).map((n) => n.rel)
      for (const p of CFG.persons) {
        expect(rels).toContain(`${p.name}/${lifeName('vehicles', lang)}`)
      }
    }
  })

  it('ketnyelvu a mappanev, es mindket nev visszafejtheto', () => {
    expect(lifeName('vehicles', 'hu')).toBe('Jármű')
    expect(lifeName('vehicles', 'en')).toBe('Vehicles')
    expect(lifeKeyForName('Jármű')).toBe('vehicles')
    expect(lifeKeyForName('Vehicles')).toBe('vehicles')
  })

  it('ketnyelvu a sugo, es egyik nyelven sem ures', () => {
    for (const lang of ['hu', 'en']) {
      const h = lifeHint('vehicles', lang)
      expect(h.trim().length).toBeGreaterThan(20)
    }
    expect(lifeHint('vehicles', 'hu')).not.toBe(lifeHint('vehicles', 'en'))
  })

  it('orszagbontasra ugyanugy valaszthato, mint a tobbi kategoria', () => {
    const cfg = JSON.parse(JSON.stringify(CFG))
    cfg.persons[0].countrySplit = ['vehicles']
    const rels = planLifeTree(cfg, 'hu').map((n: any) => n.rel)
    const base = `${cfg.persons[0].name}/${lifeName('vehicles', 'hu')}`
    expect(rels).toContain(`${base}/Magyarország`)
    expect(rels).toContain(`${base}/Németország`)
  })
})
