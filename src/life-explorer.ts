// A Marvin INTEZO motorja: mappalistazas, athelyezes, informacios panel.
//
// Boss, 2026-08-21: "A Marvinban legyen egy Windows Intezohoz hasonlo
// fajlkezelo. [...] es ugyanugy lehet megnyitni, bezarni, mappaba belepni,
// fajlt megnyitni, athelyezni, keresni, rendezni."
//
// Ket dolog van, amit ez a modul komolyabban vesz, mint egy szokasos
// fajllistazo:
//
//  1. A GYOKERBOL NEM LEHET KILEPNI. Minden bejovo utvonalat feloldunk
//     (`realpath`), es utana ellenorizzuk, hogy a depon BELUL maradt-e. Nem a
//     `..`-ra szurunk (azt meg lehet kerulni), hanem a VEGEREDMENYT nezzuk:
//     ez az egyetlen ellenorzes, ami a jelkapcsolatokra (symlink) is all. Egy
//     bongeszobol elerheto vegpont kulonben az egesz gepet kiolvashatova
//     tenne.
//
//  2. AZ ATHELYEZES NEM IR FELUL SEMMIT. Ha a celban mar all ugyanolyan nevu
//     fajl, MEGALLUNK, es kimondjuk. Egy csendben felulirt bizonyitvany vagy
//     birosagi vegzes visszaallithatatlan -- egy hibauzenet nem az.
import {
  existsSync, mkdirSync, readdirSync, realpathSync, renameSync, statSync,
  copyFileSync, rmSync, type Stats,
} from 'node:fs'
import { join, dirname, basename, resolve, sep } from 'node:path'
import { APP_LANG } from './config.js'
import { depotRoot, DEPOT_PROJECTS } from './depot.js'
import { toDisplayPath } from './depot-browse.js'
import { detectSource, type SourceInfo } from './life-sources.js'
import { getPhysical, movePhysical, forgetPhysical, type PhysicalRecord } from './life-documents.js'
import {
  lifeName, lifeKeyForName, loadLifeConfig, safeLifeName,
  SAMPLE_PERSON, SAMPLE_COMPANY, type LifeConfig,
} from './life-tree.js'
import { resolveMount, unresolveMount, mountsInside } from './life-mounts.js'
import { logger } from './logger.js'
import { lifeHint, PERSON_HINT, COMPANY_HINT, SAMPLE_PERSON_HINT, SAMPLE_COMPANY_HINT,
  DEV_KNOWLEDGE_HINT, DEV_MORE_HINT, PROJECT_HINT } from './life-hints.js'

/**
 * Az Intezo gyokere: maga a DEPO, nem az eletfa.
 *
 * Miert? Mert az eletfa a felhasznalo rendezett vilaga, de a Drive- es
 * Fotok-mappak (`drive/`, `fotok/`) a depo alatt allnak, MELLETTE. Ha az
 * Intezo csak az eletfat mutatna, a felhasznalonak ket kulon fajlkezeloje
 * lenne ugyanarra a gepre -- pont az ellenkezoje annak, amit a terv "egyseges
 * eletfanak" hiv. Igy egy fa van, es az ELET a legelso benne.
 */
export function explorerRoot(): string | null {
  return depotRoot()
}

/**
 * A felso szintu mappak sorrendje: ami emberi, az elol.
 *
 * A specifikacio 3. pontja ota NINCS `ELET` gyujtomappa -- a szemelyek
 * KOZVETLENUL a gyokerben allnak. Ezert a sorrend ket reszbol all:
 *
 *  1. A felvett SZEMELYEK, a beallitasban szereplo sorrendjukben. Ok nincsenek
 *     ebben a listaban, mert a nevuk gepenkent mas (29-30. pont); a `rank()`
 *     szedi ki oket a beallitasbol.
 *  2. Utana ez a rogzitett lista: eloszor a kozos agak, majd a tarolok,
 *     legvegul a `Rendszer` -- amihez a felhasznalonak soha nem kell nyulnia.
 *
 * A `DEPOT_PROJECTS`/`WORK`/`BACKUPS` SZANDEKOSAN nincs itt: azok mar a
 * `Rendszer` ALATT vannak, tehat nem felso szintu nevek.
 */
function topOrder(lang: string): string[] {
  return [
    lifeName('companies', lang),
    lifeName('knowledge', lang),
    lifeName('digital', lang),
    lifeName('inbox', lang),
    lifeName('shared', lang),
    // A ket elo tarolo. A Boss kifejezett kerese, hogy ezek a helyukon
    // maradjanak (2026-08-21): "az jol sikerult es atlathato".
    lifeName('archive', lang),
    // Amihez soha nem kell hozzanyulni. Ez az utolso.
    lifeName('system', lang),
  ]
}

export interface LifeEntry {
  name: string
  /** Utvonal a gyokertol, per-jellel. Ezt kuldi vissza a felulet. */
  rel: string
  isDir: boolean
  size: number
  sizeHuman: string
  /** Modositas ideje ISO-ban, vagy ures, ha nem tudtuk megallapitani. */
  mtime: string
  source: { kind: string; label: string; short: string; icon: string }
  /**
   * Egy mondatnyi sugo: mit szoktak ebbe a mappaba tenni.
   *
   * Csak a kepernyore valo -- a mappa NEVE a lemezen valtozatlan marad.
   * Atnevezessel eltorne minden ut, bekotes es hivatkozas; egy magyarazo
   * szoveg sosem er annyit, hogy adatot kockaztasson erte.
   */
  hint?: string
  /** Van-e a fajlnak papir parja. A lista is mutatja, nem csak a panel. */
  physical: boolean
  /**
   * Ha ez a mappa egy BEKOTES, itt all az emberi felirata ("lackor2 Google
   * Fotok"). Ures egyebkent. A felulet ebbol tudja, hogy amit megnyitsz, az
   * valojaban mashol lakik.
   */
  mounted?: string
  /**
   * Ranezesre lathato figyelmeztetes: ebbe a mappaba jobb nem belenyulni.
   *
   * Boss, 2026-08-21: "a git repos mappa ikonjai legyenek pirosak ... nem azt
   * kerem hogy tiltsd le. hanem csak figyelem felkeltes! az egy fontos mappa.
   * jobb nem piszkalni". Ez tehat NEM tiltas -- minden muvelet mukodik
   * tovabbra is --, csak jelzes. Egy git-repoban a kezzel athuzott fajl
   * csendben elrontja a verziokovetest; ott a `git` a gazda, nem az Intezo.
   *
   * Ures, ha nincs mire figyelmeztetni.
   */
  caution?: string
}

export interface LifeListing {
  rel: string
  /** Emberi utvonal a cimsorba (`F:\Marveen\Kovács Anna\...`). */
  display: string
  /** Kattinthato morzsak: [{ name, rel }], a gyokerrel kezdve. */
  breadcrumb: Array<{ name: string; rel: string }>
  /** A szulomappa relativ utvonala, vagy null a gyokerben. */
  parent: string | null
  folders: LifeEntry[]
  files: LifeEntry[]
  /** Igaz, ha a mappa tulzsufolt volt, es levagtuk a listat. */
  truncated: boolean
  /** Emberi mondat, ha valami nem sikerult. Nem hiba: uzenet a feluletnek. */
  message: string | null
}

/** Hany tetelt adunk vissza egy mappabol. Efolott a felulet is hasznalhatatlan. */
const MAX_ENTRIES = 2000

/**
 * Relativ utvonal -> abszolut, a gyokerbol KILEPNI NEM LEHET.
 *
 * `null`, ha az utvonal a gyokeren kivulre mutat, vagy nincs depo. Ez a modul
 * EGYETLEN biztonsagi hatara: minden mas fuggveny ezen keresztul jut
 * utvonalhoz, es amelyik nem, az hiba.
 *
 * A `realpathSync` szandekosan a MEGLEVO leghosszabb elozmenyre fut: egy meg
 * nem letezo celnal (uj mappa, athelyezes cel-neve) is tudni akarjuk, hogy a
 * SZULOJE a fan belul van-e.
 */
export function resolveLifePath(rel: string): string | null {
  const root = explorerRoot()
  if (!root) return null
  let realRoot: string
  try { realRoot = realpathSync(root) } catch { return null }

  const asked = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '')
  // BEKOTES: amit a felhasznalo lat, es amit a lemez tud, nem ugyanaz.
  // Eloszor leforditjuk a fa-beli utvonalat valodi helyre (a szemely
  // MEDIA/FOTOK aga mogott peldaul a fotok/<fiok> mappa all), es csak
  // UTANA jon a kilepes-ellenorzes -- vagyis egy bekotes sem tud
  // kivezetni a fabol.
  const mounted = resolveMount(asked)
  const clean = mounted ? mounted.target : asked
  const target = resolve(realRoot, clean)

  // A meglevo elozmeny feloldasa: igy egy jelkapcsolaton at kifele mutato
  // utvonal is lebukik, nem csak a `..`.
  let probe = target
  const tail: string[] = []
  for (let i = 0; i < 64 && !existsSync(probe); i++) {
    tail.unshift(basename(probe))
    const up = dirname(probe)
    if (up === probe) break
    probe = up
  }
  let realProbe: string
  try { realProbe = realpathSync(probe) } catch { return null }
  const full = tail.length ? join(realProbe, ...tail) : realProbe

  if (full !== realRoot && !full.startsWith(realRoot + sep)) return null
  return full
}

/** Abszolut -> relativ. Uresen adja vissza a gyokeret. */
export function toLifeRel(abs: string): string {
  const root = explorerRoot()
  if (!root) return ''
  let realRoot = root
  try { realRoot = realpathSync(root) } catch { /* marad a beallitott */ }
  if (abs === realRoot) return ''
  const raw = abs.startsWith(realRoot + sep) ? abs.slice(realRoot.length + 1).split(sep).join('/') : ''
  // Ha ez a hely egy bekotesen at latszik, a felhasznalo a FA szerinti
  // utvonalat varja vissza (nem azt, hogy `drive/<fiok>/...`). Kulonben egy
  // athelyezes utan olyan helyre mutatnank, amit o soha nem latott.
  return unresolveMount(raw) || raw
}

/** Emberi meret. A `0 B` is kiirodik: egy ures fajl informacio, nem hiany. */
export function humanSize(n: number): string {
  if (!Number.isFinite(n) || n < 0) return ''
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v >= 10 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}

function entryFrom(abs: string, name: string, st: Stats, rootRel: string, deep: boolean): LifeEntry {
  const rel = rootRel ? `${rootRel}/${name}` : name
  const isDir = st.isDirectory()
  const src: SourceInfo = detectSource(abs, isDir, deep && isDir)
  return {
    name,
    rel,
    isDir,
    size: isDir ? 0 : st.size,
    sizeHuman: isDir ? '' : humanSize(st.size),
    mtime: (() => { try { return st.mtime.toISOString() } catch { return '' } })(),
    source: { kind: src.kind, label: src.label, short: src.short, icon: src.icon },
    physical: getPhysical(rel).physical,
    mounted: '',
    caution: cautionFor(rel, name, abs, isDir),
  }
}

/** A `GIT_REPOS` mappa (a projektek `Fejlesztés` aga alatt), es ami alatta van. */
const GIT_REPOS_DIR = 'GIT_REPOS'

/**
 * Figyelmeztetes-szoveg egy tetelhez, vagy ures.
 *
 * NEGY eset szamit git-teruletnek:
 *   - maga a `GIT_REPOS` mappa es minden alatta,
 *   - a kozponti gyujtohely (`Rendszer/Tárolók/Git`) es minden alatta,
 *   - minden valodi repo, amiben ott a `.git`.
 *
 * A gyujtohelyet kulon kell nezni, nem eleg a `.git`-re hagyatkozni: amig
 * meg ures vagy csak a fiok-mappa all benne, nincs `.git` sehol -- eppen
 * abban az allapotban maradna jelzes nelkul, amikor a legkonnyebb belenyulni.
 */
function cautionFor(rel: string, name: string, abs: string, isDir: boolean): string {
  const parts = rel.split('/')
  if (rel === DEPOT_PROJECTS) {
    return 'Git-repók központi helye. Itt a git a gazda: kézzel átnevezni vagy áthelyezni bármit elrontja a verziókövetést.'
  }
  if (rel.startsWith(DEPOT_PROJECTS + '/')) {
    return 'Git-repók helye. Jobb nem piszkálni: amit itt kézzel mozgatsz, azt a git nem tudja követni.'
  }
  if (name === GIT_REPOS_DIR) {
    return 'Git-repók helye. Itt a git a gazda: kézzel átnevezni vagy áthelyezni bármit elrontja a verziókövetést.'
  }
  if (parts.includes(GIT_REPOS_DIR)) {
    return 'Git-repó belseje. Jobb nem piszkálni: amit itt kézzel mozgatsz, azt a git nem tudja követni.'
  }
  if (isDir) {
    try { if (statSync(join(abs, '.git'))) return 'Git-repó. Jobb nem piszkálni: amit itt kézzel mozgatsz, azt a git nem tudja követni.' } catch { /* nem repo */ }
  }
  return ''
}

/**
 * Egy mappa tartalma.
 *
 * `deep`: mappaknal egy szintet belenezunk, hogy a vegyes tartalom kiderüljon
 * (lasd `detectSource`). Alapbol BE van kapcsolva, mert a tervben eppen ez a
 * lenyeg -- "ha egy mappa vegyes tartalmu, akkor ne hazudjon a rendszer" --,
 * de nagy mappaknal a hivo kikapcsolhatja.
 */
export function listLife(rel: string, opts: { deep?: boolean } = {}): LifeListing {
  const deep = opts.deep !== false
  const root = explorerRoot()
  const base: LifeListing = {
    rel: String(rel || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''),
    display: '',
    breadcrumb: [],
    parent: null,
    folders: [],
    files: [],
    truncated: false,
    message: null,
  }
  if (!root) {
    return { ...base, message: 'Nincs depó beállítva, ezért nincs mit mutatni. A Depó oldalon add meg, hol legyen a Marveen tárhelye.' }
  }
  const abs = resolveLifePath(base.rel)
  if (!abs) {
    return { ...base, rel: '', message: 'Ez a hely nincs a Marveen mappáján belül, ezért nem nyitom meg.' }
  }

  base.display = toDisplayPath(abs)
  base.parent = base.rel ? (base.rel.includes('/') ? base.rel.slice(0, base.rel.lastIndexOf('/')) : '') : null
  base.breadcrumb = buildBreadcrumb(base.rel)

  let st: Stats
  try { st = statSync(abs) } catch {
    return { ...base, message: `Ez a mappa most nem érhető el: ${toDisplayPath(abs)}` }
  }
  if (!st.isDirectory()) {
    return { ...base, message: 'Ez nem mappa, hanem fájl.' }
  }

  let names: string[]
  try { names = readdirSync(abs) } catch {
    return { ...base, message: 'Ebbe a mappába nincs betekintési jogom.' }
  }

  const folders: LifeEntry[] = []
  const files: LifeEntry[] = []
  let seen = 0
  for (const name of names) {
    // A rejtett es rendszer-tetelek csak zajt visznek a listaba. A `.git`
    // SZANDEKOSAN nem latszik: a git-jelveny amugy is kimondja, hogy repo.
    if (name.startsWith('.') || name === '$RECYCLE.BIN' || name === 'System Volume Information') continue
    if (++seen > MAX_ENTRIES) { base.truncated = true; break }
    const full = join(abs, name)
    let cst: Stats
    // `statSync` es nem `lstatSync`: egy jelkapcsolat (kesobbi NAS- vagy
    // Drive-bekotes) ugy viselkedjen, mint amire mutat. A KILEPEST nem ez
    // vedi, hanem a `resolveLifePath` -- ott derül ki, ha kifele visz.
    try { cst = statSync(full) } catch { continue }
    const e = entryFrom(full, name, cst, base.rel, deep)
    if (e.isDir) folders.push(e)
    else files.push(e)
  }

  // A KOZVETLEN bekotesek ugy jelennek meg, mintha mappak lennenek -- mert a
  // felhasznalo szamara azok is. A jelvenyt a CEL alapjan kapjak, igy ranezesre
  // latszik, hogy egy Drive- vagy Fotok-mappat nyit meg.
  for (const m of mountsInside(base.rel)) {
    const name = m.rel.split('/').pop() as string
    const mAbs = resolveLifePath(m.rel)
    if (!mAbs) continue
    let mst: Stats
    try { mst = statSync(mAbs) } catch { continue }
    const e = entryFrom(mAbs, name, mst, base.rel, deep)
    e.rel = m.rel
    e.mounted = m.label
    // A bekotesi pont MAJDNEM MINDIG egy mar letezo fa-mappa (`Média/Fotók`),
    // nem egy uj nev. Ezert nem hozzaadjuk, hanem LECSEREJUK: a felhasznalo
    // ugyanazt a mappat latja, de mar a bekotott tartalommal es a cel
    // jelvenyevel. (Egy korabbi valtozat kihagyta a meglevoket -- ott a
    // bekotes pont a leggyakoribb esetben nem latszott.)
    const at = folders.findIndex((f) => f.name === name)
    if (at >= 0) folders[at] = e
    else folders.push(e)
  }

  // A beallitott szemelynevek: a sugohoz kell, meg a rendezes elott.
  const cfgPersons = loadLifeConfig().persons.map((p) => safeLifeName(p.name))

  // A SUGO rakotese. A mappa neve alapjan keressuk vissza a gepi kulcsot, igy
  // a szemely alatti `Otthon` es a ceg alatti `Fejlesztes` is megkapja a
  // magyarazatat, barhol is all a faban.
  // A `Fejlesztés` ALATT ket mappa neve beture azonos a projekt/ceg szintjen
  // allokeval (17. pont: ket kulon reteg). Ott mas sugo jar, kulonben a
  // felulet ket egyforma sort mutat, es a felhasznalo duplikaciot lat.
  const devAlatt = base.rel.endsWith(lifeName('development', APP_LANG))

  // A `Projektek` alatt minden mappa EGY PROJEKT -- a neve a felhasznaloe.
  const projektekAlatt = base.rel.endsWith('/' + lifeName('projects', APP_LANG))

  // A `Marvin` NEV ketszer szerepel a faban: a `Rendszer` alatt a Marveen sajat
  // munkafajljai, a `Projektek` alatt viszont a Boss SAJAT projektje. A
  // nev-alapu tabla nem tudja megkulonboztetni oket, a hely igen -- kulonben a
  // sajat projektjere azt irnank ki, hogy „ide nem kell nyulnod".
  const rendszerAlatt = base.rel === lifeName('system', APP_LANG)

  for (const f of folders) {
    const kulcs = lifeKeyForName(f.name)
    if (projektekAlatt) { f.hint = PROJECT_HINT; continue }
    if (kulcs === 'marvin' && !rendszerAlatt) { f.hint = PROJECT_HINT; continue }
    if (devAlatt && kulcs === 'knowledgeBase') { f.hint = DEV_KNOWLEDGE_HINT; continue }
    if (devAlatt && kulcs === 'moreMaterial') { f.hint = DEV_MORE_HINT; continue }
    const h = lifeHint(kulcs)
    if (h) { f.hint = h; continue }
    // A szemely- es cegmappak neve nem fix, ezert a tabla nem talalja oket.
    // A helyuk viszont elarulja, mik: a gyokerben szemely, a Cegek alatt ceg.
    if (f.name === SAMPLE_PERSON) f.hint = SAMPLE_PERSON_HINT
    else if (f.name === SAMPLE_COMPANY) f.hint = SAMPLE_COMPANY_HINT
    else if (!base.rel && cfgPersons.includes(f.name)) f.hint = PERSON_HINT
    else if (base.rel === lifeName('companies', APP_LANG)) f.hint = COMPANY_HINT
  }

  // A gyokerben sajat sorrend: ami emberi, az elol (ELET), ami gepi, hatul
  // (rendszer). Mindenutt maskor betűrend, magyar szabaly szerint.
  if (!base.rel) {
    const order = topOrder(APP_LANG)
    // A szemelyek elore, a beallitas sorrendjeben -- a gazda a legelso.
    const persons = loadLifeConfig().persons.map((p) => safeLifeName(p.name))
    // A BEERKEZO a LEGELSO -- meg a gazda ele is.
    //
    // Boss: „A beerkezo mappat azt tedd legelore! legfelulre. […] mert azon
    // keresztul fogjuk most a helyukre tenni a dokumentumokat. az az elso
    // lepes." Ha a munkafolyamat elso lepese lejjebb all a listaban, mint a
    // vegeredmeny, akkor a lista a sajat hasznalata ellen dolgozik.
    const inbox = lifeName('inbox', APP_LANG)
    const rank = (n: string) => {
      if (n === inbox) return -1
      const pi = persons.indexOf(n)
      if (pi >= 0) return pi
      const i = order.indexOf(n)
      // Az ismeretlen nevek a rogzitett agak es a szemelyek KOZE nem furakodnak
      // be: a vegere kerulnek, ott viszont beturendben.
      return persons.length + (i < 0 ? order.length : i)
    }
    folders.sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name, 'hu'))
  } else {
    folders.sort((a, b) => a.name.localeCompare(b.name, 'hu'))
  }
  files.sort((a, b) => a.name.localeCompare(b.name, 'hu'))

  return { ...base, folders, files }
}

function buildBreadcrumb(rel: string): Array<{ name: string; rel: string }> {
  const crumbs: Array<{ name: string; rel: string }> = [{ name: 'Marveen', rel: '' }]
  if (!rel) return crumbs
  const parts = rel.split('/').filter(Boolean)
  let acc = ''
  for (const p of parts) {
    acc = acc ? `${acc}/${p}` : p
    crumbs.push({ name: p, rel: acc })
  }
  return crumbs
}

export interface LifeInfo {
  rel: string
  /** Ha bekotesen at latszik: mi a valodi helye es minek hivjuk. */
  mount?: { label: string; target: string } | null
  name: string
  isDir: boolean
  exists: boolean
  /** `PDF`, `JPEG kép`, `Mappa` -- emberi tipus, nem MIME. */
  type: string
  size: number
  sizeHuman: string
  mtime: string
  /** Kihez tartozik a fa szerint (szemely vagy ceg neve), vagy ures. */
  owner: string
  /** Digitalis hely emberi mondatban: `Név / Jogi / Németország / Bíróság`. */
  digitalLocation: string
  source: SourceInfo
  physical: PhysicalRecord
  /** A papir helye emberi mondatban (ugyanaz a fa, nyilakkal). */
  physicalLocationHuman: string
}

/** Emberi fajltipus a kiterjesztesbol. Ismeretlennel a kiterjesztes maga. */
function humanType(name: string, isDir: boolean): string {
  if (isDir) return 'Mappa'
  const ext = (name.split('.').pop() || '').toLowerCase()
  const map: Record<string, string> = {
    pdf: 'PDF', doc: 'Word dokumentum', docx: 'Word dokumentum',
    xls: 'Excel táblázat', xlsx: 'Excel táblázat', csv: 'Táblázat (CSV)',
    ppt: 'Diasor', pptx: 'Diasor', txt: 'Szöveg', md: 'Szöveg (Markdown)',
    jpg: 'Kép (JPEG)', jpeg: 'Kép (JPEG)', png: 'Kép (PNG)', gif: 'Kép (GIF)',
    heic: 'Kép (HEIC)', webp: 'Kép (WebP)', svg: 'Kép (SVG)',
    mp4: 'Videó', mov: 'Videó', avi: 'Videó', mkv: 'Videó',
    mp3: 'Hang', wav: 'Hang', m4a: 'Hang',
    zip: 'Tömörített', rar: 'Tömörített', '7z': 'Tömörített',
    eml: 'E-mail', msg: 'E-mail', json: 'Adatfájl (JSON)',
  }
  return map[ext] || (ext ? `${ext.toUpperCase()} fájl` : 'Fájl')
}

/**
 * Ki a gazdaja ennek az utvonalnak a fa szerint?
 *
 * Nem talalgatunk: csak akkor mondunk nevet, ha az utvonal ELSO szakasza
 * (`<név>/...`) egyezik egy felvett szemellyel vagy ceggel. Ismeretlen helyen
 * ures marad -- egy rossz nev rosszabb, mint a semmi. (Specifikacio 23. pont:
 * "SOHA ne talalja ki, hogy egy dokumentum kihez tartozik.")
 */
function ownerOf(rel: string, cfg: LifeConfig): string {
  const parts = rel.split('/').filter(Boolean)
  if (!parts.length) return ''
  const companiesDir = lifeName('companies', APP_LANG)
  const archiveDir = lifeName('archive', APP_LANG)
  // `Cégek/<cég>` es `Archív/<név>` egy szinttel lejjebb tartja a nevet;
  // mindenhol maskor maga az elso szakasz a nev. (A `Média` mar nem felso
  // szintu ag, hanem minden szemely es ceg sajat kategoriaja -- ott tehat az
  // elso szakasz mar maga a tulajdonos.)
  const nested = parts[0] === companiesDir || parts[0] === archiveDir
  const candidate = nested ? parts[1] : parts[0]
  if (!candidate) return ''
  const person = cfg.persons.find((p) => safeLifeName(p.name) === candidate)
  if (person) return person.name
  const company = cfg.companies.find((c) => safeLifeName(c.name) === candidate)
  return company ? company.name : ''
}

/** `Név/Jogi/Németország` -> `Név / Jogi / Németország`. */
export function humanLocation(rel: string): string {
  return rel.split('/').filter(Boolean).map(prettyCase).join(' / ')
}

/** `Németország` -> `Németország`. A csupa nagybetű a lemezen kell, a szemnek nem. */
function prettyCase(s: string): string {
  if (s !== s.toUpperCase()) return s
  return s.split(' ').map((w) => (w ? w[0] + w.slice(1).toLowerCase() : w)).join(' ')
}

export function lifeInfo(rel: string): LifeInfo | null {
  const cleanRel = String(rel || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  const abs = resolveLifePath(cleanRel)
  if (!abs) return null
  const name = basename(abs)
  let st: Stats | null = null
  try { st = statSync(abs) } catch { st = null }
  const isDir = st ? st.isDirectory() : false
  const physical = getPhysical(cleanRel)
  const mounted = resolveMount(cleanRel)
  return {
    rel: cleanRel,
    mount: mounted ? { label: mounted.mount.label, target: mounted.target } : null,
    name,
    isDir,
    exists: Boolean(st),
    type: humanType(name, isDir),
    size: st && !isDir ? st.size : 0,
    sizeHuman: st && !isDir ? humanSize(st.size) : '',
    mtime: st ? (() => { try { return st!.mtime.toISOString() } catch { return '' } })() : '',
    owner: ownerOf(cleanRel, loadLifeConfig()),
    digitalLocation: humanLocation(cleanRel.includes('/') ? cleanRel.slice(0, cleanRel.lastIndexOf('/')) : ''),
    source: detectSource(abs, isDir, isDir),
    physical,
    physicalLocationHuman: physical.location ? humanLocation(physical.location) : '',
  }
}

export interface MoveResult {
  ok: boolean
  /** Az uj relativ utvonal, ha sikerult. */
  rel: string
  message: string
  code?: string
}

/**
 * Athelyezes a fan belul.
 *
 * `toDirRel` a CEL MAPPA, nem a cel fajl: a felulet mindig mappat jelol ki, a
 * nev pedig marad. (Atnevezni kesobb, kulon muvelettel lehet -- azt nem
 * keverjuk ide, mert egy elgepelt nev egy athelyezes kozben eszrevetlen
 * maradna.)
 */
export function moveLife(fromRel: string, toDirRel: string): MoveResult {
  const from = resolveLifePath(fromRel)
  const toDir = resolveLifePath(toDirRel)
  if (!from || !toDir) {
    return { ok: false, rel: '', code: 'outside', message: 'Ez a hely nincs a Marveen mappáján belül, ezért nem nyúlok hozzá.' }
  }
  if (!existsSync(from)) {
    return { ok: false, rel: '', code: 'missing', message: 'Ez a fájl már nincs a régi helyén. Frissítsd a listát.' }
  }
  let toIsDir = false
  try { toIsDir = statSync(toDir).isDirectory() } catch { toIsDir = false }
  if (!toIsDir) {
    return { ok: false, rel: '', code: 'no_target', message: 'A célként megadott hely nem mappa.' }
  }
  const name = basename(from)
  const target = join(toDir, name)
  if (target === from) {
    return { ok: false, rel: fromRel, code: 'same', message: 'Ez a fájl már ebben a mappában van.' }
  }
  // Mappat nem lehet SAJAT MAGA ALA tenni: a `renameSync` erre EINVAL-t ad, de
  // a hibauzenet ("invalid argument") semmit nem mond a felhasznalonak.
  if (statSafe(from)?.isDirectory() && (toDir === from || toDir.startsWith(from + sep))) {
    return { ok: false, rel: '', code: 'into_self', message: 'Egy mappát nem lehet önmagába áthelyezni.' }
  }
  // NEM IRUNK FELUL. Egy azonos nevu irat csendes felulirasa visszafordithatatlan.
  if (existsSync(target)) {
    return {
      ok: false, rel: '', code: 'exists',
      message: `A célmappában már van ilyen nevű fájl: ${name}. Nem írom felül -- előbb nevezd át valamelyiket.`,
    }
  }

  try {
    renameSync(from, target)
  } catch (err: any) {
    // Ket kulon lemez kozott (`EXDEV`) az atnevezes nem mukodik -- ott
    // masolni kell, es csak SIKERES masolas utan torolni. A depon belul ez
    // ritka, de egy jelkapcsolattal bekotott NAS-mappanal eppen ez tortenne.
    if (err?.code === 'EXDEV' && !statSafe(from)?.isDirectory()) {
      try {
        copyFileSync(from, target)
        rmSync(from, { force: true })
      } catch (err2: any) {
        return { ok: false, rel: '', code: 'failed', message: `Nem sikerült áthelyezni: ${String(err2?.message || err2)}` }
      }
    } else {
      return { ok: false, rel: '', code: 'failed', message: `Nem sikerült áthelyezni: ${String(err?.code || err?.message || err)}` }
    }
  }

  const newRel = toLifeRel(target)
  // A papir-nyilvantartas kovesse a fajlt, kulonben a fizikai peldany
  // informacioja a regi utvonalon maradna, vagyis a semmin.
  movePhysical(fromRel, newRel)
  logger.info({ from: fromRel, to: newRel }, '[intezo] athelyezve')
  return { ok: true, rel: newRel, message: `Áthelyezve ide: ${humanLocation(newRel)}` }
}

function statSafe(p: string): Stats | null {
  try { return statSync(p) } catch { return null }
}

/** Uj mappa a fan belul. A nev nem lehet utvonal -- csak nev. */
export function mkdirLife(parentRel: string, name: string): MoveResult {
  const clean = safeLifeName(name)
  if (!clean || clean === '_') {
    return { ok: false, rel: '', code: 'bad_name', message: 'Adj meg egy nevet a mappának.' }
  }
  if (/[\\/]/.test(String(name))) {
    return { ok: false, rel: '', code: 'bad_name', message: 'A mappa neve nem tartalmazhat per-jelet. Csak a nevét írd be.' }
  }
  const parent = resolveLifePath(parentRel)
  if (!parent) {
    return { ok: false, rel: '', code: 'outside', message: 'Ez a hely nincs a Marveen mappáján belül.' }
  }
  const target = join(parent, clean)
  if (existsSync(target)) {
    return { ok: false, rel: toLifeRel(target), code: 'exists', message: 'Ilyen nevű mappa már van itt.' }
  }
  try {
    mkdirSync(target, { recursive: false })
  } catch (err: any) {
    return { ok: false, rel: '', code: 'failed', message: `Nem sikerült létrehozni: ${String(err?.code || err?.message || err)}` }
  }
  return { ok: true, rel: toLifeRel(target), message: `Kész: ${clean}` }
}

/**
 * ATNEVEZES.
 *
 * Kulon fuggveny, nem az athelyezes egy esete: az athelyezes MASIK mappaba
 * visz, ez helyben marad. A felhasznalonak is ket kulon dolog, es a hibauzenet
 * is mas („mar van ilyen nevu itt" vs. „a celmappaban mar van ilyen").
 */
export function renameLife(rel: string, newName: string): MoveResult {
  const abs = resolveLifePath(rel)
  if (!abs) {
    return { ok: false, rel: '', code: 'outside', message: 'Ez a hely nincs a Marveen mappáján belül, ezért nem nyúlok hozzá.' }
  }
  if (!existsSync(abs)) {
    return { ok: false, rel: '', code: 'missing', message: 'Ez már nincs a régi helyén. Frissítsd a listát.' }
  }
  if (/[\\/]/.test(String(newName))) {
    return { ok: false, rel: '', code: 'bad_name', message: 'A név nem tartalmazhat per-jelet. Csak a nevét írd be.' }
  }
  const clean = safeLifeName(newName)
  if (!clean || clean === '_') {
    return { ok: false, rel: '', code: 'bad_name', message: 'Adj meg egy nevet.' }
  }
  if (clean === basename(abs)) {
    return { ok: false, rel, code: 'same', message: 'Ez már most is ez a név.' }
  }
  const target = join(dirname(abs), clean)
  if (existsSync(target)) {
    return { ok: false, rel: '', code: 'exists', message: `Már van itt ilyen nevű: ${clean}. Nem írom felül.` }
  }
  try {
    renameSync(abs, target)
  } catch (err: any) {
    return { ok: false, rel: '', code: 'failed', message: `Nem sikerült átnevezni: ${String(err?.code || err?.message || err)}` }
  }
  const newRel = toLifeRel(target)
  movePhysical(rel, newRel)
  logger.info({ from: rel, to: newRel }, '[intezo] atnevezve')
  return { ok: true, rel: newRel, message: `Új neve: ${clean}` }
}

/**
 * TORLES -- valojaban KUKAZAS.
 *
 * A fajl a `Rendszer/Kuka/<idopont>/` ala kerul, es ott is marad, amig a
 * felhasznalo ki nem uriti. Egy fa-nezetben, ahol egy sorral feljebb a teljes
 * eleted all, visszafordithatatlan gombot nem adunk a kez ala.
 *
 * A gyoker kozvetlen agait (`Beérkező`, `Rendszer`, szemelyek, `Cégek`...) nem
 * engedjuk kukazni: azokat a beallitas hozza letre, a kovetkezo
 * „Könyvtárszerkezet létrehozása" ugyis visszatenne -- a felhasznalo meg azt
 * hinne, torolt valamit. Aki tenyleg meg akar szuntetni egy agat, a
 * beallitasban veszi ki a szemelyt vagy a projektet.
 */
/**
 * Elso szabad nev egy mappaban: `x.txt`, `x (2).txt`, `x (3).txt`...
 *
 * A kiterjesztes a vegen marad, kulonben a `x.txt (2)` nevu fajlt a rendszer
 * mar nem ismerne fel szovegnek.
 */
function szabadNev(dir: string, name: string): string {
  let cand = join(dir, name)
  if (!existsSync(cand)) return cand
  const pont = name.lastIndexOf('.')
  const torzs = pont > 0 ? name.slice(0, pont) : name
  const kit = pont > 0 ? name.slice(pont) : ''
  for (let i = 2; i < 1000; i++) {
    cand = join(dir, `${torzs} (${i})${kit}`)
    if (!existsSync(cand)) return cand
  }
  return join(dir, `${torzs} (${Date.now()})${kit}`)
}

export function trashLife(rel: string): MoveResult {
  const root = explorerRoot()
  const abs = resolveLifePath(rel)
  if (!root || !abs) {
    return { ok: false, rel: '', code: 'outside', message: 'Ez a hely nincs a Marveen mappáján belül, ezért nem nyúlok hozzá.' }
  }
  if (abs === root) {
    return { ok: false, rel: '', code: 'root', message: 'A teljes fát nem törlöm.' }
  }
  if (!existsSync(abs)) {
    return { ok: false, rel: '', code: 'missing', message: 'Ez már nincs itt. Frissítsd a listát.' }
  }
  const parts = toLifeRel(abs).split('/')
  if (parts.length === 1) {
    return {
      ok: false, rel: '', code: 'top',
      message: 'Ez a fa egyik fő ága — a következő „Könyvtárszerkezet létrehozása" úgyis visszatenné. '
        + 'Ha tényleg nem kell, a „Kik szerepeljenek a fában?" résznél vedd ki a személyt vagy a céget.',
    }
  }

  const kukaRel = lifeName('system', APP_LANG) + '/' + lifeName('trash', APP_LANG)
  const relNow = toLifeRel(abs)
  // A Kuka nem kerulhet onmagaba. Enelkul a `renameSync` EINVAL-t ad, es a
  // felhasznalo egy gepi szot kap valasznak.
  if (relNow === kukaRel || relNow.startsWith(kukaRel + '/')) {
    return {
      ok: false, rel: '', code: 'in_trash',
      message: 'Ez már a Kukában van, oda nem tehetem még egyszer. Ha végleg meg akarsz szabadulni tőle, '
        + 'kattints rá jobb gombbal, és válaszd a „Végleges törlés" pontot — onnan már nincs visszaút.',
    }
  }

  const kuka = join(root, lifeName('system', APP_LANG), lifeName('trash', APP_LANG))
  const stamp = new Date().toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-')
  const dir = join(kuka, stamp)
  // EGY MASODPERCEN BELUL ket azonos nevu tetel is jarhat. A `renameSync` egy
  // letezo FAJLT szo nelkul felulir -- vagyis a Kuka pont akkor nyelne el
  // valamit, amikor a felhasznalo takarit, es a legkevesbe figyel oda. Ezert
  // szabad nevet keresunk, es sose irunk felul.
  const target = szabadNev(dir, basename(abs))
  try {
    mkdirSync(dir, { recursive: true })
    renameSync(abs, target)
  } catch (err: any) {
    return { ok: false, rel: '', code: 'failed', message: `Nem sikerült a Kukába tenni: ${String(err?.code || err?.message || err)}` }
  }
  const newRel = toLifeRel(target)
  movePhysical(rel, newRel)
  logger.info({ from: rel, to: newRel }, '[intezo] kukaba')
  return {
    ok: true, rel: newRel,
    // A TENYLEGES nevet mondjuk: nevutkozeskor mas lett, mint ami a listaban allt.
    message: `A Kukába került: ${basename(target)}. Ott megtalálod a Rendszer / Kuka / ${stamp} alatt, amíg ki nem üríted.`,
  }
}

/**
 * VEGLEGES TORLES -- csak a Kukan belul.
 *
 * Ez az egyetlen muvelet a fan, ami nem visszavonhato, ezert a legszukebbre
 * van szabva: a `Rendszer/Kuka` alatt mukodik, mashol nem. A Kuka MAGA nem
 * torlodik, csak kiurul -- kell a hely a kovetkezo kukazasnak.
 */
export function purgeLife(rel: string): MoveResult {
  const root = explorerRoot()
  const abs = resolveLifePath(rel)
  if (!root || !abs) {
    return { ok: false, rel: '', code: 'outside', message: 'Ez a hely nincs a Marveen mappáján belül, ezért nem nyúlok hozzá.' }
  }
  if (!existsSync(abs)) {
    return { ok: false, rel: '', code: 'missing', message: 'Ez már nincs itt. Frissítsd a listát.' }
  }
  const kukaRel = lifeName('system', APP_LANG) + '/' + lifeName('trash', APP_LANG)
  const relNow = toLifeRel(abs)
  // A HATAR. Veglegeset csak ott, ahonnan a felhasznalo mar egyszer
  // elbucsuzott a fajltol.
  if (relNow !== kukaRel && !relNow.startsWith(kukaRel + '/')) {
    return {
      ok: false, rel: '', code: 'not_in_trash',
      message: 'Véglegesen csak a Kukából törlök. Ezt előbb tedd a Kukába — ha ott is fölöslegesnek látod, '
        + 'onnan már végleg törölheted.',
    }
  }

  // A KUKA MAGA: kiuritjuk, de a mappa marad.
  if (relNow === kukaRel) {
    let db = 0
    let hiba = ''
    for (const d of readdirSync(abs)) {
      try { rmSync(join(abs, d), { recursive: true, force: true }); db++ } catch (err: any) { hiba = String(err?.code || err?.message || err) }
    }
    if (hiba && !db) {
      return { ok: false, rel: '', code: 'failed', message: `Nem sikerült kiüríteni a Kukát: ${hiba}` }
    }
    logger.warn({ db }, '[intezo] kuka kiuritve')
    return {
      ok: true, rel: kukaRel,
      message: db ? `A Kuka kiürült: ${db} tétel törölve, véglegesen.` : 'A Kuka már üres volt.',
    }
  }

  const nev = basename(abs)
  try {
    rmSync(abs, { recursive: true, force: true })
  } catch (err: any) {
    return { ok: false, rel: '', code: 'failed', message: `Nem sikerült törölni: ${String(err?.code || err?.message || err)}` }
  }
  // A papir-nyilvantartas bejegyzese is menjen vele: a fajl mar nincs, a
  // „papiron is megvan" sor nelkule ertelmetlen lenne.
  forgetPhysical(relNow)
  // Az ures belyeges mappa is menjen: kulonben a Kuka tele lesz ures
  // datum-mappakkal, es a felhasznalo azt latja, hogy "meg mindig van benne
  // valami". Csak akkor, ha tenyleg ures -- a testverek maradnak.
  const szulo = dirname(abs)
  if (toLifeRel(szulo) !== relNow && KUKA_BELYEG.test(basename(szulo))) {
    try { if (!readdirSync(szulo).length) rmSync(szulo, { recursive: true, force: true }) } catch { /* nem baj */ }
  }
  logger.warn({ rel: relNow }, '[intezo] veglegesen torolve')
  return { ok: true, rel: dirname(relNow) === '.' ? '' : toLifeRel(dirname(abs)), message: `Véglegesen törölve: ${nev}` }
}

/** A Kuka belyeges mappaneve: `2026-08-22_00-05-01`. */
const KUKA_BELYEG = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})$/

/**
 * A Kuka automatikus uritese: ami `days` napnal regebben kerult be, elmegy.
 *
 * A kort a BELYEGBOL olvassuk (az rogziti, mikor dobtad ki), nem az mtime-bol
 * -- azt egy masolas vagy egy mentes-visszatoltes elallitja. Ha egy mappanev
 * nem belyeg, az mtime a tartalek; ha egyik sem hasznalhato, NEM torlunk.
 * `days <= 0` esetén meg sem mozdulunk: az a „soha" beallitas.
 */
export function autoPurgeTrash(days: number, most = Date.now()): { torolt: number; nevek: string[] } {
  const nevek: string[] = []
  if (!Number.isFinite(days) || days <= 0) return { torolt: 0, nevek }
  const kukaRel = lifeName('system', APP_LANG) + '/' + lifeName('trash', APP_LANG)
  const abs = resolveLifePath(kukaRel)
  if (!abs || !existsSync(abs)) return { torolt: 0, nevek }
  const hatar = most - days * 24 * 60 * 60 * 1000
  let list: string[] = []
  try { list = readdirSync(abs) } catch { return { torolt: 0, nevek } }
  for (const nev of list) {
    const m = KUKA_BELYEG.exec(nev)
    let mikor = NaN
    if (m) {
      mikor = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`).getTime()
    } else {
      try { mikor = statSync(join(abs, nev)).mtimeMs } catch { mikor = NaN }
    }
    if (!Number.isFinite(mikor) || mikor >= hatar) continue
    try {
      rmSync(join(abs, nev), { recursive: true, force: true })
      forgetPhysical(kukaRel + '/' + nev)
      nevek.push(nev)
    } catch (err) {
      logger.warn({ err, nev }, '[intezo] a Kuka automatikus uritese egy tetelen elakadt')
    }
  }
  if (nevek.length) logger.warn({ torolt: nevek.length, days }, '[intezo] a Kuka automatikusan urult')
  return { torolt: nevek.length, nevek }
}

/**
 * Kereses a fan belul, nev szerint.
 *
 * Szandekosan CSAK a nevben keres, nem a fajlok tartalmaban: a tartalom-
 * kereseshez indexelni kellene, es egy 8 GB-os keptar vegigolvasasa minden
 * gepelesnel hasznalhatatlan lenne. Aki tartalomra keres, azt a Marveen AI
 * oldalarol teszi.
 */
export function searchLife(rel: string, query: string, limit = 200): { entries: LifeEntry[]; truncated: boolean } {
  const q = String(query || '').trim().toLowerCase()
  if (!q) return { entries: [], truncated: false }
  const startAbs = resolveLifePath(rel)
  if (!startAbs) return { entries: [], truncated: false }

  const entries: LifeEntry[] = []
  let truncated = false
  // Szelessegi bejaras, felso hatarral: egy nagyon melyre agazo fanal a
  // melysegi bejaras egyetlen agban veszne el, es a felhasznalo azt latna,
  // hogy "nincs talalat" -- holott csak nem jutottunk el a szomszed agig.
  const queue: string[] = [startAbs]
  let visited = 0
  while (queue.length && entries.length < limit && visited < 20000) {
    const dir = queue.shift()!
    let names: string[]
    try { names = readdirSync(dir) } catch { continue }
    for (const name of names) {
      if (name.startsWith('.')) continue
      visited++
      const full = join(dir, name)
      let st: Stats
      try { st = statSync(full) } catch { continue }
      if (name.toLowerCase().includes(q)) {
        const parentRel = toLifeRel(dir)
        if (entries.length >= limit) { truncated = true; break }
        entries.push(entryFrom(full, name, st, parentRel, false))
      }
      if (st.isDirectory()) queue.push(full)
    }
  }
  return { entries, truncated: truncated || queue.length > 0 }
}
