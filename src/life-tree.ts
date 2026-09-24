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
//
// ES AMIT KULON NEM CSINAL (Boss, 2026-09-20): amit a FELHASZNALO kitorolt, azt
// NEM hozza vissza. Egy hianyzo tervezett mappa ket dolgot jelenthet -- "meg
// soha nem letezett" (letrehozzuk) vagy "a felhasznalo eldobta" (bekenhagyjuk),
// es a kettot a `life-tree-ledger.ts` naploja valasztja szet. Az elhagyott
// mappa nem hibajelzes: a feluleten kulon listaban all, es egy kattintassal
// visszakerheto.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { APP_LANG, STORE_DIR, currentOwnerName } from './config.js'
import { lifeLedgerSeen, rememberLifeCreated } from './life-tree-ledger.js'
import { depotRoot } from './depot.js'
import { logger } from './logger.js'

/** A kiseroirat helye. A fa ettol fuggetlenul all a lemezen. */
const CONFIG_PATH = join(STORE_DIR, 'life-tree.json')

/**
 * Mappanevek nyelvenkent.
 *
 * A KULCS a gepi nev (ez kerul a beallitas-fajlba es az API-ba), az ERTEK az,
 * ami a lemezre kerul. Igy egy angol telepitesen `Legal` lesz ugyanaz a hely,
 * amit egy magyaron `Jogi`-nak hivnak, es a kod egyik nevet sem ismeri fixen.
 */
type NameTable = Record<string, { hu: string; en: string }>

const NAMES: NameTable = {
  // Felso szint
  companies:   { hu: 'Cégek',       en: 'Companies' },
  knowledge:   { hu: 'Tudás',       en: 'Knowledge' },
  media:       { hu: 'Média',       en: 'Media' },
  digital:     { hu: 'Digitális',   en: 'Digital' },
  inbox:       { hu: 'Beérkező',    en: 'Inbox' },
  shared:      { hu: 'Megosztott',  en: 'Shared' },
  archive:     { hu: 'Archív',      en: 'Archive' },
  system:      { hu: 'Rendszer',    en: 'System' },

  // Szemely alatti kategoriak (a specifikacio 11. pontja)
  identity:    { hu: 'Identitás',   en: 'Identity' },
  personal:    { hu: 'Személyes',   en: 'Personal' },
  family:      { hu: 'Család',      en: 'Family' },
  finance:     { hu: 'Pénzügy',     en: 'Finance' },
  legal:       { hu: 'Jogi',        en: 'Legal' },
  authorities: { hu: 'Hatóságok',   en: 'Authorities' },
  home:        { hu: 'Otthon',      en: 'Home' },
  vehicles:    { hu: 'Jármű',       en: 'Vehicles' },
  work:        { hu: 'Munka',       en: 'Work' },
  projects:    { hu: 'Projektek',   en: 'Projects' },
  health:      { hu: 'Egészség',    en: 'Health' },
  documents:   { hu: 'Dokumentumok', en: 'Documents' },

  // Ceg alatti kategoriak (a specifikacio 15. pontja)
  companyAffairs: { hu: 'Céges ügyek', en: 'Company affairs' },
  correspondence: { hu: 'Levelezés',   en: 'Correspondence' },
  knowledgeBase:  { hu: 'Tudásbázis',  en: 'Knowledge base' },
  moreMaterial:   { hu: 'További anyagok', en: 'More material' },
  website:        { hu: 'Weboldal',    en: 'Website' },
  development:    { hu: 'Fejlesztés',  en: 'Development' },
  marketing:      { hu: 'Marketing',   en: 'Marketing' },
  // Ez SZANDEKOSAN nem forditodik: a `GIT_REPOS` alatt git-repok allnak, a
  // nevuket a GitHub adja, es a fejlesztonek ugyanugy kell kineznie minden
  // gepen. (Specifikacio 16. pont.)
  gitRepos:       { hu: 'GIT_REPOS',   en: 'GIT_REPOS' },

  // Media-tipusok (a specifikacio 18. pontja)
  photos:      { hu: 'Fotók',       en: 'Photos' },
  videos:      { hu: 'Videók',      en: 'Videos' },
  audio:       { hu: 'Audió',       en: 'Audio' },
  scans:       { hu: 'Szkennek',    en: 'Scans' },

  // DIGITALIS alatti bontas (a specifikacio 21. pontja). Jelszo NEM.
  domains:         { hu: 'Domainek',   en: 'Domains' },
  devices:         { hu: 'Eszközök',   en: 'Devices' },
  digitalServices: { hu: 'Digitális szolgáltatások', en: 'Digital services' },

  // RENDSZER alatti bontas (a specifikacio 4. pontja)
  marvin:      { hu: 'Marvin',      en: 'Marvin' },
  storages:    { hu: 'Tárolók',     en: 'Storages' },
  trash:       { hu: 'Kuka',        en: 'Trash' },
  git:         { hu: 'Git',         en: 'Git' },
}

/** Egy gepi nevbol a lemezre kerulo mappanev, a telepites nyelven. */
export function lifeName(key: string, lang: string = APP_LANG): string {
  const row = NAMES[key]
  if (!row) return key
  return lang === 'hu' ? row.hu : row.en
}

/**
 * Egy LEMEZEN LEVO mappanevbol a gepi kulcs, vagy ures.
 *
 * Mindket nyelvet nezi: egy magyar telepitesen keszult fat egy angolra allitott
 * gepen is fel kell ismerni, kulonben a sugo eltunne a mappak mellol.
 */
export function lifeKeyForName(name: string): string {
  const n = String(name || '').trim()
  if (!n) return ''
  for (const [key, row] of Object.entries(NAMES)) {
    if (row.hu === n || row.en === n) return key
  }
  return ''
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
  /** A media-tipusok alatti bontas (`Ági családja`, `Utazás`, ...). */
  mediaGroups: string[]
  /** Sajat, SZEMELYES projektek. Ezek NEM ceges projektek (spec 12. pont). */
  projects: LifeProject[]
  /**
   * Kinek a mappaja ala kerul ez a szemely irat/media ugyeben (kartya #204).
   *
   * Egy MASIK szemely `id`-ja, vagy hianyzik. Peldaul egy kiskoru gyereknel ez
   * az anya `id`-ja: a Beerkezo-elemzo ilyenkor NEM a gyerek sajat mappajat
   * ajanlja celul, hanem a gondviseloet. SZANDEKOSAN nem nev, mert a nev
   * valtozhat -- lasd `id` a sajat mezonel.
   */
  custodianId?: string
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
  /**
   * Optional common parent folder for ALL persons (e.g. "Család" / "Family").
   * Empty or missing = the persons stand at the tree root, as before -- an
   * older saved config therefore keeps its layout unchanged. The owner
   * (2026-09-24): the family members belong under one "Család" folder, not
   * scattered at the root next to Cégek, Tudás, Archív.
   */
  personsGroup?: string
}

/**
 * The relative path of a person's own folder, honouring `personsGroup`.
 * EVERY place that builds a person path must go through this -- if one
 * place still joins the bare name, it looks for the person at the root and
 * silently finds nothing.
 */
export function personRel(cfg: Pick<LifeConfig, 'personsGroup'> | null | undefined, name: string): string {
  const group = personsGroupRel(cfg)
  const base = safeLifeName(name)
  return group ? `${group}/${base}` : base
}

/** The persons' common parent folder ('' = the tree root). */
export function personsGroupRel(cfg: Pick<LifeConfig, 'personsGroup'> | null | undefined): string {
  const raw = String(cfg?.personsGroup ?? '').trim()
  if (!raw) return ''
  const safe = safeLifeName(raw)
  return safe === '_' ? '' : safe
}

/**
 * Az alapertelmezett media-bontas.
 *
 * SZANDEKOSAN altalanos. A specifikacioban nevesitett csoportok
 * (`Ági családja`, `Jutka családja`) egy konkret ember csaladjai -- pont az,
 * amit tilos a kodba irni. A felhasznalo a feluleten atnevezi oket a sajat
 * csaladtagjaira, es a `Child 1 / Child 2` fele gepi nevezektol ez is megvéd
 * (specifikacio 19. pont).
 */
export function defaultMediaGroups(lang: string = APP_LANG): string[] {
  return lang === 'hu'
    ? ['Család', 'Párom', 'Barátok', 'Utazás', 'Otthon', 'Egyéb']
    : ['Family', 'Partner', 'Friends', 'Travel', 'Home', 'Other']
}

/** Egy szemely kategoriai, sorrendben (specifikacio 11. pont). */
export const PERSON_CATEGORIES = [
  'identity', 'personal', 'family', 'finance', 'legal', 'authorities',
  'home', 'vehicles', 'work', 'projects', 'media', 'health', 'digital',
]

/**
 * Az orszagbontas alapertelmezese: MINDEN szemelyi kategoria, KIVEVE a
 * `projects`-et.
 *
 * Miert marad ki a projekt? Mert a specifikacio 31. pontja pontosan rogziti a
 * projekt-utvonalat (`<szemely>/Projektek/<projekt>/Fejlesztés/GIT_REPOS`), es
 * egy koze ekelt orszag-szint ezt elrontana. Egy git-repo amugy sem "magyar"
 * vagy "nemet". Ha valakinek megis kell, a feluleten bekapcsolhatja.
 */
export function defaultCountrySplit(): string[] {
  return ['legal', 'finance', 'authorities']
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
  'legal', 'marketing', 'website', 'development', 'media',
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

/**
 * Nevek, amik egy FRISS telepitesen peldaként allnak a faban.
 *
 * Szandekosan felismerhetoen kitalaltak. Egy „Kovács Béla" nevu minta-szemely
 * ott maradna evekig, mert eleg valodinak latszik ahhoz, hogy senki ne merje
 * kitorolni; a „Példa" elotag viszont maga mondja meg, hogy mi ez.
 */
export const SAMPLE_PERSON = 'Példa Panna'
export const SAMPLE_COMPANY = 'Példa Kft'

/**
 * Az alapertelmezett beallitas: a telepites tulajdonosa, plusz EGY pelda
 * csaladtag es EGY pelda ceg.
 *
 * Boss: „ha valaki letolti a marveen omat, akkor legyen neki egy alap
 * konytarstruktura. kitalalt nevekkel!" Egy ures ag nem magyaraz semmit; aki
 * eloszor nyitja meg, abbol tanul, amit lat.
 */
export function defaultLifeConfig(): LifeConfig {
  return {
    persons: [
      makePerson(safeLifeName(currentOwnerName()), 'owner', 'owner'),
      makePerson(SAMPLE_PERSON, 'person', 'sample-person'),
    ],
    companies: [makeCompany(SAMPLE_COMPANY, 'sample-company')],
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
/**
 * A gondviselo-hivatkozasok (`custodianId`) tisztitasa a HELYBEN kapott
 * `persons` tombon (kartya #204: "gyerek MINDIG az anya alá").
 *
 * Egy hivatkozas csak MASIK, LETEZO szemelyre mutathat, es kort sem alkothat
 * -- kulonben a `resolveFilingPerson()` lanc-kovetese vegtelen ciklusba
 * futna. Egy serult/korbezart hivatkozast csendben eldobunk, nem hibazunk --
 * innentol ez a kozos pont a beallitas mindket belepesi utjahoz
 * (`normalizeLifeConfig()` es a webes `parseConfig()` is ezt hivja).
 */
export function sanitizeCustodianIds(persons: LifePerson[]): void {
  const byId = new Map(persons.map((p) => [p.id, p]))
  for (const p of persons) {
    if (!p.custodianId) { p.custodianId = undefined; continue }
    if (!byId.has(p.custodianId) || p.custodianId === p.id) { p.custodianId = undefined; continue }
    let cur: LifePerson | undefined = byId.get(p.custodianId)
    let hops = 0
    let cyclic = false
    while (cur) {
      if (cur.id === p.id) { cyclic = true; break }
      if (++hops > persons.length) { cyclic = true; break }
      cur = cur.custodianId ? byId.get(cur.custodianId) : undefined
    }
    if (cyclic) p.custodianId = undefined
  }
}

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
        custodianId: p.custodianId ? String(p.custodianId) : undefined,
      } as LifePerson
    })
    : []
  sanitizeCustodianIds(persons)
  const companies: LifeCompany[] = Array.isArray(raw?.companies)
    ? raw.companies.filter((c: any) => c && typeof c.name === 'string' && c.name.trim()).map((c: any) => ({
      id: String(c.id || newLifeId('company')),
      name: safeLifeName(c.name),
      countries: nameList(c.countries),
      countrySplit: keyList(c.countrySplit, COMPANY_CATEGORIES, defaultCompanyCountrySplit()),
    }))
    : []
  // `safeLifeName('')` is '_' (a usable folder name), so the empty case must
  // be caught BEFORE it: empty = no group, not a folder called "_".
  const groupIn = typeof raw?.personsGroup === 'string' ? raw.personsGroup.trim() : ''
  const groupSafe = groupIn ? safeLifeName(groupIn) : ''
  const personsGroup = groupSafe === '_' ? '' : groupSafe
  return { persons, companies, personsGroup }
}

/**
 * Kinek a mappajaba kerul egy iratugy, ha a szemelynek gondviseloje van
 * (kartya #204: "gyerek MINDIG az anya alá").
 *
 * A lancot legfeljebb a szemelyek szamaig kovetjuk: korbezart lanc vagy
 * ismeretlen `personId` eseten az UTOLSO ERVENYES azonositot adja vissza,
 * sose all meg hiba nelkul, es sose talalgat -- ismeretlen `personId`-nal
 * egyszeruen onmagat adja vissza.
 */
export function resolveFilingPerson(personId: string, config: LifeConfig): string {
  const byId = new Map(config.persons.map((p) => [p.id, p]))
  let cur = byId.get(personId)
  if (!cur) return personId
  const seen = new Set<string>([personId])
  let hops = 0
  while (cur.custodianId) {
    if (seen.has(cur.custodianId) || ++hops > config.persons.length) break
    const next = byId.get(cur.custodianId)
    if (!next) break
    seen.add(next.id)
    cur = next
  }
  return cur.id
}

/**
 * Mentett-e mar a felhasznalo sajat beallitast?
 *
 * NEM ugyanaz, mint hogy "van-e szemely a listaban": a `loadLifeConfig()` egy
 * frissen telepitett gepen is ad egy helyorzo gazdat, kulonben az elso
 * "Fa letrehozasa" ures mappat csinalna. Ha a sablonvalaszto EZT nezne,
 * minden uj telepites azt hinne, hogy van mit felulirni -- es a Boss
 * kikotesevel ellentetben figyelmeztetessel fogadna az elso inditas.
 */
export function lifeConfigExists(): boolean {
  return existsSync(CONFIG_PATH)
}

export function loadLifeConfig(): LifeConfig {
  try {
    if (!existsSync(CONFIG_PATH)) return defaultLifeConfig()
    const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
    const { persons, companies, personsGroup } = normalizeLifeConfig(raw)
    // Egy szemely nelkul a fanak nincs erteme: ilyenkor visszaesunk a
    // tulajdonosra, kulonben az elso "Fa letrehozasa" gomb ures mappat csinalna.
    if (!persons.length) return { persons: defaultLifeConfig().persons, companies, personsGroup }
    return { persons, companies, personsGroup }
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
  // The optional common parent ("Család"): one level above the persons.
  const groupDir = personsGroupRel(cfg)
  if (groupDir) add(groupDir, 'top', 'personsGroup')
  for (const p of cfg.persons) {
    const base = personRel(cfg, p.name)
    add(base, 'person', null, p.id)
    for (const key of PERSON_CATEGORIES) {
      const cat = `${base}/${lifeName(key, lang)}`
      add(cat, 'category', key, p.id)

      // Orszagbontas ott, ahol a felhasznalo kerte. Nem fix harmas lista:
      // aki ket-harom orszagban elt, annak a munkaja es az otthona is
      // orszagfuggo.
      //
      // A MEDIA KIVETEL: ott az orszag NEM a kategoria alatt all, hanem a
      // media-tipus alatt (`Média/Fotók/Magyarország`), kulonben a `Média`
      // alatt egyszerre allna `Fotók` es `Magyarország` -- ket kulonbozo
      // rendezoelv egy szinten, amiben senki nem talal semmit.
      if (key !== 'media' && p.countrySplit.includes(key)) {
        for (const c of p.countries) add(`${cat}/${safeLifeName(c)}`, 'country', key, p.id)
      }

      // MEDIA a SZEMELY ALATT (Boss, 2026-08-21: "a media t rakd belulre a
      // korpas laszlo ala"). Korabban onallo felso ag volt -- de a fotoid
      // ugyanugy hozzad tartoznak, mint a jogi ugyeid, es igy egy helyen van
      // minden, ami egy emberhez tartozik. Az orszag- es csoportbontas
      // valtozatlan: tipus / orszag / csaladi csoport.
      if (key === 'media') {
        const mediaCountries = p.countrySplit.includes(MEDIA_COUNTRY_KEY) ? p.countries : []
        for (const m of p.mediaKinds) {
          const sub = `${cat}/${lifeName(m, lang)}`
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
      // A ceg MEDIA-ja is a CEG ALATT all, sajat kategoriakent -- ugyanaz a
      // rendezoelv, mint a szemelyeknel. Korabban a marketing ala volt
      // bujtatva; a Boss faja a FEJLESZTES melle, onallo agkent teszi.
      if (key === 'media') {
        for (const m of ['photos', 'videos']) add(`${cat}/${lifeName(m, lang)}`, 'media', m, c.id)
      }
    }
  }

  // 3. A tobbi felso szintu ag.
  //
  // A MEDIA MAR NINCS ITT: a 2026-08-21-i dontes szerint minden szemely es ceg
  // sajat `Média` kategoriajat kapja (lasd fent). Aki a fotoit keresi, annal a
  // SZEMELYNEL kezdi -- nem egy kulon keptarban, ami mellett a jogi ugyei
  // masutt allnak.
  add(lifeName('knowledge', lang), 'top', 'knowledge')

  // DIGITALIS: NEM masolatgyujto. Csak onallo eletciklusu digitalis dolgok --
  // es jelszo SOHA (specifikacio 21. pont).
  const digitalDir = lifeName('digital', lang)
  add(digitalDir, 'top', 'digital')
  for (const key of DIGITAL_TOP) add(`${digitalDir}/${lifeName(key, lang)}`, 'category', key)

  add(lifeName('inbox', lang), 'top', 'inbox')
  add(lifeName('shared', lang), 'top', 'shared')

  // NO SEPARATE ARCHIVE BRANCH (the owner, 2026-09-24: "nem az a legjobb,
  // hogyha minden a helyén marad? ... Hol keresem, ha keresek valamit?").
  // A closed item stays in its place and is only MARKED archived (grey, at the
  // end of the list) -- see life-archived.ts. An `Archív` folder an older
  // install already has keeps working (name, hint, order), it is just not
  // created any more.

  // 5. RENDSZER: a technikai reteg (specifikacio 4. pont). A felhasznalo NEM
  //    ide jar -- a tarolokat a Beallitasok > Tarolok oldal kezeli. Azert van
  //    megis a fan belul, hogy egy lemezmasolas mindent egyben vigyen.
  const systemDir = lifeName('system', lang)
  add(systemDir, 'system', 'system')
  // A 36. pont szerint a `Rendszer` alatt EGYETLEN ag all, a `Tárolók`. A
  // `Marvin` a 8. alapszabaly szerint szemelyes projekt, a git-repok a 7. pont
  // szerint a szemely/ceg `GIT_REPOS` mappajaban vannak -- egyik sem rendszer-ag.
  add(`${systemDir}/${lifeName('storages', lang)}`, 'system', 'storages')

  return out
}

/**
 * Az az egyetlen szoveg, ami akkor is elmondja a rendszert, ha a Marveen nem fut.
 *
 * A tervezesi alapelv (Boss): "a Marvin legyen intelligens reteg a fajlrendszer
 * folott, ne pedig egy fekete doboz". Ha valakinek ket ev mulva a kezebe kerul
 * ez a lemez, ebbol a fajlbol megerti, mit lat -- program nelkul.
 */
export function lifeReadmeRel(lang: string = APP_LANG): string {
  return lang === 'hu' ? 'OLVASS_EL.md' : 'READ_ME_FIRST.md'
}

/**
 * ELDOBOTT-E A KISEROIRAT?
 *
 * A mappakkal azonos szabaly: amit a felhasznalo kitorolt, azt nem irjuk
 * vissza -- de latnia kell, hogy eltunt, es kernie kell tudnia vissza.
 * Enelkul a kiseroirat aszimmetrikus volt: vegleges torles, ut nelkul.
 */
function readmeAbandoned(root: string, split: PlanSplit, lang: string): boolean {
  const rel = lifeReadmeRel(lang)
  if (!split.trusted || !split.seen.has(rel)) return false
  try { return !existsSync(join(root, rel)) } catch { return false }
}

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
  const firstPath = personRel(cfg, first).split('/').join(' / ')
  lines.push(`  ${firstPath} / ${lifeName('legal', lang)} / ...`)
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
  /** Amit a felhasznalo kitorolt, ezert SZANDEKOSAN nem hoztunk vissza. */
  abandoned: string[]
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
export function ensureLifeTree(
  cfg: LifeConfig = loadLifeConfig(),
  lang: string = APP_LANG,
  msgLang: string = lang,
): EnsureLifeTreeResult {
  // A MAPPANEVET a telepites nyelve donti el (`lang`, mert a nev a lemezen all),
  // az UZENETET viszont a FELULET nyelve (`msgLang`). A ketto kulonbozhet, es
  // amig a route felulirta ezt a szoveget, a kulonbseg nem latszott; most, hogy
  // ez az egyetlen mondat, amit a felhasznalo lat, egy angol feluleten nem
  // mehet ki magyar toast.
  const hu = msgLang !== 'en'
  const root = lifeRoot()
  if (!root) {
    return {
      ok: false, root: null, created: [], existed: 0, failed: [], abandoned: [],
      message: hu
        ? 'Nincs raktár beállítva, ezért nincs hol létrehozni az életfát. '
          + 'Előbb a Raktár oldalon add meg, melyik mappában legyen a Marveen tárhelye.'
        : 'No depot is configured, so there is nowhere to create the life tree. '
          + 'Set the folder for the Marveen storage on the Depot page first.',
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
      ok: false, root, created: [], existed: 0, failed: [], abandoned: [],
      message: hu
        ? `A raktár mappája most nem érhető el: ${root}. `
          + 'Ha külső lemezen van, csatlakoztasd. Amíg nem érhető el, nem hozok létre semmit.'
        : `The depot folder cannot be reached right now: ${root}. `
          + 'If it lives on an external disk, plug it in. Nothing will be created until it is back.',
    }
  }

  const created: string[] = []
  const failed: Array<{ rel: string; error: string }> = []
  const split = splitPlanned(root, planLifeTree(cfg, lang))
  const existed = split.present.length

  // CSAK azt hozzuk letre, ami MEG SOHA nem letezett. Amit a felhasznalo
  // kitorolt (`split.abandoned`), azt bekenhagyjuk -- ez a lenyege.
  for (const rel of split.missing) {
    const full = join(root, ...rel.split('/'))
    try {
      mkdirSync(full, { recursive: true })
      created.push(rel)
    } catch (err: any) {
      failed.push({ rel, error: String(err?.code || err?.message || err) })
    }
  }
  if (created.length) rememberLifeCreated(root, created)

  // A kiseroirat. Csak ha meg nincs -- amit a felhasznalo beleirt, az az ove,
  // es amit KITOROLT, azt sem irjuk vissza (ugyanaz a szabaly, mint a mappaknal).
  const readmeRel = lifeReadmeRel(lang)
  const readme = join(root, readmeRel)
  if (existsSync(readme)) {
    rememberLifeCreated(root, [readmeRel])
  } else if (!(split.trusted && split.seen.has(readmeRel))) {
    try {
      writeFileSync(readme, readmeText(cfg, lang), 'utf8')
      rememberLifeCreated(root, [readmeRel])
    } catch { /* a fa ettol meg all */ }
  }

  // AMIT A FELHASZNALO KITOROLT, AZT KI IS KELL MONDANI.
  //
  // A NULLA KET DOLGOT JELENTHET: a `created === 0` jelentheti azt, hogy a fa
  // tenyleg teljes, ES azt is, hogy szandekosan bekenhagytunk N eldobott
  // mappat. A ketto kozott a felhasznalo nem tud kulonbseget tenni, ha
  // ugyanazt az uzenetet latja -- ezert mondjuk meg kulon.
  const abandoned = [...split.abandoned]
  if (readmeAbandoned(root, split, lang)) abandoned.push(readmeRel)
  const n = abandoned.length
  const elhagyott = n
    ? (hu
      ? ` ${n} elemet szándékosan nem hoztam vissza, mert korábban kitörölted `
        + '-- ha mégis kellenek, az Intéző "Visszahozom ezeket" gombjával kérheted vissza őket.'
      : ` ${n} item${n === 1 ? '' : 's'} were deliberately left out because you deleted them earlier `
        + '-- if you need them after all, use the "Bring these back" button in the Explorer.')
    : ''
  const message = (failed.length
    ? (hu
      ? `Az életfa elkészült, de ${failed.length} mappát nem sikerült létrehozni. Nézd meg a mappa jogosultságait.`
      : `The life tree is ready, but ${failed.length} folder${failed.length === 1 ? '' : 's'} could not be created. Check the folder permissions.`)
    : created.length
      ? (hu
        ? `Kész: ${created.length} új mappa készült el az életfában.`
        : `Done: ${created.length} new folder${created.length === 1 ? '' : 's'} created in the life tree.`)
      : n
        ? (hu ? 'Nem kellett új mappát létrehozni.' : 'No new folder had to be created.')
        : (hu
          ? 'Az életfa már teljes, nem kellett újat létrehozni.'
          : 'The life tree is already complete, nothing new had to be created.')) + elhagyott

  logger.info(
    { created: created.length, existed, failed: failed.length, abandoned: split.abandoned.length },
    '[eletfa] vazszerkezet ellenorizve',
  )
  return { ok: failed.length === 0, root, created, existed, failed, abandoned, message }
}

/**
 * A tervezett mappak harom halmaza: MEGVAN / HIANYZIK / ELHAGYOTT.
 *
 * A harmadik halmaz a lenyeg. A lemezen a "nincs ott" ket, egymassal
 * ellentetes dolgot jelent, es a kettot a naplo (`life-tree-ledger.ts`)
 * valasztja szet: amit mar lattunk egyszer es most nincs, azt a felhasznalo
 * torolte ki -- azt nem hozzuk vissza, es nem is jelezzuk hibanak.
 *
 * A NULLA KET DOLGOT JELENTHET (CLAUDE.md). Ha a gyoker all, de EGYETLEN
 * tervezett mappat sem latunk, az nem az, hogy a felhasznalo az egesz fat
 * kitorolte: sokkal inkabb egy ures vagy kicserelt lemez ugyanazon az
 * utvonalon, egy felig felcsatolt halozati mappa, vagy egy megszakadt WSL-
 * atjaro. Ilyenkor a naplonak NEM hiszunk: marad a regi, ovatos olvasat
 * ("hianyzik, letrehozhato"), mert egy csendes "nem hozok vissza semmit"
 * ott sokkal karosabb, mint egy felajanlott letrehozas.
 */
interface PlanSplit {
  present: string[]
  missing: string[]
  abandoned: string[]
  /** Hihetunk-e most a naplonak? */
  trusted: boolean
  seen: Set<string>
}

function splitPlanned(root: string, plan: LifeNode[]): PlanSplit {
  const seen = lifeLedgerSeen(root)
  const present: string[] = []
  const gone: string[] = []
  for (const n of plan) {
    let ok = false
    try { ok = existsSync(join(root, ...n.rel.split('/'))) } catch { ok = false }
    if (ok) present.push(n.rel)
    else gone.push(n.rel)
  }
  const trusted = present.length > 0 && seen.size > 0
  // Amit MOST lattunk, azt a naplo is lassa: igy egy mar allo fan (frissites
  // utan, ahol meg nincs naplo) is mukodik a kesobbi torles felismerese --
  // telepitoi lepes es migracio nelkul.
  if (present.length) rememberLifeCreated(root, present)
  return {
    present,
    missing: trusted ? gone.filter((r) => !seen.has(r)) : gone,
    abandoned: trusted ? gone.filter((r) => seen.has(r)) : [],
    trusted,
    seen,
  }
}

export interface RestoreLifeFoldersResult {
  ok: boolean
  root: string | null
  /** Amit most visszahoztunk. */
  created: string[]
  failed: Array<{ rel: string; error: string }>
  /** Ami nincs a tervben -- nem hozunk letre akarmit egy kulso keresre. */
  unknown: string[]
  message: string
}

/**
 * A felhasznalo VISSZAKER egy eldobott mappat.
 *
 * Ez a masik fele a szabalynak: ha a torles vegleges, akkor kell egy ut
 * visszafele is, kulonben a felhasznalo egy elutessel veglegesen elveszitene a
 * sablon egy agat. A listat a terv adja (`planLifeTree`), tehat ez a fuggveny
 * nem valik "hozz letre barmilyen mappat" kapuva.
 *
 * Ures lista = az OSSZES eldobott mappa vissza.
 */
export function restoreLifeFolders(
  rels: string[] = [],
  cfg: LifeConfig = loadLifeConfig(),
  lang: string = APP_LANG,
  msgLang: string = lang,
): RestoreLifeFoldersResult {
  // `lang` = a mappanev nyelve a lemezen, `msgLang` = a valasz nyelve.
  const hu = msgLang !== 'en'
  const root = lifeRoot()
  if (!root) {
    return {
      ok: false, root: null, created: [], failed: [], unknown: [],
      message: hu
        ? 'Nincs raktár beállítva, ezért nincs hol visszahozni a mappákat.'
        : 'No depot is configured, so there is nowhere to restore the folders.',
    }
  }
  let rootOk = false
  try { rootOk = existsSync(root) && statSync(root).isDirectory() } catch { rootOk = false }
  if (!rootOk) {
    return {
      ok: false, root, created: [], failed: [], unknown: [],
      message: hu
        ? `A raktár mappája most nem érhető el: ${root}. Amíg nem érhető el, nem hozok létre semmit.`
        : `The depot folder cannot be reached right now: ${root}. Nothing will be created until it is back.`,
    }
  }
  const plan = planLifeTree(cfg, lang)
  // A kiseroirat ugyanugy visszakerheto, mint egy mappa: a torlese vegleges,
  // tehat kell hozza ut visszafele is (kulonben aszimmetrikus a szabaly).
  const readmeRel = lifeReadmeRel(lang)
  const planned = new Set([...plan.map((n) => n.rel), readmeRel])
  const split = splitPlanned(root, plan)
  const alap = [...split.abandoned]
  if (readmeAbandoned(root, split, lang)) alap.push(readmeRel)
  const kert = rels.length ? rels : alap
  const unknown = kert.filter((r) => !planned.has(r))
  const created: string[] = []
  const failed: Array<{ rel: string; error: string }> = []
  for (const rel of kert) {
    if (!planned.has(rel)) continue
    const full = join(root, ...rel.split('/'))
    if (existsSync(full)) continue
    try {
      if (rel === readmeRel) writeFileSync(full, readmeText(cfg, lang), 'utf8')
      else mkdirSync(full, { recursive: true })
      created.push(rel)
    } catch (err: any) {
      failed.push({ rel, error: String(err?.code || err?.message || err) })
    }
  }
  if (created.length) rememberLifeCreated(root, created)
  const message = failed.length
    ? (hu
      ? `${created.length} elem visszakerült, ${failed.length} nem. Nézd meg a mappa jogosultságait.`
      : `${created.length} items are back, ${failed.length} failed. Check the folder permissions.`)
    : created.length
      ? (hu ? `Kész: ${created.length} elem visszakerült a fába.` : `Done: ${created.length} items are back in the tree.`)
      : (hu ? 'Nem volt mit visszahozni.' : 'There was nothing to restore.')
  logger.info({ created: created.length, failed: failed.length, unknown: unknown.length }, '[eletfa] eldobott mappak visszahozva')
  return { ok: failed.length === 0, root, created, failed, unknown, message }
}

/**
 * Mar all-e a fa a lemezen?
 *
 * Nem "letezik-e a gyoker": azt kerdezzuk, HANY tervezett mappa van meg. Egy
 * felig kesz fa (megszakadt letrehozas, kozben lecsatolt lemez) igy nem
 * latszik keszen -- a felulet meg tudja mondani, hogy hianyzik belole valami.
 */
export function lifeTreeStatus(cfg: LifeConfig = loadLifeConfig(), lang: string = APP_LANG): {
  root: string | null; exists: boolean; planned: number; present: number; missing: string[]; abandoned: string[]
} {
  const root = lifeRoot()
  const plan = planLifeTree(cfg, lang)
  const semmi = { planned: plan.length, present: 0, missing: plan.map((n) => n.rel), abandoned: [] as string[] }
  if (!root) return { root: null, exists: false, ...semmi }
  let exists = false
  try { exists = existsSync(root) && statSync(root).isDirectory() } catch { exists = false }
  if (!exists) return { root, exists: false, ...semmi }
  // A HIANYZO es az ELHAGYOTT ket kulon halmaz: az elso hibajelzes (meg nincs
  // meg, letrehozhato), a masodik a felhasznalo dontese (ne jelezzuk hibanak).
  const split = splitPlanned(root, plan)
  // A kiseroirat is bekerul a naploba, amig all: kulonben az elso torlese utan
  // az `ensure` meg egyszer visszairna (a naplo nem tudna, hogy letezett).
  const readmeRel = lifeReadmeRel(lang)
  try { if (existsSync(join(root, readmeRel))) rememberLifeCreated(root, [readmeRel]) } catch { /* nem baj */ }
  const abandoned = [...split.abandoned]
  if (readmeAbandoned(root, split, lang)) abandoned.push(readmeRel)
  return {
    root,
    exists: true,
    planned: plan.length,
    present: split.present.length,
    missing: split.missing,
    abandoned,
  }
}

/**
 * A BEÉRKEZŐ mappa teljes utvonala, vagy null, ha nincs depo.
 *
 * The folder NAME on disk always follows the install language (APP_LANG), the
 * same one `planLifeTree()` created it with -- never the UI language. The
 * `lang` argument is accepted for the callers' convenience and deliberately
 * ignored here: with it, an English UI on a Hungarian install looked for a
 * non-existent "INBOX" folder and told the user to create the tree (found
 * while fixing card #327).
 */
export function inboxDir(_lang: string = APP_LANG): string | null {
  const root = lifeRoot()
  return root ? join(root, lifeName('inbox', APP_LANG)) : null
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
