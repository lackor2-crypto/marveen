// KULSO TORLES ELLENI VEDELEM -- a specifikacio 6. pontja.
//
// Boss, 2026-08-15: "ami a driv on fent torlodik az nalam megmarad. az helyes.
// mert ha valaki feltori a drivomat akkor a gepemrol ne tudjon torolni."
//
// A szinkron-motor MA SEM torol lefele: a lejovo agban egyetlen `rmSync` sincs.
// Csakhogy ez eddig egy KIMONDATLAN tulajdonsag volt -- semmi nem bizonyitotta,
// es semmi nem szolt, ha megis eltunt valami a Drive-rol. Ket kovetkezmenye
// volt:
//
//   1. Ha valaki (vagy valami) letorolte a Drive-rol a fajljaidat, arrol NEM
//      ertesultel. A helyi peldany megmaradt -- de te sosem tudtad meg, hogy
//      tortent valami.
//   2. Egy kesobbi modositas eszrevetlenul bekapcsolhatta volna a lefele
//      torlest. Egy tulajdonsagot, amit semmi nem ellenoriz, konnyu elveszteni.
//
// Ez a modul mind a kettot orvosolja: NEVEN NEVEZI a kulso valtozast, lemezre
// irja (JSONL, azonnal -- #64), es a felulet meg tudja mutatni. A helyi fajlhoz
// SOSEM nyul: ez a modul nem torol, nem mozgat, nem ir felul semmit.
//
// A NULLA KET DOLGOT JELENTHET. "Nem lattam a Drive-on" ES "letoroltek a
// Drive-rol" ugyanugy nulla talalat -- de teljesen mast jelent. Ezert a
// felismeres CSAK akkor fut le, ha a bejaras TELJES volt; csonka bejarasnal egy
// `kihagyva` sort irunk, hogy latszodjon: ebben a futasban NEM tudtuk
// megnezni. Csonka kepbol "eltunt" kovetkeztetest levonni pontosan az a hiba,
// ami ellen a felmeno ag 2. feke is vedekezik.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { PROJECT_ROOT } from './config.js'
import { logger } from './logger.js'

/**
 * A ket fajl helye. FUGGVENY, nem konstans: a teszteknek sajat, eldobhato
 * mappat kell kapniuk -- kulonben az ELES `store/`-ba irnanak, es a Boss
 * naplojat allitanak at (ez a "a probaszkript az eles depon fut" hiba).
 */
let storeRoot = join(PROJECT_ROOT, 'store')

/** Csak a teszteknek. Eles futasban senki nem hivja. */
export function setExternalStoreDir(dir: string): void {
  storeRoot = dir
}

export function externalPath(): string { return join(storeRoot, 'external-deletions.jsonl') }
function guardPath(): string { return join(storeRoot, 'external-guard.json') }

/**
 * Mi tortent a tavoli oldalon.
 *
 *  - `törlés`:     a fajl a nyilvantartasban benne van, a Drive-on mar nincs.
 *                  A helyi peldany MEGMARAD -- ez a vedelem lenyege.
 *  - `átnevezés`:  a Drive-on atneveztek, es emiatt a helyi peldany is uj nevet
 *                  kapott. Egy bajt sem veszett el, de ez akkor is TAVOLROL
 *                  vezerelt helyi valtozas, ezert latszodnia kell.
 *  - `kihagyva`:   ebben a futasban NEM tudtuk megnezni (csonka bejaras). Nem
 *                  esemeny, hanem a csend magyarazata.
 */
export type ExternalChangeKind = 'törlés' | 'átnevezés' | 'kihagyva'

export interface ExternalChange {
  runId: string
  at: string
  account: string
  /** A paros ember-olvashato neve. */
  pair: string
  pairId: string
  kind: ExternalChangeKind
  /** A Drive-fajlazonosito. `kihagyva`-nal ures. */
  driveId: string
  /** A helyi peldany TELJES utja -- ezt kell megnyitni, ha vissza akarod nezni. */
  localPath: string
  /** A parison beluli relativ ut. */
  relPath: string
  /** Az uj nev (atnevezesnel), kulonben a fajl utolso ismert neve. */
  driveName: string
  /** Emberi mondat: mi tortent es mit jelent. */
  note: string
}

/** Felso hatar, mint a hibalistanal: tullepeskor `.1`-be forog, nem torlodik. */
const MAX_BYTES = 4 * 1024 * 1024

/**
 * A vedelem allapota.
 *
 * ALAPBOL BE. Friss telepitesen nincs `store/external-guard.json`, es a helyes
 * alapertelmezes a vedett allapot -- egy meg el nem vegzett beallitas nem
 * hagyhatja vedtelenul a fajlokat. A kapcsolo azt szabalyozza, FIGYELJUNK-E es
 * jelentsunk-e; a helyi torles KIKAPCSOLVA SEM tortenik meg, mert a lejovo
 * agban egyaltalan nincs torlo hivas.
 */
export function externalGuardEnabled(): boolean {
  try {
    if (!existsSync(guardPath())) return true
    const raw = JSON.parse(readFileSync(guardPath(), 'utf8'))
    return raw?.enabled !== false
  } catch (err: any) {
    // Serult beallitasfajl. NEM kapcsoljuk ki a vedelmet emiatt: egy olvasasi
    // hiba nem lehet ok arra, hogy a fajljaid vedtelenul maradjanak.
    logger.warn({ err: err?.message }, '[external-guard] a beállítás nem olvasható, a védelem BEKAPCSOLVA marad')
    return true
  }
}

export function setExternalGuardEnabled(enabled: boolean): void {
  mkdirSync(dirname(guardPath()), { recursive: true })
  writeFileSync(guardPath(), `${JSON.stringify({ enabled, updatedAt: new Date().toISOString() }, null, 2)}\n`)
}

/** Egy sor a lemezre, AZONNAL. Sose dob: a naplozas nem allithatja meg a szinkront. */
export function recordExternalChange(c: ExternalChange): void {
  try {
    mkdirSync(dirname(externalPath()), { recursive: true })
    if (existsSync(externalPath()) && statSync(externalPath()).size > MAX_BYTES) {
      const regi = `${externalPath()}.1`
      rmSync(regi, { force: true })
      renameSync(externalPath(), regi)
    }
    appendFileSync(externalPath(), `${JSON.stringify(c)}\n`)
  } catch (err: any) {
    logger.warn({ err: err?.message }, '[external-guard] a sort nem tudtam kiírni')
  }
}

export function parseExternalLine(line: string): ExternalChange | null {
  const t = line.trim()
  if (!t) return null
  try {
    const o = JSON.parse(t)
    if (!o || typeof o !== 'object' || typeof o.kind !== 'string') return null
    return o as ExternalChange
  } catch {
    // Egy csonka sor (leallas iras kozben) nem viheti el a tobbit.
    return null
  }
}

export interface ExternalLoad {
  list: ExternalChange[]
  /** Letezik-e egyaltalan a naplo. Enelkul az ures lista ket dolgot jelentene. */
  fileExists: boolean
  /** Ha a naplot nem lehetett elolvasni: a TENYLEGES hibauzenet. Sosem tipp. */
  readError: string
}

export function loadExternalChanges(opts: { limit?: number; kind?: ExternalChangeKind } = {}): ExternalLoad {
  const limit = opts.limit ?? 200
  if (!existsSync(externalPath())) return { list: [], fileExists: false, readError: '' }
  let raw = ''
  try {
    raw = readFileSync(externalPath(), 'utf8')
  } catch (err: any) {
    return { list: [], fileExists: true, readError: String(err?.message || err) }
  }
  const list: ExternalChange[] = []
  for (const line of raw.split('\n')) {
    const c = parseExternalLine(line)
    if (!c) continue
    if (opts.kind && c.kind !== opts.kind) continue
    list.push(c)
  }
  list.reverse()
  return { list: list.slice(0, limit), fileExists: true, readError: '' }
}

export function clearExternalChanges(): void {
  rmSync(externalPath(), { force: true })
}

/**
 * Amit egy futas vegen tudunk a tavoli oldalrol.
 *
 * `tracked`: amit a nyilvantartas szerint korabban lehoztunk (fajlazonosito ->
 * helyi relativ ut). `seen`: amit MOST lattunk a Drive-on. A ketto kulonbsege
 * a kulso torles -- DE csak akkor, ha `complete`.
 */
export interface ScanInput {
  runId: string
  account: string
  pair: string
  pairId: string
  base: string
  tracked: Map<string, string>
  seen: Set<string>
  /** `true`, ha a bejaras TELJES volt. Csonka kepbol nem kovetkeztetunk. */
  complete: boolean
  /** Miert nem volt teljes -- a TENYLEGES okok, nem talalgatas. */
  incompleteReason: string
}

/**
 * Kulso torlesek felismerese es naplozasa. Visszaadja, hany fajlt talalt.
 *
 * A helyi fajlhoz NEM nyul. Ha a helyi peldany maga sincs meg (te torolted a
 * gepen), az nem kulso torles -- azt a felmeno ag mar elintezte, es nem irunk
 * rola sort.
 */
export function noteExternalScan(a: ScanInput): { deleted: number; skipped: boolean } {
  if (!externalGuardEnabled()) return { deleted: 0, skipped: false }
  const at = new Date().toISOString()
  if (!a.complete) {
    recordExternalChange({
      runId: a.runId, at, account: a.account, pair: a.pair, pairId: a.pairId,
      kind: 'kihagyva', driveId: '', localPath: '', relPath: '', driveName: '',
      note: `A Drive bejárása hiányos maradt (${a.incompleteReason || 'ismeretlen ok'}), ezért ebben a futásban NEM néztem meg, törölt-e valaki fájlt a Drive-on. A gépeden lévő fájlokhoz így sem nyúlt hozzá semmi.`,
    })
    return { deleted: 0, skipped: true }
  }
  let deleted = 0
  for (const [driveId, rel] of a.tracked) {
    if (a.seen.has(driveId)) continue
    const abs = join(a.base, rel)
    // A helyi peldany hianya nem kulso torles: azt te torolted, es a felmeno
    // ag vitte fel a Kukaba. Errol nem szabad riasztani.
    if (!existsSync(abs)) continue
    deleted++
    recordExternalChange({
      runId: a.runId, at, account: a.account, pair: a.pair, pairId: a.pairId,
      kind: 'törlés', driveId, localPath: abs, relPath: rel,
      driveName: rel.split(/[\\/]/).pop() || rel,
      note: 'A Drive-on már nincs meg, a gépeden viszont MEGMARADT. Nem töröltem le – ha tényleg nem kell, a gépeden töröld.',
    })
  }
  return { deleted, skipped: false }
}

/** Emberi osszefoglalo a feluletnek. */
export function externalSummaryText(load: ExternalLoad, lang = 'hu'): string {
  const hu = lang !== 'en'
  if (load.readError) {
    return hu
      ? `A napló nem olvasható: ${load.readError}`
      : `The log cannot be read: ${load.readError}`
  }
  if (!load.fileExists) {
    return hu
      ? 'Még nem futott olyan szinkron, amelyik ezt figyelte volna – ezért üres, nem azért, mert nem történt semmi.'
      : 'No sync run has watched this yet — that is why it is empty, not because nothing happened.'
  }
  const torles = load.list.filter(c => c.kind === 'törlés').length
  const kihagy = load.list.filter(c => c.kind === 'kihagyva').length
  if (!torles && kihagy) {
    return hu
      ? `Nem találtam kívülről törölt fájlt, de ${kihagy} futásban nem is tudtam megnézni (hiányos bejárás).`
      : `No externally deleted files found, but ${kihagy} run(s) could not check (incomplete traversal).`
  }
  if (!torles) {
    return hu
      ? 'Nem törölt senki fájlt a Drive-on a legutóbbi futások óta.'
      : 'Nobody deleted files on Drive since the recent runs.'
  }
  return hu
    ? `${torles} fájlt töröltek a Drive-on – a gépeden mind megvan.`
    : `${torles} file(s) were deleted on Drive — all of them are still on your machine.`
}
