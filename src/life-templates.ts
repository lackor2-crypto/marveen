// KESZ ELETFA-SABLONOK -- hogy egy frissen telepitett Marveen se ures kepernyovel
// fogadjon.
//
// Boss kikotese (2026-08-21): "a marveen t letolto user az is lassa ezt a
// mapparendszert, mint egyik javasolt mapparendszer. amit ha akar kivalaszthat
// maganak es azonnal felepulne a eletfaja neki is. aztan kesobb o is meg
// igazithat rajta."
//
// Ket dolog miatt van ez KULON fajlban:
//
//  1. HELYORZO NEVEK, SOHA VALODIAK. A sablonokban `Példa felhasználó 1`,
//     `Példa cég 1`, `Ország 1` all -- nem `Korpás László`, nem `Magyarország`.
//     A specifikacio 29-30. pontja ezt kifejezetten tiltja: ami ide fixen be van
//     irva, az minden mas felhasznalo gepen rossz. A felhasznalo a sablon
//     valasztasa utan a feluleten atirja oket sajat magara.
//
//  2. A SABLON CSAK BEALLITAST AD, NEM IR LEMEZRE. Egy sablon
//     `LifeConfig`-ga alakul, azt a felulet megmutatja elonezetben, es csak az
//     "Elteszem" utan keszul belole mappa. Igy a valasztas visszavonhato marad.
import { APP_LANG } from './config.js'
import {
  defaultCompanyCountrySplit, defaultCountrySplit, defaultMediaGroups, defaultMediaKinds,
  makeCompany, makePerson, newLifeId, MEDIA_COUNTRY_KEY,
  type LifeConfig, type LifePerson,
} from './life-tree.js'

export interface LifeTemplate {
  id: string
  /** Rovid, emberi nev a valasztolistan. */
  title: string
  /** Egy mondat: kinek valo. */
  summary: string
  /** Mit kap benne -- a felulet felsorolaskent mutatja. */
  highlights: string[]
  /** A belole keszulo beallitas. */
  build(lang: string): LifeConfig
}

/** Helyorzo nevek a telepites nyelven. Sose valodi nev. */
function placeholders(lang: string) {
  const hu = lang === 'hu'
  return {
    person: (n: number) => (hu ? `Példa felhasználó ${n}` : `Example person ${n}`),
    company: (n: number) => (hu ? `Példa cég ${n}` : `Example company ${n}`),
    country: (n: number) => (hu ? `Ország ${n}` : `Country ${n}`),
    project: (n: number) => (hu ? `Példa projekt ${n}` : `Example project ${n}`),
  }
}

/**
 * Egy szemely a sablonhoz: nev, orszagok, projektek.
 *
 * A `countrySplit` alapertelmezese mindent lefed a projekten kivul, es a media
 * bontast is bekapcsoljuk, ha van tobb orszag -- pontosan azt adja, amit a
 * specifikacio ker: aki tobb orszagban elt, annak a fotoi is orszagra bomlanak.
 */
function person(name: string, role: 'owner' | 'person', countries: string[], projects: string[], lang: string): LifePerson {
  const p = makePerson(name, role)
  p.countries = countries
  p.countrySplit = countries.length
    ? [...defaultCountrySplit(), MEDIA_COUNTRY_KEY]
    : defaultCountrySplit()
  p.mediaKinds = defaultMediaKinds()
  p.mediaGroups = defaultMediaGroups(lang)
  p.projects = projects.map((n) => ({ id: newLifeId('project'), name: n, development: true }))
  return p
}

export const LIFE_TEMPLATES: LifeTemplate[] = [
  {
    id: 'solo',
    title: 'Egy személy, egy ország',
    summary: 'A legegyszerűbb: csak te, ország-bontás nélkül. Később bármikor bővíthető.',
    highlights: [
      '1 személy a teljes 12 kategóriával',
      'Nincs ország-szint (egy országban élsz)',
      'Média ág fotók, videók, audió, szken bontásban',
    ],
    build(lang) {
      const ph = placeholders(lang)
      return { persons: [person(ph.person(1), 'owner', [], [], lang)], companies: [] }
    },
  },
  {
    id: 'multi-country',
    title: 'Egy személy, több ország',
    summary: 'Ha több országban éltél vagy dolgoztál: minden területed ország szerint bomlik, a fotóid is.',
    highlights: [
      '1 személy a teljes 12 kategóriával',
      '3 ország MINDEN kategória alatt (jogi, pénzügy, hatóságok, munka, otthon…)',
      'A Média is ország szerint bomlik — külön a három ország fotói és videói',
    ],
    build(lang) {
      const ph = placeholders(lang)
      const countries = [ph.country(1), ph.country(2), ph.country(3)]
      return { persons: [person(ph.person(1), 'owner', countries, [], lang)], companies: [] }
    },
  },
  {
    id: 'family-multi-country',
    title: 'Család, több ország',
    summary: 'Két személy — mindkettő a TELJES szerkezetet kapja, üresen is —, eltérő országlistával.',
    highlights: [
      '2 személy, mindkettő a teljes 12 kategóriával',
      'Az első személynek 3, a másodiknak 2 ország',
      'Országbontás minden területen és a médiában is',
      'Archív ág mindkét személynek',
    ],
    build(lang) {
      const ph = placeholders(lang)
      return {
        persons: [
          person(ph.person(1), 'owner', [ph.country(1), ph.country(2), ph.country(3)], [], lang),
          person(ph.person(2), 'person', [ph.country(1), ph.country(2)], [], lang),
        ],
        companies: [],
      }
    },
  },
  {
    id: 'full',
    title: 'Teljes: család, cég és fejlesztés',
    summary: 'A specifikáció teljes képe — két személy, egy cég, saját projekt git-repókkal.',
    highlights: [
      '2 személy a teljes szerkezettel, eltérő országlistával',
      '1 cég a 8 céges kategóriával, Fejlesztés / GIT_REPOS ággal',
      'Saját, Személyes projekt is — külön a cég repóitól',
      'Rendszer / Tárolók a Drive- és Fotók-tárolóknak',
    ],
    build(lang) {
      const ph = placeholders(lang)
      const company = makeCompany(ph.company(1))
      company.countries = [ph.country(1)]
      company.countrySplit = defaultCompanyCountrySplit()
      return {
        persons: [
          person(ph.person(1), 'owner', [ph.country(1), ph.country(2), ph.country(3)], [ph.project(1)], lang),
          person(ph.person(2), 'person', [ph.country(1), ph.country(2)], [], lang),
        ],
        companies: [company],
      }
    },
  },
]

/** Egy sablon azonositobol, vagy `null`, ha nincs ilyen. */
export function findLifeTemplate(id: string): LifeTemplate | null {
  return LIFE_TEMPLATES.find((t) => t.id === id) || null
}

/**
 * A sablonok listaja a feluletnek -- a `build` fuggveny nelkul, DE a belole
 * keszulo mappaszammal.
 *
 * Miert szamoljuk ki? Mert a valasztashoz az a leghasznosabb informacio, hogy
 * "ebbol 312 mappa lesz" vagy "ebbol 41" -- ez donti el, hogy tulzas-e valakinek.
 */
export function listLifeTemplates(lang: string = APP_LANG): Array<{
  id: string; title: string; summary: string; highlights: string[]; config: LifeConfig
}> {
  return LIFE_TEMPLATES.map((t) => ({
    id: t.id,
    title: t.title,
    summary: t.summary,
    highlights: t.highlights,
    config: t.build(lang),
  }))
}
