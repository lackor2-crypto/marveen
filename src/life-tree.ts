// AZ ELETFA: egyetlen, ember altal olvashato mappaszerkezet, amiben a
// felhasznalo az egesz digitalis (es papir-) eletet kezeli.
//
// A VEGLEGES SPECIFIKACIO: `docs/eletfa-specifikacio.md`. Ha ott es itt elter
// valami, a dokumentum a mervado -- ez a fajl annak a megvalositasa.
//
// Negy dolgot kell egyszerre tudnia, es ezek hatarozzak meg a felepiteset:
//
//  1. MARVIN NELKUL IS MUKODJON. Ha a Marveen soha tobbet nem indul el, a
//     felhasznalo a Fajlkezeloben ugyanugy megtalalja a papirjait:
//     `<sajat nev> / JOGI / NEMETORSZAG / BIROSAG`. Ezert nincs benne
//     azonosito, hash, adatbazis-kulcs vagy barmilyen gepi nev: a MAPPANEV maga
//     a jelentes.
//
//  2. NE LEGYEN BENNE EGYETLEN KONKRET SZEMELY-, CEG- VAGY ORSZAGNEV SEM
//     (CLAUDE.md: "GEPFUGGETLEN FEJLESZTES"). A Marveen nyilt forraskodu; ami
//     ide fixen be van irva, az mindenki mas gepen rossz. A fa VAZAT a kod adja
//     (kategoria-kulcsok), a NEVEKET a felhasznalo (`store/life-tree.json`).
//     A kesz sablonok (`life-templates.ts`) is csak `Példa felhasználó 1` fele
//     helyorzoket hasznalnak.
//
//  3. AZ ORSZAG NEM ELETKATEGORIA, hanem egy terulet TULAJDONSAGA. Viszont a
//     Boss kikotese (2026-08-21): akinek tobb orszagban van elete, annak
//     GYAKORLATILAG MINDEN kategoriaja orszagra bomlik -- a jogitol a fotokig.
//     Ezert az orszagbontas nem egy fix harmas lista tobbe, hanem SZEMELYENKENT
//     valaszthato kategoria-halmaz (`countrySplit`).
//
//  4. NINCS "CSOKKENTETT" SZEMELY. A Boss kikotese: minden felvett szemely
//     ugyanazt a teljes szerkezetet kapja, akkor is, ha eppen ures. Korabban a
//     nem-gazda szemelyek rovidebb agat kaptak -- ez rossz volt: azt
//     feltetelezte, hogy egy csaladtagnak nincs munkaja vagy egeszsegugyi
//     irata.
//
// Amit ez a modul NEM csinal: nem torol, nem nevez at, es nem ir felul semmit.
// Csak HIANYZO mappat hoz letre. Egy mar meglevo fan igy tobbszor is
// vegigfuthat kar nelkul.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { APP_LANG, STORE_DIR, currentOwnerName } from './config.js'
import { depotRoot } from './depot.js'
import { logger } from './logger.js'

/** A kiseroirat helye. A fa ettol fuggetlenul all a lemezen. */
const CONFIG_PATH = join(STORE_DIR, 'life-tree.json')

/**
 * Mappanevek nyelvenkent.
 *
 * A KULCS a gepi nev (ez kerul a beallitas-fajlba es az API-ba), az ERTEK az,
 * ami a lemezre kerul. Igy egy angol telepitesen `LEGAL` lesz ugyanaz a hely,
 * amit egy magyaron `JOGI`-nak hivnak, es a kod egyik nevet sem ismeri fixen.
 */
type NameTable = Record<string, { hu: string; en: string }>

const NAMES: NameTable = {
  // Felso szint
  companies:   { hu: 'CÉGEK',       en: 'COMPANIES' },
  knowledge:   { hu: 'TUDÁS',       en: 'KNOWLEDGE' },
  media:       { hu: 'MÉDIA',       en: 'MEDIA' },
  digital:     { hu: 'DIGITÁLIS',   en: 'DIGITAL' },
  inbox:       { hu: 'BEÉRKEZŐ',    en: 'INBOX' },
  shared:      { hu: 'MEGOSZTOTT',  en: 'SHARED' },
  archive:     { hu: 'ARCHÍV',      en: 'ARCHIVE' },
  system:      { hu: 'RENDSZER',    en: 'SYSTEM' },

  // Szemely alatti kategoriak (a specifikacio 11. pontja)
  identity:    { hu: 'IDENTITÁS',   en: 'IDENTITY' },
  personal:    { hu: 'SZEMÉLYES',   en: 'PERSONAL' },
  family:      { hu: 'CSALÁD',      en: 'FAMILY' },
  finance:     { hu: 'PÉNZÜGY',     en: 'FINANCE' },
  legal:       { hu: 'JOGI',        en: 'LEGAL' },
  authorities: { hu: 'HATÓSÁGOK',   en: 'AUTHORITIES' },
  home:        { hu: 'OTTHON',      en: 'HOME' },
  work:        { hu: 'MUNKA',       en: 'WORK' },
  projects:    { hu: 'PROJEKTEK',   en: 'PROJECTS' },
  health:      { hu: 'EGÉSZSÉG',    en: 'HEALTH' },
  documents:   { hu: 'DOKUMENTUMOK', en: 'DOCUMENTS' },

  // Ceg alatti kategoriak (a specifikacio 15. pontja)
  companyAffairs: { hu: 'CÉGES ÜGYEK', en: 'COMPANY AFFAIRS' },
  correspondence: { hu: 'LEVELEZÉS',   en: 'CORRESPONDENCE' },
  knowledgeBase:  { hu: 'TUDÁSBÁZIS',  en: 'KNOWLEDGE BASE' },
  moreMaterial:   { hu: 'TOVÁBBI ANYAGOK', en: 'MORE MATERIAL' },
  website:        { hu: 'WEBOLDAL',    en: 'WEBSITE' },
  development:    { hu: 'FEJLESZTÉS',  en: 'DEVELOPMENT' },
  marketing:      { hu: 'MARKETING',   en: 'MARKETING' },
  // Ez SZANDEKOSAN nem forditodik: a `GIT_REPOS` alatt git-repok allnak, a
  // nevuket a GitHub adja, es a fejlesztonek ugyanugy kell kineznie minden
  // gepen. (Specifikacio 16. pont.)
  gitRepos:       { hu: 'GIT_REPOS',   en: 'GIT_REPOS' },

  // Media-tipusok (a specifikacio 18. pontja)
  photos:      { hu: 'FOTÓK',       en: 'PHOTOS' },
  videos:      { hu: 'VIDEÓK',      en: 'VIDEOS' },
  audio:       { hu: 'AUDIÓ',       en: 'AUDIO' },
  scans:       { hu: 'SZKEN',       en: 'SCANS' },

  // DIGITALIS alatti bontas (a specifikacio 21. pontja). Jelszo NEM.
  domains:         { hu: 'DOMAINEK',   en: 'DOMAINS' },
  devices:         { hu: 'ESZKÖZÖK',   en: 'DEVICES' },
  digitalServices: { hu: 'DIGITÁLIS SZOLGÁLTATÁSOK', en: 'DIGITAL SERVICES' },

  // RENDSZER alatti bontas (a specifikacio 4. pontja)
  marvin:      { hu: 'MARVIN',      en: 'MARVIN' },
  storages:    { hu: 'TÁROLÓK',     en: 'STORAGES' },
  git:         { hu: 'GIT',         en: 'GIT' },
}

/** Egy gepi nevbol a lemezre kerulo mappanev, a telepites nyelven. */
export function lifeName(key: string, lang: string = APP_LANG): string {
  const row = NAMES[key]
  if (!row) return key
  return lang === 'hu' ? row.hu : row.en
}

/** Minden gepi nev, amit a fa hasznal -- a felulet ebbol keszit cimkeket. */
export function lifeNameKeys(): string[] {
  return Object.keys(NAMES)
}

/**
 * Egy szemely szerepe.
 *
 * A szerkezetet MAR NEM ez donti el (minden szemely ugyanazt a teljes agat
 * kapja). Csak azt jelzi, ki a telepites tulajdonosa -- ezt a Beérkezo hasznalja
 * alapertelmezett cimzettkent, es a felulet is kiemeli.
 */
export type PersonRole = 'owner' | 'person'

/** Egy projekt a szemely `PROJEKTEK` aga alatt (specifikacio 12-13. pont). */
export interface LifeProject {
  id: string
  name: string
  /** Keszuljon-e alatta `FEJLESZTÉS/GIT_REPOS` ag. Nem minden projekt szoftver. */
  development: boolean
}

export interface LifePerson {
  /** Gepi azonosito (a mappanev valtoztatasat is tulelo hivatkozas). */
  id: string
  /** Ahogy a felhasznalo hivja -- EZ lesz a mappa neve is. */
  name: string
  role: PersonRole
  /**
   * Orszagok. Uresen hagyva NEM keszul orszag-szint: akinek egy orszaga van,
   * annak felesleges egy plusz kattintas.
   */
  countries: string[]
  /**
   * MELY kategoriak alatt bomoljon orszagra.
   *
   * A Boss kikotese (2026-08-21): "mondom mindent 3 orszagra csinalj" -- aki
   * ket-harom orszagban elt, annak nem csak a jogi ugyei orszagfuggoek, hanem a
   * hatosagi, penzugyi, munka-, otthon- es meg a foto-anyaga is. Ezert ez
   * SZEMELYENKENT allithato lista, nem a kodba drotozott harmas.
   */
  countrySplit: string[]
  /** A media-agban keszulo tipusok (`photos`, `videos`, `audio`, `scans`). */
  mediaKinds: string[]
  /** A media-tipusok alatti bontas (`ÁGI CSALÁDJA`, `UTAZÁS`, ...). */
  mediaGroups: string[]
  /** Sajat, SZEMELYES projektek. Ezek NEM ceges projektek (spec 12. pont). */
  projects: LifeProject[]
}

export interface LifeCompany {
  id: string
  name: string
  /** A ceg orszagai a JOGI / PENZUGY ala. Uresen nincs orszag-szint. */
  countries: string[]
  /** Mely ceges kategoriak bomoljanak orszagra. */
  countrySplit: string[]
}

export interface LifeConfig {
  persons: LifePerson[]
  companies: LifeCompany[]
}

/**
 * Az alapertelmezett media-bontas.
 *
 * SZANDEKOSAN altalanos. A specifikacioban nevesitett csoportok
 * (`ÁGI CSALÁDJA`, `JUTKA CSALÁDJA`) egy konkret ember csaladjai -- pont az,
 * amit tilos a kodba irni. A felhasznalo a feluleten atnevezi oket a sajat
 * csaladtagjaira, es a `Child 1 / Child 2` fele gepi nevezektol ez is megvéd
 * (specifikacio 19. pont).
 */
export function defaultMediaGroups(lang: string = APP_LANG): string[] {
  return lang === 'hu'
    ? ['CSALÁD', 'PÁROM', 'BARÁTOK', 'UTAZÁS', 'OTTHON', 'EGYÉB']
    : ['FAMILY', 'PARTNER', 'FRIENDS', 'TRAVEL', 'HOME', 'OTHER']
}

/** Egy szemely kategoriai, sorrendben (specifikacio 11. pont). */
export const PERSON_CATEGORIES = [
  'identity', 'personal', 'family', 'finance', 'legal', 'authorities',
  'home', 'work', 'projects', 'health', 'documents', 'digital',
]

/**
 * Az orszagbontas alapertelmezese: MINDEN szemelyi kategoria, KIVEVE a
 * `projects`-et.
 *
 * Miert marad ki a projekt? Mert a specifikacio 31. pontja pontosan rogziti a
 * projekt-utvonalat (`<szemely>/PROJEKTEK/<projekt>/FEJLESZTÉS/GIT_REPOS`), es
 * egy koze ekelt orszag-szint ezt elrontana. Egy git-repo amugy sem "magyar"
 * vagy "nemet". Ha valakinek megis kell, a feluleten bekapcsolhatja.
 */
export function defaultCountrySplit(): string[] {
  return PERSON_CATEGORIES.filter((k) => k !== 'projects')
}

/** A valaszthato media-tipusok (specifikacio 18. pont). */
export const MEDIA_KINDS = ['photos', 'videos', 'audio', 'scans'] as const

/** A media-tipusok alapertelmezese: mind a negy. */
export function defaultMediaKinds(): string[] {
  return [...MEDIA_KINDS]
}

/** Egy ceg kategoriai, sorrendben (specifikacio 15. pont). */
export const COMPANY_CATEGORIES = [
  'companyAffairs', 'correspondence', 'knowledgeBase', 'finance',
  'legal', 'marketing', 'website', 'development',
]

/** Ahol egy cegnel ertelme van az orszag-szintnek. */
export function defaultCompanyCountrySplit(): string[] {
  return ['finance', 'legal']
}

/**
 * A media-ag orszagbontasanak kulcsa.
 *
 * Kulon kulcs, mert a `MÉDIA` felso ag NEM a szemely alatti kategoria: aki a
 * jogi ugyeit orszagra bontja, nem feltetlenul akarja a fotoit is. A Boss
 * eseteben viszont igen -- "3 orszagbol van fotok is videok is" --, ezert az
 * alapertelmezes bekapcsolt.
 */
export const MEDIA_COUNTRY_KEY = 'media'

/** A DIGITALIS felso ag bontasa (specifikacio 21. pont). */
const DIGITAL_TOP = ['domains', 'devices', 'digitalServices']

/**
 * Egy nev, ami mappanevnek is jo -- Windowson is --, DE megtartja az ekezeteket.
 *
 * Miert nem a depo `safeDepotName()`-je? Mert az mindent kidob, ami nem
 * angol betu: abbol `ÉLET` helyett `_LET` lenne, es pont a leglenyeg veszne el
 * (hogy a mappanev EMBERI). Itt tehat csak azt vagjuk ki, amit a Windows
 * tenylegesen tilt, plusz a foglalt eszkozneveket (`CON`, `LPT1`, ...), amikbol
 * Windowson egyaltalan nem lehet mappat csinalni.
 */
export function safeLifeName(name: string): string {
  const cleaned = String(name || '')
    // A Windows tiltott jelei + a vezerlokarakterek. A kotojel es az ekezet
    // MARAD: egy kotojeles vezeteknev kotojeles marad.
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    // Windowson a ponttal vagy szokozzel vegzodo mappanev nem nyithato meg.
    .replace(/[. ]+$/, '')
  if (!cleaned) return '_'
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(cleaned)) return `${cleaned}_`
  return cleaned
}

/** Gepi azonosito egy uj szemelyhez/ceghez. Nem a nevbol kepezzuk: a nev valtozhat. */
export function newLifeId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

/**
 * Az eletfa gyokere a lemezen, vagy `null`, ha nincs depo.
 *
 * A specifikacio 3. pontja: NINCS kulon `ÉLET` mappa a fa folott. A szemelyek,
 * a `CÉGEK`, a `MÉDIA` es a tobbi ag KOZVETLENUL a depo gyokereben all --
 * `F:\Marveen\<nev>`, nem `F:\Marveen\ÉLET\<nev>`. Egy kattintassal kevesebb,
 * es a Fajlkezeloben is ez a termeszetes.
 */
export function lifeRoot(): string | null {
  return depotRoot()
}

/** Egy uj szemely, minden alapertelmezessel a helyen. */
export function makePerson(name: string, role: PersonRole = 'person', id?: string): LifePerson {
  return {
    id: id || newLifeId('person'),
    name: safeLifeName(name),
    role,
    countries: [],
    countrySplit: defaultCountrySplit(),
    mediaKinds: defaultMediaKinds(),
    mediaGroups: defaultMediaGroups(),
    projects: [],
  }
}

/** Egy uj ceg, minden alapertelmezessel a helyen. */
export function makeCompany(name: string, id?: string): LifeCompany {
  return {
    id: id || newLifeId('company'),
    name: safeLifeName(name),
    countries: [],
    countrySplit: defaultCompanyCountrySplit(),
  }
}

/** Az alapertelmezett beallitas: EGY szemely, a telepites tulajdonosa. */
export function defaultLifeConfig(): LifeConfig {
  return {
    persons: [makePerson(safeLifeName(currentOwnerName()), 'owner', 'owner')],
    companies: [],
  }
}

/** Egy ismeretlen ertekbol tiszta, ismetlesmentes nevlista. */
function nameList(raw: unknown, fallback: string[] = []): string[] {
  if (!Array.isArray(raw)) return fallback
  const out: string[] = []
  for (const v of raw) {
    const n = safeLifeName(String(v ?? ''))
    if (n && n !== '_' && !out.includes(n)) out.push(n)
  }
  return out
}

/** Egy ismeretlen ertekbol ervenyes kategoria-kulcs lista. */
function keyList(raw: unknown, allowed: string[], fallback: string[]): string[] {
  if (!Array.isArray(raw)) return fallback
  return raw.map((v) => String(v ?? '')).filter((k, i, a) => allowed.includes(k) && a.indexOf(k) === i)
}

/**
 * A beallitas beolvasasa. Serult vagy hianyzo fajlnal az alapertelmezes jon --
 * a lemezen levo fa ettol meg all, csak a Marveen nem tudja rola, mi micsoda.
 *
 * A regi (`countrySplit`, `mediaKinds`, `projects` nelkuli) fajlokat is
 * elfogadja: a hianyzo mezok az alapertelmezest kapjak, igy egy frissites nem
 * teszi tonkre a meglevo beallitast.
 */
/**
 * Egy BARHONNAN jott beallitas kiegeszitese hasznalhatova.
 *
 * Miert kulon fuggveny, es miert nem eleg a `loadLifeConfig()`-ban?
 *
 * Mert a `planLifeTree()` nem csak a mentett fajlbol kap beallitast: kap a
 * vegpontokrol (elonezet mentes elott), a sablonokbol es a tesztekbol is. Egy
 * MERT eset: a regi mentett fajlokban meg nincs `countrySplit`, es a terv
 * keszitese `Cannot read properties of undefined` hibaval allt meg -- vagyis a
 * felhasznalo faja NEM EPULT FEL, es a felulet csak annyit mondott, "szerver
 * hiba". A hianyzo mezo nem hibauzenetet erdemel, hanem alapertelmezest.
 */
export function normalizeLifeConfig(raw: any): LifeConfig {
  const persons: LifePerson[] = Array.isArray(raw?.persons)
    ? raw.persons.filter((p: any) => p && typeof p.name === 'string' && p.name.trim()).map((p: any) => {
      const groups = nameList(p.mediaGroups)
      return {
        id: String(p.id || newLifeId('person')),
        name: safeLifeName(p.name),
        role: p.role === 'owner' ? 'owner' : 'person',
        countries: nameList(p.countries),
        countrySplit: keyList(
          p.countrySplit,
          [...PERSON_CATEGORIES, MEDIA_COUNTRY_KEY],
          defaultCountrySplit(),
        ),
        mediaKinds: keyList(p.mediaKinds, defaultMediaKinds(), defaultMediaKinds()),
        mediaGroups: groups.length ? groups : defaultMediaGroups(),
        projects: Array.isArray(p.projects)
          ? p.projects.filter((x: any) => x && String(x.name || '').trim()).map((x: any) => ({
            id: String(x.id || newLifeId('project')),
            name: safeLifeName(x.name),
            development: x.development !== false,
          }))
          : [],
      } as LifePerson
    })
    : []
  const companies: LifeCompany[] = Array.isArray(raw?.companies)
    ? raw.companies.filter((c: any) => c && typeof c.name === 'string' && c.name.trim()).map((c: any) => ({
      id: String(c.id || newLifeId('company')),
      name: safeLifeName(c.name),
      countries: nameList(c.countries),
      countrySplit: keyList(c.countrySplit, COMPANY_CATEGORIES, defaultCompanyCountrySplit()),
    }))
    : []
  return { persons, companies }
}

export function loadLifeConfig(): LifeConfig {
  try {
    if (!existsSync(CONFIG_PATH)) return defaultLifeConfig()
    const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
    const { persons, companies } = normalizeLifeConfig(raw)
    // Egy szemely nelkul a fanak nincs erteme: ilyenkor visszaesunk a
    // tulajdonosra, kulonben az elso "Fa letrehozasa" gomb ures mappat csinalna.
    if (!persons.length) return { persons: defaultLifeConfig().persons, companies }
    return { persons, companies }
  } catch (err: any) {
    logger.warn({ err: err?.message }, '[eletfa] serult life-tree.json, alapertelmezessel indulok')
    return defaultLifeConfig()
  }
}

export function saveLifeConfig(cfg: LifeConfig): void {
  mkdirSync(STORE_DIR, { recursive: true })
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8')
}

/**
 * Egy elem a tervezett fabol: hova kerul, es MI az (hogy a felulet tudja,
 * kinek/minek a mappaja, es a Beérkezo tudja, hova ajanljon).
 */
export interface LifeNode {
  /** Utvonal az eletfa gyokeretol, per-jellel (`Nev/JOGI/NEMETORSZAG`). */
  rel: string
  /** Gepi kategoria-nev, ha van (`legal`, `finance`, ...). */
  key: string | null
  /** Kihez tartozik: szemely- vagy ceg-azonosito, ha ertelmezheto. */
  ownerId: string | null
  kind: 'person' | 'company' | 'category' | 'country' | 'media' | 'project' | 'top' | 'system'
}

type AddFn = (rel: string, kind: LifeNode['kind'], key?: string | null, ownerId?: string | null) => void

/**
 * A `FEJLESZTÉS` ag: tudasbazis, tovabbi anyagok, es a repok helye.
 *
 * Egy helyen, mert a szemelyes projekt es a ceges fejlesztes UGYANAZT a
 * szerkezetet kapja (specifikacio 13. es 15. pont) -- csak a helyuk mas. Ha ket
 * helyen szamolnank, elobb-utobb elternenek.
 */
function addDevelopmentBranch(
  add: AddFn,
  parent: string,
  lang: string,
  ownerId: string | null,
  parentIsDevelopment = false,
): void {
  const dev = parentIsDevelopment ? parent : `${parent}/${lifeName('development', lang)}`
  if (!parentIsDevelopment) add(dev, 'category', 'development', ownerId)
  add(`${dev}/${lifeName('knowledgeBase', lang)}`, 'category', 'knowledgeBase', ownerId)
  add(`${dev}/${lifeName('moreMaterial', lang)}`, 'category', 'moreMaterial', ownerId)
  add(`${dev}/${lifeName('gitRepos', lang)}`, 'category', 'gitRepos', ownerId)
}

/**
 * A TELJES tervezett fa, kiszamolva a beallitasbol -- a lemez erintese nelkul.
 *
 * Kulon fuggveny, mert harom helyen kell ugyanaz: (1) a letrehozasnak, (2) a
 * felulet elonezetenek ("ez fog elkeszulni"), es (3) a fizikai irattar
 * helyvalasztojanak. Ha barmelyik kulon szamolna, elobb-utobb elternenek, es a
 * felhasznalo mas fat latna, mint amit kap.
 */
export function planLifeTree(input: LifeConfig = loadLifeConfig(), lang: string = APP_LANG): LifeNode[] {
  // A hianyzo mezok itt kapjak meg az alapertelmezesuket -- lasd
  // `normalizeLifeConfig()`. Kulonben egy regi mentett fajl vagy egy kezzel
  // osszerakott objektum kiveteltel allitana meg a fa felepiteset.
  const cfg = normalizeLifeConfig(input)
  const out: LifeNode[] = []
  const add: AddFn = (rel, kind, key = null, ownerId = null) => {
    out.push({ rel, key, ownerId, kind })
  }

  // 1. Szemelyek. A nevuk a felso szinten all, nem egy `SZEMELYEK` gyujto
  //    alatt: a specifikacioban is igy van, es egy kattintassal kevesebb.
  //    MINDEN szemely ugyanazt a teljes szerkezetet kapja -- nincs "csokkentett"
  //    ag egy csaladtagnak.
  for (const p of cfg.persons) {
    const base = safeLifeName(p.name)
    add(base, 'person', null, p.id)
    for (const key of PERSON_CATEGORIES) {
      const cat = `${base}/${lifeName(key, lang)}`
      add(cat, 'category', key, p.id)

      // Orszagbontas ott, ahol a felhasznalo kerte. Nem fix harmas lista:
      // aki ket-harom orszagban elt, annak a munkaja es az otthona is
      // orszagfuggo.
      if (p.countrySplit.includes(key)) {
        for (const c of p.countries) add(`${cat}/${safeLifeName(c)}`, 'country', key, p.id)
      }

      // A szemelyes projektek. A specifikacio 12-13. pontja: a projekt NEM
      // automatikusan ceges dolog, es a sajat projekt git-repoja SOHA nem
      // kerul a ceg repoi koze.
      if (key === 'projects') {
        for (const pr of p.projects) {
          const pb = `${cat}/${safeLifeName(pr.name)}`
          add(pb, 'project', 'projects', p.id)
          add(`${pb}/${lifeName('knowledgeBase', lang)}`, 'category', 'knowledgeBase', p.id)
          add(`${pb}/${lifeName('moreMaterial', lang)}`, 'category', 'moreMaterial', p.id)
          if (pr.development) addDevelopmentBranch(add, pb, lang, p.id)
        }
      }
    }
  }

  // 2. Cegek. A ceg SOHA nem kerul egy szemely ala (specifikacio 14. pont).
  const companiesDir = lifeName('companies', lang)
  add(companiesDir, 'top', 'companies')
  for (const c of cfg.companies) {
    const base = `${companiesDir}/${safeLifeName(c.name)}`
    add(base, 'company', null, c.id)
    for (const key of COMPANY_CATEGORIES) {
      const cat = `${base}/${lifeName(key, lang)}`
      add(cat, 'category', key, c.id)
      if (c.countrySplit.includes(key)) {
        for (const cc of c.countries) add(`${cat}/${safeLifeName(cc)}`, 'country', key, c.id)
      }
      // A fejlesztes ala megy a tudasbazis es a repok helye. A Marveen a
      // repok SAJAT dokumentacios retegehez nem nyul -- csak a helyet adja.
      if (key === 'development') addDevelopmentBranch(add, cat, lang, c.id, true)
      // Keves ceges kep van: nem kap sajat agat a felso MEDIA alatt, hanem a
      // marketing ala kerul (specifikacio 9. pont).
      if (key === 'marketing') {
        const media = `${cat}/${lifeName('media', lang)}`
        add(media, 'category', 'media', c.id)
        for (const m of ['photos', 'videos']) add(`${media}/${lifeName(m, lang)}`, 'media', m, c.id)
      }
    }
  }

  // 3. A nagy keptar (specifikacio 18-20. pont): szemelyenkent, media-tipusra,
  //    orszagra, majd csaladi csoportra bontva. A Boss kikotese: "a fotok is
  //    kulon kellene szedni, mert nekem 3 orszagbol van fotok is videok is".
  const mediaDir = lifeName('media', lang)
  add(mediaDir, 'top', 'media')
  for (const p of cfg.persons) {
    const base = `${mediaDir}/${safeLifeName(p.name)}`
    add(base, 'person', null, p.id)
    const mediaCountries = p.countrySplit.includes(MEDIA_COUNTRY_KEY) ? p.countries : []
    for (const m of p.mediaKinds) {
      const sub = `${base}/${lifeName(m, lang)}`
      add(sub, 'media', m, p.id)
      if (mediaCountries.length) {
        for (const c of mediaCountries) {
          const cd = `${sub}/${safeLifeName(c)}`
          add(cd, 'country', m, p.id)
          for (const g of p.mediaGroups) add(`${cd}/${safeLifeName(g)}`, 'media', m, p.id)
        }
      } else {
        for (const g of p.mediaGroups) add(`${sub}/${safeLifeName(g)}`, 'media', m, p.id)
      }
    }
  }
  if (cfg.companies.length) {
    const base = `${mediaDir}/${companiesDir}`
    add(base, 'top', 'companies')
    for (const c of cfg.companies) {
      const cb = `${base}/${safeLifeName(c.name)}`
      add(cb, 'company', null, c.id)
      for (const m of ['photos', 'videos']) add(`${cb}/${lifeName(m, lang)}`, 'media', m, c.id)
    }
  }

  // 4. A tobbi felso szintu ag.
  add(lifeName('knowledge', lang), 'top', 'knowledge')

  // DIGITALIS: NEM masolatgyujto. Csak onallo eletciklusu digitalis dolgok --
  // es jelszo SOHA (specifikacio 21. pont).
  const digitalDir = lifeName('digital', lang)
  add(digitalDir, 'top', 'digital')
  for (const key of DIGITAL_TOP) add(`${digitalDir}/${lifeName(key, lang)}`, 'category', key)

  add(lifeName('inbox', lang), 'top', 'inbox')
  add(lifeName('shared', lang), 'top', 'shared')

  // ARCHIV: a lezart anyagoke, ugyanazzal a felosztassal (specifikacio 25.).
  const archiveDir = lifeName('archive', lang)
  add(archiveDir, 'top', 'archive')
  for (const p of cfg.persons) add(`${archiveDir}/${safeLifeName(p.name)}`, 'person', null, p.id)
  if (cfg.companies.length) add(`${archiveDir}/${companiesDir}`, 'top', 'companies')

  // 5. RENDSZER: a technikai reteg (specifikacio 4. pont). A felhasznalo NEM
  //    ide jar -- a tarolokat a Beallitasok > Tarolok oldal kezeli. Azert van
  //    megis a fan belul, hogy egy lemezmasolas mindent egyben vigyen.
  const systemDir = lifeName('system', lang)
  add(systemDir, 'system', 'system')
  add(`${systemDir}/${lifeName('marvin', lang)}`, 'system', 'marvin')
  add(`${systemDir}/${lifeName('storages', lang)}`, 'system', 'storages')
  add(`${systemDir}/${lifeName('git', lang)}`, 'system', 'git')

  return out
}

/**
 * Az az egyetlen szoveg, ami akkor is elmondja a rendszert, ha a Marveen nem fut.
 *
 * A tervezesi alapelv (Boss): "a Marvin legyen intelligens reteg a fajlrendszer
 * folott, ne pedig egy fekete doboz". Ha valakinek ket ev mulva a kezebe kerul
 * ez a lemez, ebbol a fajlbol megerti, mit lat -- program nelkul.
 */
function readmeText(cfg: LifeConfig, lang: string): string {
  const nl = (hu: string, en: string) => (lang === 'hu' ? hu : en)
  const lines: string[] = []
  lines.push(nl('# Mi ez a mappa?', '# What is this folder?'))
  lines.push('')
  lines.push(nl(
    'Ebben a mappában a teljes digitális (és papír-) életed van rendszerezve.',
    'This folder holds your whole digital (and paper) life, organised.',
  ))
  lines.push(nl(
    'A Marveen hozta létre, de NEM kell hozzá: minden mappa neve emberi nyelvű,',
    'Marveen created it, but it does not need Marveen: every folder name is plain',
  ))
  lines.push(nl(
    'tehát a Fájlkezelőben ugyanígy megtalálsz mindent.',
    'language, so you can find everything in your file manager just the same.',
  ))
  lines.push('')
  lines.push(nl('## A logika', '## The logic'))
  lines.push('')
  lines.push(nl(
    '  <személy vagy cég> / <terület> / <ország, ha van> / <ügy>',
    '  <person or company> / <area> / <country, if any> / <case>',
  ))
  lines.push('')
  lines.push(nl(
    'Az ország nem külön életkategória, hanem egy terület tulajdonsága: annál',
    'A country is not a life category of its own but a property of an area: it',
  ))
  lines.push(nl(
    'jelenik meg, akinek több országban van élete.',
    'appears for whoever has a life in more than one country.',
  ))
  lines.push('')
  lines.push(nl('## A papír-irattár UGYANEZ', '## The paper archive is THE SAME'))
  lines.push('')
  lines.push(nl(
    'A fizikai iratrendezőidet is pontosan így címkézd. Nincs QR-kód, nincs',
    'Label your physical binders exactly the same way. No QR codes, no folder',
  ))
  lines.push(nl(
    'mappa-azonosító, nincs külön nyilvántartás -- ha a digitális példány itt van:',
    'IDs, no separate registry: if the digital copy lives here:',
  ))
  lines.push('')
  const first = cfg.persons[0]?.name || nl('Név', 'Name')
  lines.push(`  ${first} / ${lifeName('legal', lang)} / ...`)
  lines.push('')
  lines.push(nl(
    'akkor a papír is ott van, ugyanezen a néven. Ennyi az egész.',
    'then the paper is there too, under the same name. That is all.',
  ))
  lines.push('')
  lines.push(nl('## A RENDSZER mappa', '## The SYSTEM folder'))
  lines.push('')
  lines.push(nl(
    'Az a Marveen technikai területe: oda szinkronizálódnak a Drive- és',
    'That is Marveen technical area: the Drive and Photos storages sync into it.',
  ))
  lines.push(nl(
    'Fotók-tárolók. Nem kell odamenned -- a fájljaidat a fenti mappákban látod.',
    'You never need to go there -- your files show up in the folders above.',
  ))
  lines.push('')
  lines.push(nl('## Amit itt SOSEM találsz', '## What you will NEVER find here'))
  lines.push('')
  lines.push(nl(
    'Jelszó, API-kulcs, token: azok a Marveen Vaultban maradnak, nem fájlokban.',
    'Passwords, API keys, tokens: those stay in the Marveen Vault, never in files.',
  ))
  lines.push('')
  return lines.join('\n')
}

export interface EnsureLifeTreeResult {
  ok: boolean
  /** Az eletfa gyokere, vagy null, ha nincs depo. */
  root: string | null
  /** Amit MOST hoztunk letre (relativ utvonalak). */
  created: string[]
  /** Ami mar allt. */
  existed: number
  /** Amit nem sikerult: relativ utvonal + ok. */
  failed: Array<{ rel: string; error: string }>
  message: string
}

/**
 * A fa letrehozasa/kiegeszitese a lemezen.
 *
 * Csak HIANYZO mappat keszit. Sosem torol, sosem nevez at, es a README-t sem
 * irja felul, ha a felhasznalo beleirt valamit -- csak akkor keszul el, ha meg
 * nincs. Egy hiba (jogosultsag, lecsatolt lemez) nem allitja meg a tobbit: a
 * lista vegen kimondjuk, mi nem sikerult.
 */
export function ensureLifeTree(cfg: LifeConfig = loadLifeConfig(), lang: string = APP_LANG): EnsureLifeTreeResult {
  const root = lifeRoot()
  if (!root) {
    return {
      ok: false, root: null, created: [], existed: 0, failed: [],
      message: 'Nincs depó beállítva, ezért nincs hol létrehozni az életfát. '
        + 'Előbb a Depó oldalon add meg, melyik mappában legyen a Marveen tárhelye.',
    }
  }
  // A gyokernek mar allnia kell. Enelkul egy lecsatolt lemeznel a
  // `recursive: true` a semmibe huzna fel az egesz fat -- ez a depo modulban
  // egyszer mar mert hibamod volt (elszallt WSL-atjaro), es itt ugyanugy
  // fenyeget.
  let rootOk = false
  try { rootOk = existsSync(root) && statSync(root).isDirectory() } catch { rootOk = false }
  if (!rootOk) {
    return {
      ok: false, root, created: [], existed: 0, failed: [],
      message: `A depó mappája most nem érhető el: ${root}. `
        + 'Ha külső lemezen van, csatlakoztasd. Amíg nem érhető el, nem hozok létre semmit.',
    }
  }

  const created: string[] = []
  const failed: Array<{ rel: string; error: string }> = []
  let existed = 0

  for (const node of planLifeTree(cfg, lang)) {
    const full = join(root, ...node.rel.split('/'))
    if (existsSync(full)) { existed++; continue }
    try {
      mkdirSync(full, { recursive: true })
      created.push(node.rel)
    } catch (err: any) {
      failed.push({ rel: node.rel, error: String(err?.code || err?.message || err) })
    }
  }

  // A kiseroirat. Csak ha meg nincs -- amit a felhasznalo beleirt, az az ove.
  const readme = join(root, lang === 'hu' ? 'OLVASS_EL.md' : 'READ_ME_FIRST.md')
  if (!existsSync(readme)) {
    try { writeFileSync(readme, readmeText(cfg, lang), 'utf8') } catch { /* a fa ettol meg all */ }
  }

  const message = failed.length
    ? `Az életfa elkészült, de ${failed.length} mappát nem sikerült létrehozni. Nézd meg a mappa jogosultságait.`
    : created.length
      ? `Kész: ${created.length} új mappa készült el az életfában.`
      : 'Az életfa már teljes, nem kellett újat létrehozni.'

  logger.info({ created: created.length, existed, failed: failed.length }, '[eletfa] vazszerkezet ellenorizve')
  return { ok: failed.length === 0, root, created, existed, failed, message }
}

/**
 * Mar all-e a fa a lemezen?
 *
 * Nem "letezik-e a gyoker": azt kerdezzuk, HANY tervezett mappa van meg. Egy
 * felig kesz fa (megszakadt letrehozas, kozben lecsatolt lemez) igy nem
 * latszik keszen -- a felulet meg tudja mondani, hogy hianyzik belole valami.
 */
export function lifeTreeStatus(cfg: LifeConfig = loadLifeConfig(), lang: string = APP_LANG): {
  root: string | null; exists: boolean; planned: number; present: number; missing: string[]
} {
  const root = lifeRoot()
  const plan = planLifeTree(cfg, lang)
  if (!root) return { root: null, exists: false, planned: plan.length, present: 0, missing: plan.map((n) => n.rel) }
  let exists = false
  try { exists = existsSync(root) && statSync(root).isDirectory() } catch { exists = false }
  if (!exists) return { root, exists: false, planned: plan.length, present: 0, missing: plan.map((n) => n.rel) }
  const missing: string[] = []
  let present = 0
  for (const n of plan) {
    try {
      if (existsSync(join(root, ...n.rel.split('/')))) present++
      else missing.push(n.rel)
    } catch { missing.push(n.rel) }
  }
  return { root, exists: true, planned: plan.length, present, missing }
}

/** A BEÉRKEZŐ mappa teljes utvonala, vagy null, ha nincs depo. */
export function inboxDir(lang: string = APP_LANG): string | null {
  const root = lifeRoot()
  return root ? join(root, lifeName('inbox', lang)) : null
}

/** Hany tetel var a Beérkezoben? Hianyzo mappanal 0, nem hiba. */
export function inboxCount(lang: string = APP_LANG): number {
  const dir = inboxDir(lang)
  if (!dir) return 0
  try {
    return existsSync(dir) ? readdirSync(dir).filter((f) => !f.startsWith('.')).length : 0
  } catch {
    return 0
  }
}
