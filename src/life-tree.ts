// AZ ELETFA: egyetlen, ember altal olvashato mappaszerkezet, amiben a
// felhasznalo az egesz digitalis (es papir-) eletet kezeli.
//
// Boss, 2026-08-21: "a mappafa emberi es stabil; a hatterben Marvin kezeli az
// adattarakat; a felhasznalo pedig mindig latja, honnan jon az adat es hol van
// fizikailag."
//
// Harom dolgot kell egyszerre tudnia, es ezek hatarozzak meg az egesz modul
// felepiteset:
//
//  1. MARVIN NELKUL IS MUKODJON. Ha a Marveen soha tobbet nem indul el, a
//     felhasznalo a Fajlkezeloben ugyanugy megtalalja a papirjait:
//     `ELET / <sajat nev> / JOGI / NEMETORSZAG / BIROSAG`. Ezert nincs benne
//     azonosito, hash, adatbazis-kulcs vagy barmilyen gepi nev: a MAPPANEV maga
//     a jelentes. A `.marveen-eletfa.json` csak kiseroirat -- ha letorlod, a fa
//     attol meg all.
//
//  2. NE LEGYEN BENNE EGYETLEN KONKRET SZEMELY- VAGY CEGNEV SEM (CLAUDE.md:
//     "GEPFUGGETLEN FEJLESZTES"). A Marveen nyilt forraskodu; ami ide fixen be
//     van irva, az mindenki mas gepen rossz. Ezert a fa VAZAT a kod adja
//     (kategoriak), a NEVEKET pedig a felhasznalo (`store/life-tree.json`), es
//     az elso szemely neve is csak a telepites sajat `OWNER_NAME`-jebol jon.
//
//  3. AZ ORSZAG NEM ELETKATEGORIA. A tervben ez kulon ki van mondva: nem a fa
//     tetejen all, hanem annak a teruletnek a TULAJDONSAGA, ahol szamit
//     (`JOGI/NEMETORSZAG`, `PENZUGY/MAGYARORSZAG`). Ezert csak harom kategoria
//     alatt jelenik meg, es csak akkor, ha a felhasznalo vett fel orszagot.
//
// Amit ez a modul NEM csinal: nem torol, nem nevez at, es nem ir felul semmit.
// Csak HIANYZO mappat hoz letre. Egy mar meglevo fan igy tobbszor is
// vegigfuthat kar nelkul, es a felhasznalo sajat, kezzel keszitett mappai
// erintetlenul allnak.
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
 * ami a lemezre kerul. Igy egy angol telepitesen `LIFE/LEGAL` lesz ugyanaz a
 * hely, amit egy magyaron `ELET/JOGI`-nak hivnak, es a kod egyik nevet sem
 * ismeri fixen.
 */
type NameTable = Record<string, { hu: string; en: string }>

const NAMES: NameTable = {
  // Gyoker es felso szint
  root:        { hu: 'ÉLET',        en: 'LIFE' },
  companies:   { hu: 'CÉGEK',       en: 'COMPANIES' },
  knowledge:   { hu: 'TUDÁS',       en: 'KNOWLEDGE' },
  media:       { hu: 'MÉDIA',       en: 'MEDIA' },
  digital:     { hu: 'DIGITÁLIS',   en: 'DIGITAL' },
  inbox:       { hu: 'BEÉRKEZŐ',    en: 'INBOX' },
  shared:      { hu: 'MEGOSZTOTT',  en: 'SHARED' },
  archive:     { hu: 'ARCHÍV',      en: 'ARCHIVE' },

  // Szemely alatti kategoriak
  personal:    { hu: 'SZEMÉLYES',   en: 'PERSONAL' },
  identity:    { hu: 'IDENTITÁS',   en: 'IDENTITY' },
  family:      { hu: 'CSALÁD',      en: 'FAMILY' },
  finance:     { hu: 'PÉNZÜGY',     en: 'FINANCE' },
  legal:       { hu: 'JOGI',        en: 'LEGAL' },
  authorities: { hu: 'HATÓSÁGOK',   en: 'AUTHORITIES' },
  home:        { hu: 'OTTHON',      en: 'HOME' },
  work:        { hu: 'MUNKA',       en: 'WORK' },
  projects:    { hu: 'PROJEKTEK',   en: 'PROJECTS' },
  health:      { hu: 'EGÉSZSÉG',    en: 'HEALTH' },
  documents:   { hu: 'DOKUMENTUMOK', en: 'DOCUMENTS' },

  // Ceg alatti kategoriak
  companyAffairs: { hu: 'CÉGES ÜGYEK', en: 'COMPANY AFFAIRS' },
  correspondence: { hu: 'LEVELEZÉS',   en: 'CORRESPONDENCE' },
  knowledgeBase:  { hu: 'TUDÁSBÁZIS',  en: 'KNOWLEDGE BASE' },
  website:        { hu: 'WEBOLDAL',    en: 'WEBSITE' },
  development:    { hu: 'FEJLESZTÉS',  en: 'DEVELOPMENT' },
  marketing:      { hu: 'MARKETING',   en: 'MARKETING' },
  // Ez a ketto SZANDEKOSAN nem forditodik: a `GIT_REPOS` alatt git-repok
  // allnak, a nevuket a GitHub adja, es a fejlesztonek ugyanugy kell
  // kineznie minden gepen.
  gitRepos:       { hu: 'GIT_REPOS',   en: 'GIT_REPOS' },

  // Media alatti bontas
  photos:      { hu: 'FOTÓK',       en: 'PHOTOS' },
  videos:      { hu: 'VIDEÓK',      en: 'VIDEOS' },
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
 * Egy szemely szerepe. Ez donti el, MELY kategoriak keszulnek el neki.
 *
 * Nem "fo" es "masodlagos" ember: egy hozzatartozo iratait ugyanolyan
 * komolyan kezeljuk. A kulonbseg gyakorlati -- egy csaladtagnal jellemzoen
 * nincs sajat MUNKA/PROJEKTEK/EGESZSEG ag, es az ures mappa csak zaj. Aki
 * megis akarja, atallitja `owner`-re a felületen.
 */
export type PersonRole = 'owner' | 'person'

export interface LifePerson {
  /** Gepi azonosito (a mappanev valtoztatasat is tulelo hivatkozas). */
  id: string
  /** Ahogy a felhasznalo hivja -- EZ lesz a mappa neve is. */
  name: string
  role: PersonRole
  /**
   * Orszagok a JOGI / PENZUGY / HATOSAGOK ala. Uresen hagyva NEM keszul
   * orszag-szint: akinek egy orszaga van, annak felesleges egy plusz kattintas.
   */
  countries: string[]
  /** A FOTOK es VIDEOK alatti bontas (`CSALÁD`, `UTAZÁS`, ...). */
  mediaGroups: string[]
}

export interface LifeCompany {
  id: string
  name: string
}

export interface LifeConfig {
  persons: LifePerson[]
  companies: LifeCompany[]
}

/**
 * Az alapertelmezett media-bontas.
 *
 * SZANDEKOSAN altalanos. A tervben nevesitett csoportok (`ÁGI CSALÁDJA`,
 * `JUTKA CSALÁDJA`) egy konkret ember csaladjai -- pont az, amit tilos a kodba
 * irni. A felhasznalo a felületen atnevezi oket a sajat csaladtagjaira, es a
 * `Child 1 / Child 2` fele gepi nevezektol ez is megvéd.
 */
export function defaultMediaGroups(lang: string = APP_LANG): string[] {
  return lang === 'hu'
    ? ['CSALÁD', 'PÁROM', 'BARÁTOK', 'UTAZÁS', 'OTTHON', 'EGYÉB']
    : ['FAMILY', 'PARTNER', 'FRIENDS', 'TRAVEL', 'HOME', 'OTHER']
}

/** Amelyik kategoria alatt ertelme van az orszag-szintnek. */
const COUNTRY_SPLIT = ['legal', 'finance', 'authorities']

/** Egy `owner` szerepu szemely kategoriai, sorrendben. */
const OWNER_CATEGORIES = [
  'personal', 'identity', 'family', 'finance', 'legal', 'authorities',
  'home', 'work', 'projects', 'health', 'documents', 'media',
]

/** Egy `person` szerepu szemely kategoriai (nincs munka/projekt/egeszseg ag). */
const PERSON_CATEGORIES = [
  'personal', 'identity', 'family', 'finance', 'legal', 'authorities',
  'home', 'documents', 'media',
]

/** Egy ceg kategoriai, sorrendben. */
const COMPANY_CATEGORIES = [
  'companyAffairs', 'correspondence', 'knowledgeBase', 'website',
  'development', 'projects', 'finance', 'legal', 'marketing',
]

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
 * A depoN BELUL van, nem mellette: a depo mar most is az a hely, ahol "minden
 * hozzad tartozo fajl" all, es ket parhuzamos gyoker csak azt a kerdest szulne,
 * hogy melyikbe is kell menteni.
 */
export function lifeRoot(): string | null {
  const depot = depotRoot()
  return depot ? join(depot, lifeName('root')) : null
}

/** Az alapertelmezett beallitas: EGY szemely, a telepites tulajdonosa. */
export function defaultLifeConfig(): LifeConfig {
  const owner = currentOwnerName()
  return {
    persons: [{
      id: 'owner',
      name: safeLifeName(owner),
      role: 'owner',
      countries: [],
      mediaGroups: defaultMediaGroups(),
    }],
    companies: [],
  }
}

/**
 * A beallitas beolvasasa. Serult vagy hianyzo fajlnal az alapertelmezes jon --
 * a lemezen levo fa ettol meg all, csak a Marveen nem tudja rola, mi micsoda.
 */
export function loadLifeConfig(): LifeConfig {
  try {
    if (!existsSync(CONFIG_PATH)) return defaultLifeConfig()
    const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
    const persons: LifePerson[] = Array.isArray(raw.persons)
      ? raw.persons.filter((p: any) => p && typeof p.name === 'string' && p.name.trim()).map((p: any) => ({
        id: String(p.id || newLifeId('person')),
        name: safeLifeName(p.name),
        role: p.role === 'owner' ? 'owner' : 'person',
        countries: Array.isArray(p.countries) ? p.countries.map(safeLifeName).filter(Boolean) : [],
        mediaGroups: Array.isArray(p.mediaGroups) && p.mediaGroups.length
          ? p.mediaGroups.map(safeLifeName).filter(Boolean)
          : defaultMediaGroups(),
      }))
      : []
    const companies: LifeCompany[] = Array.isArray(raw.companies)
      ? raw.companies.filter((c: any) => c && typeof c.name === 'string' && c.name.trim()).map((c: any) => ({
        id: String(c.id || newLifeId('company')),
        name: safeLifeName(c.name),
      }))
      : []
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
  kind: 'person' | 'company' | 'category' | 'country' | 'media' | 'top'
}

/**
 * A TELJES tervezett fa, kiszamolva a beallitasbol -- a lemez erintese nelkul.
 *
 * Kulon fuggveny, mert harom helyen kell ugyanaz: (1) a letrehozasnak, (2) a
 * felulet elonezetenek ("ez fog elkeszulni"), es (3) a fizikai irattar
 * helyvalasztojanak. Ha barmelyik kulon szamolna, elobb-utobb elternenek, es a
 * felhasznalo mas fat latna, mint amit kap.
 */
export function planLifeTree(cfg: LifeConfig = loadLifeConfig(), lang: string = APP_LANG): LifeNode[] {
  const out: LifeNode[] = []
  const add = (rel: string, kind: LifeNode['kind'], key: string | null = null, ownerId: string | null = null) => {
    out.push({ rel, key, ownerId, kind })
  }

  // 1. Szemelyek. A nevuk a felso szinten all, nem egy `SZEMELYEK` gyujto
  //    alatt: a tervben is igy van, es egy kattintassal kevesebb.
  for (const p of cfg.persons) {
    const base = safeLifeName(p.name)
    add(base, 'person', null, p.id)
    const cats = p.role === 'owner' ? OWNER_CATEGORIES : PERSON_CATEGORIES
    for (const key of cats) {
      const cat = `${base}/${lifeName(key, lang)}`
      add(cat, 'category', key, p.id)
      // Orszag CSAK ott, ahol szamit, es csak ha van felveve.
      if (COUNTRY_SPLIT.includes(key)) {
        for (const c of p.countries) add(`${cat}/${safeLifeName(c)}`, 'country', key, p.id)
      }
      // A szemely sajat MEDIA aga a szemely alatt is megjelenik: ide a
      // szemelyhez KOTODO kepek kerulnek. A felso szintu MEDIA (lentebb) a
      // nagy, szinkronizalt keptar -- ket kulon dolog, ezert ket kulon hely.
      if (key === 'media') {
        for (const m of ['photos', 'videos']) {
          add(`${cat}/${lifeName(m, lang)}`, 'media', m, p.id)
        }
      }
    }
  }

  // 2. Cegek.
  const companiesDir = lifeName('companies', lang)
  add(companiesDir, 'top', 'companies')
  for (const c of cfg.companies) {
    const base = `${companiesDir}/${safeLifeName(c.name)}`
    add(base, 'company', null, c.id)
    for (const key of COMPANY_CATEGORIES) {
      const cat = `${base}/${lifeName(key, lang)}`
      add(cat, 'category', key, c.id)
      // A fejlesztes ala megy a tudasbazis es a repok helye. A Marveen a
      // repok SAJAT dokumentacios retegehez nem nyul -- csak a helyet adja.
      if (key === 'development') {
        add(`${cat}/${lifeName('knowledgeBase', lang)}`, 'category', 'knowledgeBase', c.id)
        add(`${cat}/${lifeName('gitRepos', lang)}`, 'category', 'gitRepos', c.id)
      }
      // Keves ceges kep van: nem kap sajat Drive-ot, a marketing ala kerul.
      if (key === 'marketing') {
        const media = `${cat}/${lifeName('media', lang)}`
        add(media, 'category', 'media', c.id)
        for (const m of ['photos', 'videos']) add(`${media}/${lifeName(m, lang)}`, 'media', m, c.id)
      }
    }
  }

  // 3. A nagy keptar: szemelyenkent es a cegeknek, FOTOK/VIDEOK bontasban.
  const mediaDir = lifeName('media', lang)
  add(mediaDir, 'top', 'media')
  for (const p of cfg.persons) {
    const base = `${mediaDir}/${safeLifeName(p.name)}`
    add(base, 'person', null, p.id)
    for (const m of ['photos', 'videos']) {
      const sub = `${base}/${lifeName(m, lang)}`
      add(sub, 'media', m, p.id)
      for (const g of p.mediaGroups) add(`${sub}/${safeLifeName(g)}`, 'media', m, p.id)
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
  for (const key of ['knowledge', 'digital', 'inbox', 'shared', 'archive']) {
    add(lifeName(key, lang), 'top', key)
  }

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
  lines.push(nl('# ÉLET -- mi ez a mappa?', '# LIFE -- what is this folder?'))
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
    '  <személy vagy cég> / <terület> / <ország, ha számít> / <ügy>',
    '  <person or company> / <area> / <country, where it matters> / <case>',
  ))
  lines.push('')
  lines.push(nl(
    'Az ország nem külön életkategória, hanem egy ügy tulajdonsága: ezért csak a',
    'A country is not a life category of its own but a property of a case, so it',
  ))
  lines.push(nl(
    'JOGI, PÉNZÜGY és HATÓSÁGOK alatt jelenik meg.',
    'only appears under LEGAL, FINANCE and AUTHORITIES.',
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
  // A SZULOnek (a depo gyokerenek) mar allnia kell. Enelkul egy lecsatolt
  // lemeznel a `recursive: true` a semmibe huzna fel az egesz fat -- ez a depo
  // modulban egyszer mar mert hibamod volt (elszallt WSL-atjaro), es itt
  // ugyanugy fenyeget.
  const depot = depotRoot()!
  let depotOk = false
  try { depotOk = existsSync(depot) && statSync(depot).isDirectory() } catch { depotOk = false }
  if (!depotOk) {
    return {
      ok: false, root, created: [], existed: 0, failed: [],
      message: `A depó mappája most nem érhető el: ${depot}. `
        + 'Ha külső lemezen van, csatlakoztasd. Amíg nem érhető el, nem hozok létre semmit.',
    }
  }

  const created: string[] = []
  const failed: Array<{ rel: string; error: string }> = []
  let existed = 0

  try {
    mkdirSync(root, { recursive: true })
  } catch (err: any) {
    return {
      ok: false, root, created: [], existed: 0,
      failed: [{ rel: '', error: String(err?.message || err) }],
      message: `Nem tudom létrehozni az életfa gyökerét: ${root}`,
    }
  }

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
