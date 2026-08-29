// HONNAN JON EZ A FAJL? A forrasfelismeres az Intezo mogott.
//
// Boss, 2026-08-21: "a Marvin Intezoben mindig lathato legyen, hogy egy fajl
// vagy mappa fizikailag honnan szarmazik / hol van tarolva: helyi gep, Google
// Drive, Google Photos, Git stb." Es a tervezesi alapelv, ami ezt indokolja:
// "a Marvin legyen intelligens reteg a fajlrendszer folott, ne pedig egy fekete
// doboz."
//
// Ez a modul EGY kerdesre valaszol: `detectSource(utvonal)` -> melyik tarolobol
// jon. Harom dolog mult azon, hogyan van megirva:
//
//  1. NE HAZUDJON. Ha egy mappa tartalma tobb forrasbol jon, azt `vegyes`-nek
//     mondjuk, nem valasztunk kozuluk egyet. A tervben ez kulon ki van mondva.
//     Amit nem tudunk, arra `helyi` a valasz -- mert az IGAZ: a fajl ott van a
//     gepen. Sosem talalunk ki forrast.
//
//  2. NE LASSITSA AZ INTEZOT. Egy mappa listazasakor ez a fuggveny minden
//     sorra lefut. Ezert az egesz felismeres UTVONAL-ALAPU (szoveg-osszevetes),
//     es csak a git-nel megyunk a lemezhez -- ott is gyorsitotarral, mert egy
//     repo 200 fajljanal ugyanaz a `.git` valasz jonne 200-szor.
//
//  3. LEHESSEN BOVITENI. Boss: "ha ket ev mulva nem Google Drive lesz, hanem
//     peldaul NAS, akkor ne kelljen az egesz rendszert ujraepiteni." Ezert a
//     felismerok egy REGISZTERBEN allnak (`registerSourceProvider`): egy uj
//     tarolo egy uj bejegyzes, es nem nyul hozza senki mashoz.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, sep } from 'node:path'
import { PROJECT_ROOT } from './config.js'
import { depotRoot, DEPOT_DRIVE, DEPOT_PHOTOS } from './depot.js'
import { toDisplayPath } from './depot-browse.js'
import { storageAt, storageMissText, type StorageMissReason } from './storage-index.js'

/**
 * A forrasok gepi nevei.
 *
 * Nem szigoru unio-tipus, hanem `string`: egy kesobbi tarolo (NAS, OneDrive,
 * S3) sajat nevet hozza, es nem szabad, hogy ehhez ezt a fajlt kelljen
 * atirni -- pont ez a bovithetoseg lenyege.
 */
export type SourceKind = 'local' | 'drive' | 'photos' | 'git' | 'mixed' | string

export interface SourceDetail {
  label: string
  value: string
}

export interface SourceInfo {
  kind: SourceKind
  /** Emberi nev a buborekba: "Google Drive". */
  label: string
  /** Rovid cimke a `[DRIVE]` megjelenitesi modhoz. */
  short: string
  /** Ikon az IKON modhoz (ez az alapertelmezett megjelenites). */
  icon: string
  /** Reszletek a buborekba es az informacios panelbe, sorrendben. */
  details: SourceDetail[]
  /**
   * A specifikacio 20. pontjanak PER-FAJL adatmodellje.
   *
   * Eddig a jelveny csak a FAJTAT mondta meg ("Drive"), azt nem, hogy MELYIK
   * Drive-rol van szo -- `DRIVE_02` es `DRIVE_07` egyformanak latszott. Ez a
   * negy mezo teszi a jelvenyt visszakeresheteve; az otodik mezo, a
   * `logicalPath`, a hivo oldalan all (`lifeInfo`), mert az a fa-beli hely,
   * nem a forrase.
   *
   * A `storageId` szandekosan lehet `null`: ha nem tudjuk, azt mondjuk ki, nem
   * pedig egy kitalalt azonositot. A `storageMiss` mondja meg, MIERT nincs --
   * a harom ok (nincs raktar / nem tarolo alol jon / nincs meg kiosztva
   * sorszam) KULON kezelendo. Ez a "nulla ket dolgot jelenthet" szabalya:
   * "nincs azonosito" nem ugyanaz, mint "nem lattam oda".
   */
  storageId?: string | null
  storageType?: string | null
  /** A tarolo emberi neve (`lackor2`), ha van. */
  storageName?: string
  storageMiss?: StorageMissReason | null
  /** A fajl TENYLEGES helye a lemezen, emberi alakban. */
  physicalPath?: string
  /** Melyik felismero valaszolt (`drive`, `photos`, `git`, `local`). */
  sourceProvider?: string
}

export interface SourceProvider {
  /** Gepi nev, egyben a forras `kind` erteke. */
  id: string
  /** Nagyobb szam = elobb kerdezzuk. A `local` a 0-val mindig utolso. */
  priority: number
  /**
   * A jelmagyarazat adatai. KULON allnak a `detect()`-tol, mert a
   * jelmagyarazatot akkor is ki kell tudni irni, ha eppen egyetlen ilyen
   * fajl sincs a gepen -- egy `detect()` hivas ilyenkor `null`-t adna, es a
   * lista helyen a gepi nev jelenne meg (`drive` a "Google Drive" helyett).
   */
  label: string
  short: string
  icon: string
  /**
   * `null`, ha ez a tarolo nem ismeri fel az utvonalat. NEM dobhat: egy
   * lecsatolt halozati meghajto felismeroje nem akaszthatja meg a listazast.
   */
  detect(abs: string, isDir: boolean): SourceInfo | null
}

const providers: SourceProvider[] = []

/**
 * Uj tarolo bekotese.
 *
 * Egy NAS-tamogatas ennyi lenne: `registerSourceProvider({ id: 'nas',
 * priority: 50, detect })` -- es az Intezoben megjelenik a jelvenye, a
 * buborekja es az informacios panelja, ennek a fajlnak a modositasa nelkul.
 */
export function registerSourceProvider(p: SourceProvider): void {
  const i = providers.findIndex((x) => x.id === p.id)
  if (i >= 0) providers[i] = p
  else providers.push(p)
  providers.sort((a, b) => b.priority - a.priority)
}

/** Csak a teszteknek: vissza az alaphelyzetbe. */
export function resetSourceProviders(): void {
  providers.length = 0
  registerBuiltinProviders()
}

/** Utvonal-tartalmazas, ami NEM dol be a `/a/bc` vs `/a/b` esetnek. */
function isUnder(abs: string, base: string): boolean {
  if (!base) return false
  const a = abs.replace(/[\\/]+$/, '')
  const b = base.replace(/[\\/]+$/, '')
  return a === b || a.startsWith(b + sep) || a.startsWith(b + '/')
}

/** Az elso utvonalszakasz `base` alatt (`drive/lackor2/x` -> `lackor2`). */
function firstSegmentUnder(abs: string, base: string): string {
  const rest = abs.slice(base.length).replace(/^[\\/]+/, '')
  const seg = rest.split(/[\\/]/)[0]
  return seg || ''
}

// ---------------------------------------------------------------------------
// Google Fotok
// ---------------------------------------------------------------------------

function photosProvider(): SourceProvider {
  return {
    id: 'photos',
    priority: 80,
    label: 'Google Fotók', short: 'FOTÓK', icon: '📷',
    detect(abs) {
      const root = depotRoot()
      if (!root) return null
      const base = join(root, DEPOT_PHOTOS)
      if (!isUnder(abs, base)) return null
      const account = firstSegmentUnder(abs, base)
      return {
        kind: 'photos',
        label: 'Google Fotók',
        short: 'FOTÓK',
        icon: '📷',
        details: [
          { label: 'Forrás', value: 'Google Fotók' },
          ...(account ? [{ label: 'Fiók', value: account }] : []),
          // A Fotok-kepeket a Marveen LEHOZZA a gepre, nem hivatkozik rajuk:
          // ezert van helyi peldany, es ezert nyithato meg internet nelkul is.
          { label: 'Helyi példány', value: 'igen' },
          { label: 'Hely', value: toDisplayPath(abs) },
        ],
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Google Drive
// ---------------------------------------------------------------------------

/**
 * A Drive-szinkron parosai, kozvetlenul a beallitas-fajlbol.
 *
 * Szandekosan NEM a `drive-sync.ts` modult importaljuk: az egy webes utvonal-
 * kezelo, ami magaval huzna a Google-klienst es a naplozast is. Egy
 * mappalistazasnak nincs szuksege ezekre. Serult vagy hianyzo fajlnal ures
 * lista jon, es a felismeres akkor is mukodik -- csak a paros neve marad ki a
 * buborekbol.
 */
function loadSyncPairs(): Array<{ account: string; name: string; folderId: string; lastRunAt?: string }> {
  try {
    const p = join(PROJECT_ROOT, 'store', 'drive-sync.json')
    if (!existsSync(p)) return []
    const raw = JSON.parse(readFileSync(p, 'utf8'))
    return Array.isArray(raw?.pairs) ? raw.pairs : []
  } catch {
    return []
  }
}

function driveProvider(): SourceProvider {
  return {
    id: 'drive',
    priority: 70,
    label: 'Google Drive', short: 'DRIVE', icon: '☁️',
    detect(abs) {
      const root = depotRoot()
      if (!root) return null
      const base = join(root, DEPOT_DRIVE)
      if (!isUnder(abs, base)) return null
      const account = firstSegmentUnder(abs, base)
      // Melyik szinkronizalt mappaban vagyunk? A paros neve a fiok alatti
      // KOVETKEZO szakasz -- ha megvan, ki tudjuk mondani, mikor jart itt
      // utoljara a szinkron.
      const afterAccount = account ? join(base, account) : base
      const pairName = firstSegmentUnder(abs, afterAccount)
      const pair = loadSyncPairs().find((p) => p.account === account && p.name === pairName)
      return {
        kind: 'drive',
        label: 'Google Drive',
        short: 'DRIVE',
        icon: '☁️',
        details: [
          { label: 'Forrás', value: 'Google Drive' },
          ...(account ? [{ label: 'Drive-fiók', value: account }] : []),
          ...(pair ? [{ label: 'Szinkronizált mappa', value: pair.name }] : []),
          // A KETIRANYU szinkron azt jelenti, hogy amit itt szerkesztesz,
          // felmegy a Drive-ra is. Ezt ki KELL mondani: enelkul valaki
          // "csak megnezem" alapon nyitna meg egy fajlt, es visszamentene.
          { label: 'Szinkronizált', value: pair ? 'igen, kétirányban' : 'ebben a mappában nincs beállítva' },
          ...(pair?.lastRunAt ? [{ label: 'Utoljára', value: pair.lastRunAt.slice(0, 16).replace('T', ' ') }] : []),
          { label: 'Helyi útvonal', value: toDisplayPath(abs) },
        ],
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------

interface RepoInfo {
  /** A repo gyokere (ahol a `.git` all). */
  root: string
  name: string
  branch: string
  remote: string
}

/**
 * Gyorsitotar mappankent.
 *
 * Egy repo listazasakor minden sorra ugyanaz a valasz jonne, es mindegyikert
 * felsetalnank a `.git`-ig. A `null` ertek is tarolodik ("itt nincs repo"),
 * kulonben a legdragabb eset -- a nem-repo mappak -- egyaltalan nem gyorsulna.
 */
const repoCache = new Map<string, RepoInfo | null>()

/** Csak a teszteknek (es a fa ujraolvasasakor). */
export function clearRepoCache(): void { repoCache.clear() }

function readRepoAt(dir: string): RepoInfo | null {
  const gitPath = join(dir, '.git')
  let isRepo = false
  try { isRepo = existsSync(gitPath) } catch { return null }
  if (!isRepo) return null

  // A `.git` lehet FAJL is, nem csak mappa: worktree-nel es submodule-nal egy
  // `gitdir: ...` sor mutat a valodi helyre. A Marveen sajat repoja epp igy
  // dolgozik (`scripts/agent-worktree.sh`), tehat ez nem elmeleti eset.
  let gitDir = gitPath
  try {
    if (statSync(gitPath).isFile()) {
      const m = /gitdir:\s*(.+)/.exec(readFileSync(gitPath, 'utf8'))
      if (m) gitDir = m[1].trim()
    }
  } catch { /* marad a `.git` mappa */ }

  let branch = ''
  try {
    const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim()
    const m = /^ref:\s*refs\/heads\/(.+)$/.exec(head)
    // Levalasztott HEAD-nel a hash all ott. Nem branch, es nem is hazudjuk annak.
    branch = m ? m[1] : (head ? `${head.slice(0, 7)} (leválasztott)` : '')
  } catch { /* nincs HEAD: marad ures */ }

  let remote = ''
  try {
    const conf = readFileSync(join(gitDir, 'config'), 'utf8')
    const m = /\[remote "origin"\][^[]*?url\s*=\s*(.+)/s.exec(conf)
    if (m) remote = m[1].split('\n')[0].trim()
  } catch { /* nincs tavoli: marad ures */ }

  return { root: dir, name: dir.split(/[\\/]/).filter(Boolean).pop() || dir, branch, remote }
}

/** A legkozelebbi repo felfele, vagy `null`. A depo gyokerenel megallunk. */
function findRepo(startDir: string): RepoInfo | null {
  const stop = depotRoot()
  let dir = startDir
  const visited: string[] = []
  for (let i = 0; i < 64; i++) {
    if (repoCache.has(dir)) {
      const hit = repoCache.get(dir)!
      for (const v of visited) repoCache.set(v, hit)
      return hit
    }
    visited.push(dir)
    const found = readRepoAt(dir)
    if (found) {
      for (const v of visited) repoCache.set(v, found)
      return found
    }
    const parent = dirname(dir)
    // A depo folott mar nem keresunk: egy repo, ami a depon KIVUL van, nem
    // ennek a fanak a resze, es a felsetalas a lemez gyokereig csak ido.
    if (parent === dir || (stop && dir === stop)) break
    dir = parent
  }
  for (const v of visited) repoCache.set(v, null)
  return null
}

function gitProvider(): SourceProvider {
  return {
    id: 'git',
    priority: 60,
    label: 'Git repository', short: 'GIT', icon: '🔀',
    detect(abs, isDir) {
      const repo = findRepo(isDir ? abs : dirname(abs))
      if (!repo) return null
      return {
        kind: 'git',
        label: 'Git repository',
        short: 'GIT',
        icon: '🔀',
        details: [
          { label: 'Forrás', value: 'Git repository' },
          { label: 'Repository', value: repo.name },
          ...(repo.branch ? [{ label: 'Branch', value: repo.branch }] : []),
          ...(repo.remote ? [{ label: 'Távoli', value: repo.remote }] : []),
          // A tervben kulon ki van mondva: "A Marvin nem modositja a
          // repository-k sajat dokumentacios reteget." Ezt a felhasznalonak is
          // latnia kell, mert ettol tudja, hogy itt a git az ur, nem a Marveen.
          { label: 'Kezeli', value: 'a git -- a Marveen csak mutatja' },
          { label: 'Helyi útvonal', value: toDisplayPath(abs) },
        ],
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Helyi gep -- a vegso valasz, ami mindig igaz
// ---------------------------------------------------------------------------

function localProvider(): SourceProvider {
  return {
    id: 'local',
    priority: 0,
    label: 'Helyi gép', short: 'HELYI', icon: '💻',
    detect(abs) {
      return {
        kind: 'local',
        label: 'Helyi gép',
        short: 'HELYI',
        icon: '💻',
        details: [
          { label: 'Forrás', value: 'Helyi gép' },
          { label: 'Hely', value: toDisplayPath(abs) },
        ],
      }
    },
  }
}

function registerBuiltinProviders(): void {
  registerSourceProvider(photosProvider())
  registerSourceProvider(driveProvider())
  registerSourceProvider(gitProvider())
  registerSourceProvider(localProvider())
}
registerBuiltinProviders()

/** A vegyes mappa jelvenye. Kulon fuggveny, mert ket helyrol is kell. */
export function mixedSource(kinds: SourceKind[]): SourceInfo {
  return {
    kind: 'mixed',
    label: 'Vegyes tartalom',
    short: 'VEGYES',
    icon: '◉',
    details: [
      { label: 'Forrás', value: 'több helyről származó tartalom' },
      { label: 'Miből áll', value: kinds.join(', ') },
    ],
  }
}

/**
 * Egy fajl vagy mappa forrasa.
 *
 * `deep = false` (az alapertelmezes): csak az utvonalat nezzuk. Ez az, ami egy
 * listazasban minden sorra lefut.
 *
 * `deep = true`: mappanal EGY szintet belenezunk, es ha a gyerekek tobb
 * forrasbol jonnek, `vegyes` a valasz. Szandekosan CSAK egy szint: a teljes
 * fa bejarasa egy nagy mappanal masodpercekbe kerulne, es egy jelvenyert ez
 * nem ar. Amit igy mondunk, az igaz -- csak nem a legmelyebb igazsag --, es a
 * felhasznalo egy kattintassal amugy is lejjebb megy.
 */
export function detectSource(abs: string, isDir: boolean, deep = false): SourceInfo {
  const own = firstMatch(abs, isDir)
  if (!deep || !isDir) return own

  let names: string[] = []
  try { names = readdirSync(abs).filter((n) => !n.startsWith('.')) } catch { return own }
  const kinds = new Set<SourceKind>()
  // Felso hatar: egy 10 000 fajlos mappaban a 40. gyerek utan mar nem tudunk
  // meg semmi ujat, viszont a felulet varna rank.
  for (const n of names.slice(0, 40)) {
    const child = join(abs, n)
    let childIsDir = false
    try { childIsDir = statSync(child).isDirectory() } catch { continue }
    kinds.add(firstMatch(child, childIsDir).kind)
    if (kinds.size > 1) break
  }
  if (kinds.size <= 1) return own
  // VEGYES mappa: NINCS egy tarolo-azonositoja, es ez nem hianyzo adat, hanem
  // a helyes valasz -- tobb tarolobol jon a tartalma. Egyet kivalasztani
  // kozuluk pont az a hazugsag lenne, ami ellen a `vegyes` fajta van.
  return {
    ...mixedSource([...kinds]),
    storageId: null,
    storageType: null,
    storageName: '',
    storageMiss: null,
    physicalPath: toDisplayPath(abs),
    sourceProvider: 'mixed',
  }
}

function firstMatch(abs: string, isDir: boolean): SourceInfo {
  for (const p of providers) {
    let r: SourceInfo | null = null
    // Egy felismero hibaja nem allithatja meg a listazast: a kovetkezot
    // kerdezzuk, es a vegen ott a `local`, ami mindig valaszol.
    try { r = p.detect(abs, isDir) } catch { r = null }
    if (r) return withStorage(r, abs)
  }
  return withStorage(localProvider().detect(abs, isDir)!, abs)
}

/**
 * A 20. pont mezoinek RAAKASZTASA a felismero valaszara.
 *
 * KOZPONTILAG, es nem minden felismeroben kulon -- ket okbol. Egy: igy egy
 * kesobbi tarolo (NAS, OneDrive) is megkapja oket anelkul, hogy errol tudnia
 * kellene; ez ugyanaz a bovithetoseg, amiert a felismerok regiszterben allnak.
 * Ketto: igy nem lehet elfelejteni. Ha minden felismero maga toltene ki, a
 * kovetkezo pontosan ott bukna el, ahol ez a mezo eloszor szamit.
 *
 * A `storageAt` SOSE dob es sosem talalgat: ha nincs kiosztott sorszam, `null`
 * jon vissza egy MEGNEVEZETT okkal, es a felhasznalo azt latja, nem egy
 * kitalalt `DRIVE_01`-et.
 */
function withStorage(info: SourceInfo, abs: string): SourceInfo {
  let m
  try { m = storageAt(abs) } catch { m = null }
  const details = [...info.details]
  if (m && m.id) {
    // A LATHATO azonosito. A 20. pont szerint ez az, ami egy fajlt tartosan
    // a taroloahoz koti -- a mappanev atnevezheto, ez nem.
    details.push({ label: 'Tároló azonosító', value: m.name && m.name !== m.account ? `${m.id} (${m.name})` : m.id })
  } else if (m && m.reason === 'unregistered') {
    details.push({ label: 'Tároló azonosító', value: storageMissText('unregistered') })
  }
  return {
    ...info,
    details,
    storageId: m ? m.id : null,
    storageType: m ? m.kind : null,
    storageName: m ? m.name : '',
    storageMiss: m ? m.reason : null,
    physicalPath: toDisplayPath(abs),
    sourceProvider: info.kind,
  }
}

/** Minden bekotott tarolo -- a felulet ebbol epiti a jelmagyarazatot. */
export function listSourceKinds(): Array<{ id: string; label: string; short: string; icon: string }> {
  const out = providers.map((p) => ({ id: p.id, label: p.label, short: p.short, icon: p.icon }))
  const mixed = mixedSource([])
  out.push({ id: mixed.kind, label: mixed.label, short: mixed.short, icon: mixed.icon })
  return out
}
