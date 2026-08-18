// Google Fotok a Marveenben -- Boss 2026-08-14: "a fotok alatt a google
// fotokat akarom latni. csakis azokat."
//
// AMI MERT KORLAT, es amiert ez a modul igy nez ki:
// A Google a `photoslibrary.readonly` scope-ot 2025-03-31-en visszavonta. Azota
// a Library API CSAK azt latja, amit maga az alkalmazas toltott fel -- a
// telefonon levo kepeket nem lehet vegigbongeszni, semmilyen hivassal. Ezt
// meg is mertuk: a mostani tokennel a Picker-vegpont 403
// PERMISSION_DENIED / "insufficient authentication scopes".
//
// Az EGYETLEN elo ut a Picker API: a felhasznalo a Google sajat feluleten
// kivalasztja a kepeket, es mi csak azokat kapjuk meg.
//
// A masodik korlat, ami az egesz tarolast meghatarozza: a kivalasztott kepek
// `baseUrl`-je 60 PERCIG el. Ha csak a session-t tartanank, egy ora mulva az
// egesz oldal ures lenne. Ezert a valasztas utan AZONNAL lehozzuk a bajtokat a
// lemezre (store/photos/<fiok>/), es a Fotok oldal onnan bongeszi oket --
// hatarozatlan ideig, halozat nelkul is.
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, statSync, rmSync, readdirSync,
  createReadStream, createWriteStream, renameSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { join, dirname } from 'node:path'
import { execFile } from 'node:child_process'
import { PROJECT_ROOT } from '../../config.js'
import { depotAccountDir, depotHealth, resolvePhotoDir, DEPOT_PHOTOS, DEPOT_ACCOUNTS, DEPOT_SYSTEM, depotRoot } from '../../depot.js'
import { readBody, json } from '../http-helpers.js'
import { logger } from '../../logger.js'
import { googleAccountNames } from './accounts.js'
import type { RouteContext } from './types.js'

const SESSIONS_URL = 'https://photospicker.googleapis.com/v1/sessions'
const MEDIA_ITEMS_URL = 'https://photospicker.googleapis.com/v1/mediaItems'
export const PICKER_SCOPE = 'https://www.googleapis.com/auth/photospicker.mediaitems.readonly'

/** A lementett kepek REGI helye. Fiokonkent kulon konyvtar. */
const PHOTOS_DIR = join(PROJECT_ROOT, 'store', 'photos')
const INDEX_PATH = join(PHOTOS_DIR, 'index.json')

// --- Hol vannak a kepek: a depoban vagy meg a regi helyen? ---
//
// Az atkoltozes NEM egy pillanat: 8 GB masolasa percekig tart, es a felhasznalo
// kozben is megnyithatja az oldalt, sot a gep is ujraindulhat. Ezert nincs
// olyan pillanat, amikor "mostantol a depo" -- minden kerdesre a LEMEZ valaszol:
// ahol a fajl valoban megvan, az a helye. Igy egy felbeszakadt koltozes utan sem
// tunik el egyetlen kep sem, csak ketfele lesz szetosztva.

/** A fiok kepeinek regi helye (a telepitesi mappan belul). */
export function legacyPhotoDir(account: string): string {
  return join(PHOTOS_DIR, safeAccountDir(account))
}

/** A fiok kepeinek helye a depoban. `null`, ha nincs depo beallitva. */
export function depotPhotoDir(account: string): string | null {
  return depotAccountDir(account, DEPOT_PHOTOS)
}

/** Ahol a fiok kepei MOST vannak: a depo, ha mar oda kerultek, kulonben a regi hely. */
export function photoDir(account: string): string {
  return resolvePhotoDir(account, legacyPhotoDir(account))
}

/**
 * Ahol az UJ kepek keletkeznek.
 *
 * Ha van elerheto depo, oda -- akkor is, ha a regi helyen meg ottall a korabbi
 * allomany. Nem varunk az atkoltoztetesre: ami mostantol jon, az mar jo helyre
 * kerul, a regi kepek pedig tovabbra is lathatoak maradnak (lasd
 * `photoFilePath`).
 */
export function photoWriteDir(account: string): string {
  const d = depotPhotoDir(account)
  if (d && depotHealth().writable) return d
  return legacyPhotoDir(account)
}

/**
 * Egy KONKRET fajl helye: ahol valoban megvan.
 *
 * Eloszor a depo, aztan a regi hely. Ez az a pont, ami miatt egy felbeszakadt
 * koltozes nem tesz kart: a mar atkoltozott kepek a depobol, a tobbi a regi
 * helyrol jon, es a felhasznalo ebbol semmit nem vesz eszre.
 */
export function photoFilePath(account: string, file: string): string {
  const d = depotPhotoDir(account)
  if (d) {
    const cand = join(d, file)
    try { if (existsSync(cand)) return cand } catch { /* nem erheto el: marad a regi */ }
  }
  return join(legacyPhotoDir(account), file)
}

/** Mindket lehetseges hely -- torlesnel es osszesitesnel kell. */
export function photoDirsFor(account: string): string[] {
  const d = depotPhotoDir(account)
  const legacy = legacyPhotoDir(account)
  return d ? [d, legacy] : [legacy]
}

/** Egy kepet ekkora hosszabbik oldallal mentunk le. */
export const SAVE_WIDTH = 1600

export interface StoredPhoto {
  id: string
  account: string
  file: string
  mimeType: string
  /** A Google szerinti keszitesi ido (ISO), ha van -- ez rendezi az oldalt. */
  createdTime: string
  width: number
  height: number
  isVideo: boolean
  bytes: number
  /** Mikor hoztuk le (ISO). */
  savedAt: string
  /**
   * A bajtok SHA-256 lenyomata. EZ donti el, hogy ket elem "teljesen egyforma"-e
   * -- fotonal es videonal ugyanugy, mert a bajtokat nezi, nem a tipust.
   * A regi bejegyzesekben meg nincs; azokat elso hasznalatkor potoljuk.
   */
  sha256?: string
  /**
   * Ha a bajtok egy MASIK fiok konyvtaraban vannak. Akkor kerul bele, ha
   * ugyanaz a kep ket fioknal is szerepel: mindket fiok alatt latszik, de a
   * lemezen egyetlen peldany van belole.
   */
  fileAccount?: string
}

/**
 * A kep "azonossaga" a bongeszo fele (ETag).
 *
 * Elsosorban a TARTALOM lenyomata, ami mar amugy is megvan az indexben -- ket
 * egyforma kep igy ugyanazt az erteket kapja, es a masodikat a bongeszo a sajat
 * tarabol veszi elo. Regi, lenyomat nelkuli sornal a fajl merete+ideje a
 * tartalek; ha meg az sem olvashato, inkabb NINCS ETag, mint egy hazug.
 */
export function photoETag(entry: Pick<StoredPhoto, 'sha256'>, file: string): string {
  if (entry.sha256) return `"${entry.sha256}"`
  try {
    const s = statSync(file)
    return `"m${s.size}-${Math.round(s.mtimeMs)}"`
  } catch {
    return ''
  }
}

/**
 * Az `If-None-Match` fejlecbol az az ertek, amit ossze tudunk hasonlitani.
 *
 * A bongeszo tobb erteket is kuldhet, es a kozbeeso allomasok `W/` (gyenge)
 * eloteget tehetnek ra. Csak akkor felelunk 304-gyel, ha az ELSO ertek egyezik
 * -- tulzott ugyeskedes helyett inkabb kikuldunk egy kepet feleslegesen.
 */
export function requestETag(header: string | string[] | undefined): string {
  const raw = Array.isArray(header) ? header[0] : header
  if (!raw) return ''
  const first = raw.split(',')[0].trim()
  return first.startsWith('W/') ? first.slice(2) : first
}

/** Melyik fiok konyvtaraban vannak a bajtok. Regi bejegyzesnel a sajatjaban. */
export function photoFileOwner(p: Pick<StoredPhoto, 'account' | 'fileAccount'>): string {
  return p.fileAccount || p.account
}

/** A "teljesen egyforma" merteke. Nem a nev, nem a meret: a tartalom. */
export function sha256Bytes(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

// ---------------------------------------------------------------------------
// Bolyegkepek
//
// Boss, 2026-08-15: "nem lehet hogy amikor a fotok ilyen kicsibe megjelennek
// akkor kisebb meretet foglaljanak? csak ha megnyitom nagyba akkor hasznalja a
// teljes minoseget?"
//
// De igen -- es ez a legnagyobb tetel az egesz oldalon. Mert (2026-08-15-i
// meres a sajat tarunkon): 342 kep = 110 MB, de 36 VIDEO = 6985 MB, koztuk egy
// 1807 MB-os. A racs eddig MINDEN fajlt teljes meretben lehozott, csak hogy egy
// kis negyzetet rajzoljon: egyetlen vegiggorgetes 7 GB. Bolyegkeppel ugyanez
// ~16 MB.
//
// Atmeretezo npm-csomagunk nincs (se sharp, se jimp), viszont a gepen VAN
// ffmpeg, es az mindket bajt elvegzi: kepet kicsinyit, videobol kockat vesz.
// Meres az 1807 MB-os videon: 0,15 mp, mert nem olvassa vegig a fajlt.
// ---------------------------------------------------------------------------

/** A bolyegkep hosszabbik oldala keppontban. */
export const THUMB_WIDTH = 480
/** A bolyegkepek helye a fiok konyvtaran belul. Ponttal kezdodik, ezert a
 *  takarito seprusok (`.part`- es arva-fajl) eleve nem nyulnak hozza. */
export const THUMB_DIRNAME = '.thumbs'
/** Egyszerre ennyi ffmpeg futhat -- a gep ne alljon meg egy gorgetestol. */
const THUMB_PARALLEL = 2
const THUMB_TIMEOUT_MS = 20_000
/** Videonal innen vesszuk a kockat; a legelso kocka gyakran fekete. */
const THUMB_SEEK_SEC = 1

/** A bolyegkep fajlneve. A tartalom lenyomatabol, hogy ket egyforma kep
 *  egyetlen bolyeget hasznaljon; regi, lenyomat nelkuli sornal a fajlnevbol. */
export function thumbFileName(entry: Pick<StoredPhoto, 'sha256' | 'file'>): string {
  const base = entry.sha256 || entry.file
  return `${base.replace(/[^a-zA-Z0-9._-]/g, '_')}.jpg`
}

/**
 * Az ffmpeg parancssora.
 *
 * A `scale` szurot IDEZOJELEZNI kell (`'min(480,iw)'`), mert a benne levo
 * vesszo kulonben szurolancot valaszt el. Shell nelkul (execFile) mertem:
 * idezojel nelkul "No such filter: 'iw):-2'". Az idezojeles alak ezen kivul
 * NEM nagyit fel: egy 120x90-es kep 120x90 marad (a `force_original_aspect_
 * ratio=decrease` felnagyitotta volna 480x360-ra).
 *
 * A `-2` magassag azt jelenti: aranyos, es paros szam (a jpeg-kodolo keri).
 */
export function thumbArgs(input: string, out: string, isVideo: boolean, seekSec: number): string[] {
  const seek = isVideo && seekSec > 0 ? ['-ss', String(seekSec)] : []
  return [
    '-hide_banner', '-loglevel', 'error',
    ...seek,
    '-i', input,
    '-frames:v', '1',
    '-vf', `scale='min(${THUMB_WIDTH},iw)':-2`,
    '-q:v', '5',
    // A formatumot KI KELL mondani. Az ffmpeg alapbol a kiterjesztesbol talalja
    // ki, a keszulo bolyeg viszont `.jpg.tmp` neven irodik (hogy egy felbeszakadt
    // futas ne hagyjon fel-kepet a vegleges neven) -- es arra azt mondja:
    // "Unable to choose an output format" (merve).
    '-f', 'image2',
    '-y', out,
  ]
}

/** Van-e egyaltalan ffmpeg a gepen? Egyszer nezzuk meg, aztan megjegyezzuk. */
let ffmpegOk: Promise<boolean> | null = null
export function resetFfmpegProbe(): void { ffmpegOk = null }

function haveFfmpeg(): Promise<boolean> {
  if (!ffmpegOk) {
    ffmpegOk = new Promise<boolean>((resolve) => {
      execFile('ffmpeg', ['-version'], { timeout: 5_000 }, (err) => {
        if (err) logger.warn('[photos] nincs ffmpeg: a racs a teljes meretu kepeket kapja')
        resolve(!err)
      })
    })
  }
  return ffmpegOk
}

// Egyszerre legfeljebb THUMB_PARALLEL ffmpeg. A tobbi sorban all.
let thumbRunning = 0
const thumbQueue: Array<() => void> = []

function thumbSlot(): Promise<void> {
  if (thumbRunning < THUMB_PARALLEL) { thumbRunning++; return Promise.resolve() }
  return new Promise((resolve) => thumbQueue.push(resolve))
}

function releaseThumbSlot(): void {
  const next = thumbQueue.shift()
  if (next) next()
  else thumbRunning--
}

/**
 * Egy ffmpeg-futas. `true`, ha VALOBAN lett kimenet.
 *
 * Fontos: az ffmpeg tud 0-val kilepni ugy, hogy NEM keszult fajl -- pontosan ez
 * tortenik, ha egy 0,4 masodperces videoban az 1. masodpercre tekerunk (mertem).
 * Ezert a kilepokod nem eleg, a fajl letet is meg kell nezni.
 */
// Hany ffmpeg indult el osszesen. CSAK meresre: ebbol latszik, hogy a
// gorgeteskor ugyanarra a kepre erkezo tobb keres EGY munkat inditott-e.
let thumbRuns = 0
export function thumbRunCount(): number { return thumbRuns }
export function resetThumbRunCount(): void { thumbRuns = 0 }

function runFfmpeg(args: string[], out: string): Promise<boolean> {
  thumbRuns++
  return new Promise((resolve) => {
    execFile('ffmpeg', args, { timeout: THUMB_TIMEOUT_MS }, (err) => {
      if (err) { resolve(false); return }
      resolve(existsSync(out) && statSync(out).size > 0)
    })
  })
}

// Ha ugyanarra a bolyegre egyszerre tobb kerés jon (gorgetes!), csak EGY
// ffmpeg induljon, a tobbi ugyanarra a munkara varjon.
const thumbInFlight = new Map<string, Promise<string | null>>()

/**
 * A bolyegkep utvonala -- ha kell, most keszul el. `null`, ha nem sikerult
 * (nincs ffmpeg, vagy nem tudja megnyitni a fajlt).
 */
export async function ensureThumb(
  file: string, dir: string, entry: Pick<StoredPhoto, 'sha256' | 'file' | 'isVideo'>,
): Promise<string | null> {
  const out = join(dir, THUMB_DIRNAME, thumbFileName(entry))
  if (existsSync(out) && statSync(out).size > 0) return out
  if (!(await haveFfmpeg())) return null

  const running = thumbInFlight.get(out)
  if (running) return running

  const work = (async (): Promise<string | null> => {
    await thumbSlot()
    try {
      mkdirSync(join(dir, THUMB_DIRNAME), { recursive: true })
      // Felbeszakadt futas ne hagyjon fel-fajlt a vegleges neven.
      const tmp = `${out}.tmp`
      let ok = await runFfmpeg(thumbArgs(file, tmp, !!entry.isVideo, THUMB_SEEK_SEC), tmp)
      // Rovid videonal az 1. masodperc mar a vegen tul van: ilyenkor a legelso
      // kocka is jobb, mint a semmi.
      if (!ok && entry.isVideo) ok = await runFfmpeg(thumbArgs(file, tmp, true, 0), tmp)
      if (!ok) { try { rmSync(tmp, { force: true }) } catch { /* nem volt */ } return null }
      renameSync(tmp, out)
      return out
    } catch (err: any) {
      logger.debug({ err: err?.message, file }, '[photos] bolyegkep nem keszult el')
      return null
    } finally {
      releaseThumbSlot()
      thumbInFlight.delete(out)
    }
  })()

  thumbInFlight.set(out, work)
  return work
}

// ---------------------------------------------------------------------------
// Tiszta segedfuggvenyek (kulon tesztelhetok, halozat nelkul)
// ---------------------------------------------------------------------------

/**
 * Van-e a fioknak Fotok-jogosultsaga?
 *
 * A refresh_token scope-halmaza a JOVAHAGYASKOR dol el es kesobb nem bovul:
 * egy regebben bekotott fiok tokenje ervenyes marad, de a Picker-hivas 403-at
 * ad. Ezt ELORE meg akarjuk mondani a felhasznalonak, nem nyers 403-kent.
 */
export function hasPickerScope(entry: unknown): boolean {
  if (!entry || typeof entry !== 'object') return false
  const scope = (entry as { scope?: unknown }).scope
  if (typeof scope !== 'string') return false
  return scope.split(/\s+/).includes(PICKER_SCOPE)
}

/**
 * A Picker mediaItem-je -> a mi alakunk.
 *
 * A Google mezonevei valtoztak mar (mediaFile/mediaFileMetadata), es a video
 * metaadat kulon agon jon; ami hianyzik, az legyen 0/ures, ne `undefined`,
 * mert a rendezes es a racs-elrendezes szamokat var.
 */
export type NormalizedPhoto = Omit<StoredPhoto, 'file' | 'bytes' | 'savedAt'>

export function normalizeMediaItem(raw: any, account: string): NormalizedPhoto | null {
  if (!raw || typeof raw !== 'object') return null
  const id = typeof raw.id === 'string' ? raw.id : ''
  const mf = raw.mediaFile || {}
  const meta = mf.mediaFileMetadata || {}
  const mimeType = typeof mf.mimeType === 'string' ? mf.mimeType : ''
  if (!id || !mimeType) return null
  return {
    id,
    account,
    mimeType,
    createdTime: typeof raw.createTime === 'string' ? raw.createTime : '',
    width: Number(meta.width) || 0,
    height: Number(meta.height) || 0,
    isVideo: mimeType.startsWith('video/') || !!meta.videoMetadata,
  }
}

/**
 * A megjelenitesi meretu kep URL-je.
 *
 * A `baseUrl` onmagaban NEM toltheto le -- meretjelolest kell a vegere tenni
 * (`=w<szel>-h<mag>`), videonal `=dv`. Ez a Picker API dokumentalt szabalya,
 * es a leggyakoribb hiba, hogy valaki a nyers baseUrl-t probalja lehozni.
 */
export function mediaBytesUrl(baseUrl: string, isVideo: boolean, width = SAVE_WIDTH): string {
  const clean = String(baseUrl || '')
  if (!clean) return ''
  return isVideo ? `${clean}=dv` : `${clean}=w${width}-h${width}`
}

/**
 * SSRF-kapu: a baseUrl a Google valaszabol jon, de akkor is ellenorizzuk,
 * mielott a SZERVER lekeri -- a szerver a belso halon van.
 */
export function isAllowedPhotosUrl(u: string): boolean {
  try {
    const parsed = new URL(u)
    if (parsed.protocol !== 'https:') return false
    return /(^|\.)(googleusercontent\.com|googleapis\.com)$/.test(parsed.hostname)
  } catch {
    return false
  }
}

/**
 * Fajlnev a lemezre. A mediaItem id a Google-tol jon: ha valaha tartalmazna
 * `/`-t vagy `..`-t, a konyvtaron kivulre irnank. Ezert NEM az id lesz a nev,
 * hanem annak biztonsagos alakja.
 */
export function safePhotoFileName(id: string, mimeType: string): string {
  const slug = String(id || '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120) || 'kep'
  const ext = mimeType.startsWith('video/') ? 'mp4' : (mimeType === 'image/png' ? 'png' : 'jpg')
  return `${slug}.${ext}`
}

/** Fiok-kulcs a lemezen: ugyanaz a szigor, mint a fajlnevnel. */
export function safeAccountDir(account: string): string {
  return String(account || '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || 'default'
}

/**
 * Legujabb elol. Aminek nincs keszitesi ideje, az a lementes ideje szerint
 * sorolodik -- kulonben a datum nelkuli kepek mindig a lista vegere esnenek.
 */
export function sortPhotos(list: StoredPhoto[]): StoredPhoto[] {
  return [...list].sort((a, b) => (b.createdTime || b.savedAt).localeCompare(a.createdTime || a.savedAt))
}

/**
 * Egyforma elemek kiszurese az indexbol -- Boss, 2026-08-15: "duplikatumokat
 * ne toltson le. le se toltse. vagy ha letolti utana torolje ha teljesen
 * egyforma. videobol is meg fotobol is."
 *
 * KET eset van, es szandekosan MASKENT jarunk el veluk:
 *
 *  - UGYANAZ A FIOK. Ket sor, azonos bajtok (pl. a kepet ujra feltoltottek, igy
 *    mas az azonositoja). Ez a felhasznalonak ket egyforma csempe ugyanott --
 *    a masodik sor eltunik, a fajlja torlodik.
 *  - KET KULONBOZO FIOK. Ugyanaz a csaladi kep ket bekotott fioknal. A sor
 *    MEGMARAD (mindenki lassa a sajat fiokja alatt), de a bajtok csak egyszer
 *    vannak a lemezen: a masodik sor az elso fajljara mutat.
 *
 * Lenyomat nelkuli (regi) sort nem bantunk: azokrol nem tudjuk, egyformak-e.
 * A fuggveny tiszta -- a lemezhez nem nyul, igy onmagaban is kimerheto.
 */
export function dedupeIndex(list: StoredPhoto[]): {
  keep: StoredPhoto[]
  removeFiles: Array<{ account: string; file: string }>
  dropped: number
} {
  const firstByHash = new Map<string, StoredPhoto>()
  const keep: StoredPhoto[] = []
  let dropped = 0
  const before = new Set(list.map((p) => `${photoFileOwner(p)}/${p.file}`))
  for (const p of list) {
    const h = p.sha256
    if (!h) { keep.push(p); continue }
    const first = firstByHash.get(h)
    if (!first) { firstByHash.set(h, p); keep.push(p); continue }
    if (first.account === p.account) { dropped++; continue }
    keep.push({ ...p, file: first.file, fileAccount: photoFileOwner(first) })
  }
  // Csak az a fajl torolheto, amire a MEGMARADO sorok kozul mar egy sem mutat.
  const kept = new Set(keep.map((p) => `${photoFileOwner(p)}/${p.file}`))
  const removeFiles = [...before]
    .filter((k) => !kept.has(k))
    .map((k) => ({ account: k.slice(0, k.indexOf('/')), file: k.slice(k.indexOf('/') + 1) }))
  return { keep, removeFiles, dropped }
}

/**
 * Tenyleges lemezfoglalas. A kozos fajlt EGYSZER szamoljuk: kulonben a "mennyi
 * helyet foglal" tobbet mutatna, mint amennyi valojaban elmegy.
 */
export function uniqueBytes(list: StoredPhoto[]): number {
  const seen = new Set<string>()
  let total = 0
  for (const p of list) {
    const key = `${photoFileOwner(p)}/${p.file}`
    if (seen.has(key)) continue
    seen.add(key)
    total += p.bytes || 0
  }
  return total
}

/** Ember-olvashato meret. A Fotok oldal ezzel mutatja, mennyi helyet foglal. */
export function humanBytes(n: number): string {
  const v = Number(n) || 0
  if (v < 1024) return `${v} B`
  if (v < 1024 * 1024) return `${Math.round(v / 1024)} KB`
  if (v < 1024 * 1024 * 1024) return `${(v / (1024 * 1024)).toFixed(1)} MB`
  return `${(v / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

// ---------------------------------------------------------------------------
// Tarolas
// ---------------------------------------------------------------------------

/**
 * Beolvasott index, a fajl "ujjlenyomataval" (meret + modositasi ido).
 *
 * A racs betoltesekor kepenkent egy keres erkezik, es MINDEGYIK az indexbol
 * keresi ki a fajlnevet -- 378 kepnel ez 378 teljes JSON-elemzes ugyanarrol a
 * fajlrol. A gyorsitotar ezt egyetlen elemzesre csokkenti, es amint barki ir az
 * indexbe (letoltes, torles), a meret vagy az ido valtozik, tehat maganak
 * ujraolvassa. Nem "elavulhat": a lemezhez merjuk, nem az idohoz.
 */
let indexCache: { key: string; list: StoredPhoto[] } | null = null

/** A fajl ujjlenyomata; ha barmi valtozott rajta, mas erteket ad. */
function indexStamp(): string {
  try {
    const s = statSync(INDEX_PATH)
    return `${s.size}:${s.mtimeMs}`
  } catch {
    return 'nincs'
  }
}

/** Csak a teszteknek: a gyorsitotar eldobasa. */
export function clearIndexCache(): void {
  indexCache = null
}

export function loadIndex(): StoredPhoto[] {
  if (!existsSync(INDEX_PATH)) return []
  const key = indexStamp()
  // MASOLAT megy vissza: a hivok rendezik, szurik, bovitik a kapott listat --
  // a gyorsitotar sajat peldanyat ez nem forgathatja fel. (Sekely masolat: az
  // elemeket modosito hivo mindig ir is, es az iras eldobja a gyorsitotarat.)
  if (indexCache && indexCache.key === key) return indexCache.list.slice()
  try {
    const d = JSON.parse(readFileSync(INDEX_PATH, 'utf-8'))
    const list = Array.isArray(d) ? d : []
    indexCache = { key, list }
    return list.slice()
  } catch {
    // Serult index nem torolheti el a kepeket: ures listaval indulunk, a
    // fajlok a lemezen maradnak.
    logger.warn('[photos] serult index.json, ures listaval indulok')
    return []
  }
}

function saveIndex(list: StoredPhoto[]): void {
  mkdirSync(PHOTOS_DIR, { recursive: true })
  const text = JSON.stringify(list, null, 2)
  writeFileSync(INDEX_PATH, text)
  mirrorIndexToDepot(text)
}

/**
 * Masolat az indexrol a depoba.
 *
 * A kepek maguk a depoban vannak, de az index (melyik kep melyik fiokhoz
 * tartozik, mikor keszult) a telepitesi mappaban. Aki csak a depot menti el --
 * es a Boss eppen ezert akarta egy helyre: "ha biztonsagi mentest kellene
 * csinalni [...] egy komuvesnek ez bonyolult" --, az a kepeket megkapna, de
 * nem tudna, mik azok.
 *
 * Ez MASOLAT, nem masodik igazsag: a Marveen SOHA nem ebbol olvas. Egy
 * elerhetetlen depo emiatt nem allithatja meg a mentest, ezert nyeli el a hibat.
 */
function mirrorIndexToDepot(text: string): void {
  const root = depotRoot()
  if (!root) return
  try {
    const dir = join(root, DEPOT_SYSTEM)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'fotok-index.json'), text)
  } catch { /* a depo eppen nem erheto el -- a valodi index mar kiirodott */ }
}

function getAccessToken(account?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = [join(PROJECT_ROOT, 'scripts', 'google-auth.py'), 'token']
    if (account) args.push(account)
    execFile('python3', args, { timeout: 15_000 }, (err, stdout, stderr) => {
      if (err || !stdout.trim()) {
        reject(new Error((stderr || err?.message || 'nincs access_token').trim().slice(0, 200)))
        return
      }
      resolve(stdout.trim())
    })
  })
}

function tokenEntry(account: string): unknown {
  const p = join(PROJECT_ROOT, 'store', 'google-tokens.json')
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf-8'))[account] ?? null
  } catch {
    return null
  }
}

/**
 * A Google 403-nak hivja azt is, ha a fiokkal minden rendben, csak a PROJEKTBEN
 * nincs bekapcsolva maga a Picker API ("has not been used in project ... before
 * or it is disabled"). Ez nem engedely-hiba: ujra-bejelentkeztetessel sosem
 * oldodik meg, egy kapcsolot kell atbillenteni a Google Console-ban. Ha ezt nem
 * ismerjuk fel, a felhasznalo egy nyers JSON-t kap, es a rossz helyen probal
 * javitani (2026-08-15, Boss: "Picker API 403: ...").
 *
 * A visszaadott linket MI epitjuk, csupa szamjegybol: a hibauzenet a Google-tol
 * jovo KULSO adat, es abbol kimasolt cimet linkkent visszaadni nem szabad.
 */
export function pickerApiDisabled(message: string): { projectNumber: string; url: string } | null {
  if (!/SERVICE_DISABLED|has not been used in project|API has not been used|it is disabled/i.test(message)) return null
  const m = /project[=/\s"']*(\d{4,})/i.exec(message)
  const projectNumber = m ? m[1] : ''
  const base = 'https://console.cloud.google.com/apis/library/photospicker.googleapis.com'
  return { projectNumber, url: projectNumber ? `${base}?project=${projectNumber}` : base }
}

/**
 * A HARMADIK hibafajta, ami semmi kozos nincs a masik kettovel: a fiok jo, az
 * engedely megvan, az API be van kapcsolva -- csak ezzel a Google-fiokkal soha
 * senki nem hasznalta meg a Google Fotokat, igy nincs is mit valasztani belole.
 * A Google ilyenkor 400 FAILED_PRECONDITION-t ad ("The user must have a Google
 * Photos account to perform that action", 2026-08-15, Boss).
 *
 * Kulon kell kezelni, mert a teendo is teljesen mas: se ujra-bejelentkezes, se
 * Console-kapcsolo nem segit -- a photos.google.com-ot kell egyszer megnyitni
 * AZZAL a fiokkal. Tiz bekotott fioknal ez varhato eset, nem kivetel.
 *
 * A felismeres az uzenet SZOVEGERE megy, mert a 400-as statuszt sok minden mas
 * is okozhatja; a nevezetes mondatot viszont csak ez adja.
 */
export function pickerNoPhotosAccount(message: string): boolean {
  const m = String(message || '')
  if (!/google photos account/i.test(m)) return false
  return /FAILED_PRECONDITION/i.test(m) || /must have|set(?:s|ting)? up/i.test(m)
}

/**
 * A NEGYEDIK hibafajta: a session mar nincs meg (404 ENTITY_NOT_FOUND).
 *
 * Ketfelekeppen jutunk ide, es egyik sem elromlott rendszer:
 *  - a valaszto ablakot a felhasznalo nem fejezte be, es a session lejart;
 *  - vagy mi magunk engedtuk el, miutan a kepek mar lejottek -- egy kesobb
 *    beeso kerdezes ekkor mar semmit nem talal.
 * A masodikat a hivo oldalon szuntettuk meg (egyszerre egy kor + sorszam), de
 * a Google akkor is adhatja ezt a valaszt, es a felhasznalonak nem nyers
 * 404-et kell latnia, hanem azt, hogy kezdje ujra.
 */
export function pickerSessionGone(message: string): boolean {
  const m = String(message || '')
  return /ENTITY_NOT_FOUND|entity you requested does not exist/i.test(m)
}

/**
 * Egy session behozatala EGYSZER fut le, akkor is, ha tobb kerdezes esik be.
 *
 * A kepek lehozasa percekig tarthat; ha kozben egy masodik keres is nekiallna,
 * ugyanazt toltene le megegyszer, es a ket futas versenyezne az indexert. Ezert
 * a futas igerete kulcs szerint eltevodik: a masodik keres ugyanazt VARJA MEG,
 * es ugyanazt a valaszt kapja -- meg akkor is, ha kozben a session mar elszallt.
 */
export interface DownloadResult {
  saved: number
  failed: number
  /** Most kihagyott, mar meglevo bajtokkal azonos elem. */
  duplicates: number
  /** Korabbrol ottmaradt egyforma, amit ez a futas takaritott ki. */
  cleaned: number
  /**
   * Hany elemet kaptunk a Picker-tol -- vagyis mennyit jelolt ki a felhasznalo.
   *
   * (Boss, 2026-08-16: "kijeloltem 194-et... a vegen azt irta ki hogy sikerult.
   * de a fotokba nem jott le semmilyen foto.") A `saved: 0` onmagaban NEM mondja
   * meg, hogy nulla kijelolt kepbol lett nulla, vagy 194-bol -- pedig ez a ket
   * eset kozott van a hiba. A szam nelkul a felulet csak "sikerult"-et tud
   * mondani, es pont az a mondat volt felrevezeto.
   */
  selected: number
  /** Kijelolt, de mar korabban lehozott elem: nem hiba, es nem is uj. */
  already: number
  /**
   * Igaz, ha a kijelolt elemek listaja nem jott vegig (a lapozas kozben elszallt
   * a Picker API). Ilyenkor a `selected` KEVESEBB, mint amit a felhasznalo
   * kijelolt -- ezt meg kell mondani, nem elhallgatni.
   */
  partial?: boolean
}

const pickerRuns = new Map<string, Promise<DownloadResult>>()
const PICKER_RUNS_MAX = 50

export function rememberPickerRun(key: string, p: Promise<DownloadResult>): void {
  pickerRuns.set(key, p)
  // Hiba eseten NEM orizzuk meg: kulonben egy atmeneti halozati baj utan a
  // session vegleg elrontottnak latszana, es az ujraprobalas sem segitene.
  p.catch(() => { pickerRuns.delete(key) })
  // Felso korlat, hogy egy hosszan futo szolgaltatasban ne nojon a vegtelenbe.
  while (pickerRuns.size > PICKER_RUNS_MAX) {
    const oldest = pickerRuns.keys().next().value
    if (oldest === undefined) break
    pickerRuns.delete(oldest)
  }
}

export function getPickerRun(key: string): Promise<DownloadResult> | undefined {
  return pickerRuns.get(key)
}

/** Csak a teszteknek: tiszta lappal indulas. */
export function clearPickerRuns(): void {
  pickerRuns.clear()
}

async function pickerJson(url: string, token: string, init: RequestInit = {}): Promise<any> {
  const r = await fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.headers || {}) } })
  const text = await r.text()
  if (!r.ok) {
    const err: any = new Error(`Picker API ${r.status}: ${text.slice(0, 300)}`)
    err.status = r.status
    throw err
  }
  return text ? JSON.parse(text) : {}
}

/**
 * A KIVALASZTOTT elemek teljes listaja -- lapozassal.
 *
 * A `mediaItems.list` egy lapon LEGFELJEBB 100 elemet ad vissza, a tobbit
 * `nextPageToken` mogott. Ezt a lapozast korabban nem csinaltuk meg: egyetlen
 * `?pageSize=100` hivas ment ki, es a folotte levo kijeloles NEM LETEZETT a
 * rendszer szamara. Igy jott a 2026-08-16-i eset: a Boss ~194 kepet jelolt ki,
 * ebbol 100 latszott, az a 100 pedig mar elozo nap lejott -> `saved: 0`, a
 * felulet meg "sikerult"-et irt ki. A hianyzo ~94 kep sosem kerult szoba.
 *
 * A `get` azert cserelheto, hogy a lapozas onmagaban, halozat nelkul is
 * merheto legyen.
 */
const PICKER_PAGE_SIZE = 100
// 200 lap = 20 000 elem. Nem varhato kijeloles, de vegtelen hurokba egy hibas
// (onmagat ismetlo) token miatt sem eshetunk -- a `seen` mellett ez a masodik zar.
const PICKER_MAX_PAGES = 200

export async function fetchPickedMediaItems(
  sessionId: string,
  token: string,
  get: (url: string) => Promise<any> = (u) => pickerJson(u, token),
): Promise<{ items: any[]; partial: boolean }> {
  const items: any[] = []
  const seenTokens = new Set<string>()
  let pageToken = ''
  for (let page = 0; page < PICKER_MAX_PAGES; page++) {
    const url = `${MEDIA_ITEMS_URL}?sessionId=${encodeURIComponent(sessionId)}&pageSize=${PICKER_PAGE_SIZE}`
      + (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '')
    let body: any
    try {
      body = await get(url)
    } catch (err: any) {
      // Az ELSO lap hibaja valodi hiba: nincs mit lehozni, szoljon a hivo fele
      // (lejart session, 403, kikapcsolt API -- mindnek sajat uzenete van).
      if (items.length === 0) throw err
      // Kesobbi lapnal viszont a mar megkapott elemeket NEM dobjuk el: azok
      // baseUrl-je 60 percig el, es a felhasznalonak tobbet er 100 lehozott kep
      // + egy oszinte "nem jott vegig a lista", mint egy ures hibauzenet.
      logger.warn({ err: err.message, page, got: items.length }, '[photos] a kijelolt elemek lapozasa megszakadt')
      return { items, partial: true }
    }
    for (const it of body.mediaItems || []) items.push(it)
    const next = String(body.nextPageToken || '')
    if (!next) return { items, partial: false }
    if (seenTokens.has(next)) {
      logger.warn({ page, got: items.length }, '[photos] ismetlodo lapozo-token, a lapozast lezarjuk')
      return { items, partial: true }
    }
    seenTokens.add(next)
    pageToken = next
  }
  logger.warn({ got: items.length }, '[photos] elertuk a lapozasi felso hatart')
  return { items, partial: true }
}

/**
 * A kivalasztott kepek lehozasa a lemezre.
 *
 * Itt nincs "majd kesobb": a baseUrl 60 percig el, es a felhasznalo bezarhatja
 * a bongeszot. Ami mar lejott, az akkor is megmarad, ha a tobbi elhasal --
 * ezert mentunk indexet MINDEN kep utan, nem a vegen egyszer.
 */
/**
 * A regi bejegyzesek lenyomatanak potlasa.
 *
 * Ami mar a lemezen van, arrol nem tudjuk, egyforma-e barmi massal, amig ki nem
 * szamoljuk. Egyszer fut le elemenkent: utana a lenyomat az indexben marad.
 */
export async function backfillHashes(index: StoredPhoto[]): Promise<number> {
  let done = 0
  for (const p of index) {
    if (p.sha256) continue
    const f = photoFilePath(photoFileOwner(p), p.file)
    if (!existsSync(f)) continue
    try {
      p.sha256 = await sha256File(f)
      done++
    } catch { /* olvashatatlan fajl: marad lenyomat nelkul, nem esik ki */ }
  }
  return done
}

/**
 * Egy MAR a lemezen levo fajl lenyomata, darabokban.
 *
 * Miert nem readFileSync: ez a fuggveny az ELSO futasnal az EGESZ addigi
 * allomanyon vegigmegy (a mereskor 6,5 GB, benne tobb szaz MB-os videokkal).
 * Egyetlen readFileSync-kel az egesz fajl a memoriaba kerulne, es -- ami
 * rosszabb -- a dashboard EGYETLEN szala percekre megallna: se Email, se Drive,
 * se Telegram nem valaszolna kozben. Darabolva a memoria allando, es a tobbi
 * keres kozben is kiszolgalhato.
 */
function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256')
    const s = createReadStream(file)
    s.on('error', reject)
    s.on('data', (chunk) => h.update(chunk))
    s.on('end', () => resolve(h.digest('hex')))
  })
}

/** A dedupeIndex eredmenyenek atvezetese a lemezre. */
function applyDedupe(index: StoredPhoto[]): { index: StoredPhoto[]; dropped: number } {
  const r = dedupeIndex(index)
  for (const f of r.removeFiles) {
    try {
      // MINDKET helyrol: koltozes kozben ugyanaz a fajl mindketto alatt ott
      // lehet, es a felesleges peldany itt a lenyeg.
      for (const accDir of photoDirsFor(f.account)) {
        rmSync(join(accDir, f.file), { force: true })
        // A bolyegkepet CSAK a fajlnev szerinti neven toroljuk. A lenyomat
        // szerintit soha: az eppen a megtartott ikerpar kozos bolyege, es ket
        // egyforma kepnek szandekosan EGY bolyege van.
        rmSync(join(accDir, THUMB_DIRNAME, thumbFileName({ file: f.file })), { force: true })
      }
    } catch { /* mar nincs meg -- az index rendbetetele a lenyeg */ }
  }
  return { index: r.keep, dropped: r.dropped }
}

/**
 * Egyszerre EGY letoltes fusson, akarhany fiokbol indul.
 *
 * Az index EGYETLEN kozos JSON-fajl: a letoltes beolvassa, vegig a kezeben
 * tartja, es kepenkent visszairja. Ha ket fiok egyszerre tolt (a Boss tiz
 * fiokot tervez), a masodik mentes a SAJAT, regi masolatat irja vissza -- az
 * elso fiok kozben lejott kepei nyomtalanul eltunnenek az indexbol, mikozben a
 * fajlok ott allnanak a lemezen. Ugyanez a takaritasra: az egyik futas a masik
 * frissen leirt fajljat torolne ki egy elavult pillanatkep alapjan.
 *
 * A sorba allitas ezt a teljes hibaosztalyt megszunteti. A masodik fiok
 * valasztasa nem vesz el: megvarja a sorat (a felulet ugyis a futas
 * azonositojat kerdezi vissza), es utana a MAR frissitett indexrol indul.
 */
let photoDownloadQueue: Promise<unknown> = Promise.resolve()

export function queuePhotoDownload<T>(work: () => Promise<T>): Promise<T> {
  // Az elozo futas HIBAJA sem allithatja meg a sort (mindket agon tovabbmegy).
  const run = photoDownloadQueue.then(work, work)
  photoDownloadQueue = run.then(() => undefined, () => undefined)
  return run
}

function downloadPicked(items: any[], account: string, token: string): Promise<DownloadResult> {
  return queuePhotoDownload(() => downloadPickedNow(items, account, token))
}

/**
 * MEMORIA-TUSKE (Boss, 2026-08-15: "ez a fotok feltoltes e miatt van").
 *
 * A letoltes korabban `Buffer.from(await r.arrayBuffer())` volt: az EGESZ fajl
 * egyben a memoriaba kerult, ratetelben a nyers ArrayBuffer ES a Buffer-masolat
 * is. Egy telefonos videonal ez tobb szaz MB pillanatnyi tuske -- ezen a 7,9 GB-os
 * gepen a fleet memoria-kapu (scripts/fleet-memory-gate.sh) pont ezt latta meg,
 * es HARD PAUSE-t hirdetett: uj agens nem indulhatott, sot a percenkent futo
 * --shed egy tetlen agenst le is parkolt.
 *
 * Darabolva a memoria a fajlmerettol FUGGETLENUL allando (egy chunk), a lenyomat
 * pedig menet kozben keszul -- nem kell hozza a teljes tartalom egyben.
 *
 * A bajtok eloszor `.part` ideiglenes fajlba mennek, es csak a lenyomat ismereteben
 * dol el a sorsuk: uj tartalom -> atnevezes a vegleges nevre, mar meglevo egyforma
 * -> torles. Igy a Fotok oldal SOSE lat felig lejott fajlt.
 */
export async function streamToFile(body: unknown, dest: string): Promise<{ hash: string; bytes: number }> {
  if (!body) throw new Error('ures valasz-torzs')
  const h = createHash('sha256')
  let bytes = 0
  // A lenyomat egy atereszto fokozat, NEM egy 'data' figyelo: a sajat figyelo
  // azonnal folyo modba kapcsolna a forrast, meg mielott a pipeline rakotne a
  // celra -- ott csendben elveszhetnenek az elso darabok.
  const hasher = new Transform({
    transform(chunk, _enc, cb) {
      h.update(chunk)
      bytes += chunk.length
      cb(null, chunk)
    },
  })
  await pipeline(Readable.fromWeb(body as any), hasher, createWriteStream(dest))
  return { hash: h.digest('hex'), bytes }
}

/**
 * Mennyi memoria all rendelkezesre (MB).
 *
 * Ha nem tudjuk megallapitani (nem Linux, olvashatatlan /proc, ismeretlen
 * formatum), az ertek Infinity es NEM 0. A 0 azt jelentene, hogy "nincs
 * memoria", amitol a fekezes MINDEN kepnel kivarna a teljes felso korlatot --
 * egy ismeretlen kornyezet igy csendben orak ala lassitana egy letoltest.
 * Ismeretlen allapot = nem fekezunk.
 *
 * A fajl parameter csak azert van, hogy a hibas eseteket meg is lehessen merni.
 */
export function availableMemMb(file = '/proc/meminfo'): number {
  try {
    const m = readFileSync(file, 'utf-8').match(/^MemAvailable:\s+(\d+) kB/m)
    return m ? Math.round(Number(m[1]) / 1024) : Number.POSITIVE_INFINITY
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * A fekezes beallitasai. HIVASONKENT olvassuk a kornyezetet, nem a modul
 * betoltesekor: igy egy uzemeltetoi allitas a kovetkezo kepnel mar hat, es a
 * teszt is meg tudja merni a valodi fuggvenyt.
 *
 *   MARVEEN_PHOTO_PAUSE_MS      ket kep kozotti alap-szunet (alap: 120)
 *   MARVEEN_PHOTO_MIN_AVAIL_MB  ennyi szabad memoria alatt varunk (alap: 1200; 0 = ki)
 *   MARVEEN_PHOTO_MAX_WAIT_MS   de legfeljebb ennyit, kepenkent (alap: 30 mp)
 */
export function photoThrottleConfig(): { pauseMs: number; minAvailMb: number; maxWaitMs: number } {
  const num = (v: string | undefined, def: number) => {
    const n = Number(v)
    return Number.isFinite(n) && n >= 0 ? n : def
  }
  return {
    pauseMs: num(process.env.MARVEEN_PHOTO_PAUSE_MS, 120),
    minAvailMb: num(process.env.MARVEEN_PHOTO_MIN_AVAIL_MB, 1200),
    maxWaitMs: num(process.env.MARVEEN_PHOTO_MAX_WAIT_MS, 30_000),
  }
}

/**
 * Levegovetel a kovetkezo kep elott (Boss, 2026-08-15: "keslelteted kicsit a
 * fotok feltolteset ... de ne alljon le, ez lenne a lenyeg").
 *
 * Rovid alap-szunet, plusz: ha keves a szabad memoria, varunk -- de KORLATOZOTT
 * ideig. A vegen MINDEN esetben tovabbmegyunk: a kivalasztott kepek `baseUrl`-je
 * 60 percig el, egy hatarozatlan varakozas nem lassitana a letoltest, hanem
 * ELVESZITENE a kepeket. Fekezes igen, leallas nem.
 *
 * @returns mennyit vart osszesen (ms) -- a naplo es a teszt ebbol lat rea.
 */
export async function breathe(avail: () => number = availableMemMb): Promise<number> {
  const { pauseMs, minAvailMb, maxWaitMs } = photoThrottleConfig()
  if (pauseMs > 0) await sleep(pauseMs)
  if (minAvailMb <= 0) return 0
  let waited = 0
  while (avail() < minAvailMb && waited < maxWaitMs) {
    // A lepes soha nem lohet tul a felso korlaton: kulonben egy 30 ms-os
    // korlatbol is egy egesz masodperces varakozas lenne.
    const step = Math.min(1000, maxWaitMs - waited)
    await sleep(step)
    waited += step
  }
  if (waited > 0) {
    logger.info({ waitedMs: waited, availMb: avail() },
      '[photos] szoros memoria: vartam a kovetkezo kep elott')
  }
  return waited
}

/**
 * Az elozo futasbol ottfelejtett `.part` darabok kitakaritasa.
 *
 * A letoltes hibaag maga takarit, de attol csak a KEZELT hibak utan tiszta a
 * mappa. Ha a folyamatot kilovik (szolgaltatas-ujrainditas letoltes kozben), a
 * hibaag SOSE fut le, es a felbeszakadt darab ott ul a lemezen -- a vegtelensegig.
 *
 * Biztonsagos itt csinalni: a letoltesek EGY soron mennek at
 * ({@link queuePhotoDownload}), tehat ilyenkor nincs masik futo letoltes,
 * aminek a felkesz darabjat elvennenk.
 *
 * @returns hany darabot dobtunk el -- a naplo es a teszt ebbol lat rea.
 */
export function sweepPartFiles(dir: string): number {
  if (!existsSync(dir)) return 0
  let dropped = 0
  for (const name of readdirSync(dir)) {
    if (!name.startsWith('.') || !name.endsWith('.part')) continue
    try { rmSync(join(dir, name), { force: true }); dropped++ } catch { /* nem all meg tole a futas */ }
  }
  return dropped
}

/**
 * Melyik fajl ARVA a fiok mappajaban: ott van a lemezen, de egyetlen index-sor
 * sem hivatkozik ra, tehat a Fotok oldalon SOHA nem latszik -- csak a helyet
 * foglalja. (Merve 2026-08-15 az eles allomanyon: 389 fajl / 378 index-sor, 11
 * arva. Igy keletkeztek: a regi kod egybol a VEGLEGES nevre irt, es ha a
 * folyamat a nev es az index mentese kozott allt le, a fajl arvan maradt. Az uj
 * `.part` + atnevezes ezt a jovore nezve megszunteti.)
 *
 * Tiszta fuggveny, hogy a dontes onmagaban meregetheto legyen.
 */
export function orphanFiles(dirFiles: string[], keep: Set<string>): string[] {
  return dirFiles.filter((f) =>
    f !== 'index.json' && !f.startsWith('.') && !keep.has(f))
}

/**
 * Az arvak eldobasa -- HAROM vedokorlattal, mert ez torol.
 *
 *  1. Ures/serult index eseten SEMMIT nem torlunk. A `loadIndex()` serult
 *     fajlnal szandekosan ures listat ad; annak alapjan minden fajl "arva"
 *     lenne, es a takaritas kitorolne a Boss OSSZES lementett kepet.
 *  2. Csak akkor, ha ennek a fioknak van legalabb egy ELO sora: kulonben egy
 *     fiok-atnevezes utan a regi mappa teljes tartalma esne aldozatul.
 *  3. Ha az arvak tobben vannak, mint a megtartandok, valami nem stimmel
 *     (elcsuszott mappanev, felig visszaallitott index) -- ilyenkor inkabb
 *     napozunk egy figyelmeztetest, es nem nyulunk semmihez.
 *
 * @returns hany fajlt dobtunk el.
 */
export function sweepOrphanFiles(dir: string, keep: Set<string>, indexEmpty: boolean): number {
  // A harom korlat KULON sorokban all, hogy egyenkent is meregetheto legyen,
  // melyik mit fog meg. A masodik szandekosan atfed a harmadikkal (ures `keep`
  // eseten a "tul sok arva" is kozbelepne) -- egy torlo agnal a ketszeres
  // biztositas olcsobb, mint egy elveszett kep.
  if (indexEmpty) return 0
  if (keep.size === 0) return 0
  if (!existsSync(dir)) return 0
  const orphans = orphanFiles(readdirSync(dir), keep)
  if (orphans.length === 0) return 0
  if (orphans.length > keep.size) {
    logger.warn({ orphans: orphans.length, keep: keep.size, dir },
      '[photos] gyanusan sok arva fajl: NEM torlok semmit')
    return 0
  }
  let dropped = 0
  for (const f of orphans) {
    try { rmSync(join(dir, f), { force: true }); dropped++ } catch { /* nem all meg tole a futas */ }
  }
  return dropped
}

async function downloadPickedNow(items: any[], account: string, token: string): Promise<DownloadResult> {
  const dir = photoWriteDir(account)
  mkdirSync(dir, { recursive: true })
  const swept = sweepPartFiles(dir)
  if (swept) logger.info({ swept, account }, '[photos] korabbi felbeszakadt darabok eldobva')
  let index = loadIndex()
  // Eloszor a MAR meglevo allomany: lenyomat a regi soroknak, aztan a korabbrol
  // ottmaradt egyformak kitakaritasa (Boss: "vagy ha letolti utana torolje").
  const filled = await backfillHashes(index)
  const cleanup = applyDedupe(index)
  index = cleanup.index
  if (filled || cleanup.dropped) saveIndex(index)
  // ...es vegul a lemez: ami egyetlen sorhoz sem tartozik, az csak helyet foglal.
  // Az index MAR rendben van (lenyomatok potolva, egyformak kitakaritva), tehat
  // most tudjuk pontosan, mire hivatkozunk. A megtartando nevek ANNAK a fioknak
  // a mappajabol jonnek, amelyik a fajlt birtokolja (`fileAccount`): a masik
  // fiokban megjeleno, MEGOSZTOTT peldany nem hivatkozas ebben a mappaban.
  // A tulajdonos mappajat fiokonkent EGYSZER kerdezzuk meg: a `photoDir` a
  // lemezt nezi, es ezt szaz kepre elvegezni felesleges lemezmunka lenne.
  const dirOfOwner = new Map<string, string>()
  const ownerDirOf = (a: string): string => {
    let d = dirOfOwner.get(a)
    if (d === undefined) { d = photoDir(a); dirOfOwner.set(a, d) }
    return d
  }
  const keep = new Set(
    index.filter((p) => ownerDirOf(photoFileOwner(p)) === dir).map((p) => p.file))
  const orphans = sweepOrphanFiles(dir, keep, index.length === 0)
  if (orphans) logger.info({ orphans, account }, '[photos] gazdatlan fajlok eldobva')
  const known = new Set(index.map((p) => `${p.account}:${p.id}`))
  // Lenyomat -> az elso sor, ami mar ezekkel a bajtokkal all a lemezen.
  const byHash = new Map<string, StoredPhoto>()
  for (const p of index) if (p.sha256 && !byHash.has(p.sha256)) byHash.set(p.sha256, p)
  let saved = 0
  let failed = 0
  let duplicates = 0
  let already = 0
  for (const raw of items) {
    const norm = normalizeMediaItem(raw, account)
    if (!norm) { failed++; continue }
    // Ugyanazt ketszer nem toltjuk le -- de SZAMOLJUK. E nelkul egy csupa-regi
    // kijeloles `saved: 0, failed: 0`-t adott, amibol a felulet "sikerult"-et
    // csinalt, a Boss pedig egyetlen uj kepet sem latott (2026-08-16).
    if (known.has(`${account}:${norm.id}`)) { already++; continue }
    const url = mediaBytesUrl(raw?.mediaFile?.baseUrl || '', norm.isVideo)
    if (!url || !isAllowedPhotosUrl(url)) { failed++; continue }
    const file = safePhotoFileName(norm.id, norm.mimeType)
    // Rejtett nev: ha egy futas kozben esik szet a folyamat, a felig lejott
    // darab nem keveredik a kesz kepek koze a Fotok oldalon.
    const partPath = join(dir, `.${file}.part`)
    try {
      await breathe()
      // A baseUrl-hez KELL a bearer -- ez a Drive alairt thumbnail-linkjevel
      // ellentetes szabaly, es a Picker dokumentacio kulon kiemeli.
      const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
      if (!r.ok) { failed++; continue }
      const got = await streamToFile(r.body, partPath)
      const hash = got.hash
      const twin = byHash.get(hash)
      if (twin) {
        rmSync(partPath, { force: true })
        // Teljesen egyforma valamivel, ami mar itt van. A bajtokat NEM irjuk ki
        // megegyszer -- se fotonal, se videonal.
        duplicates++
        if (twin.account !== account) {
          // Mas fiokbol van meg: ez a fiok is lassa, de a meglevo fajlon.
          index.push({
            ...norm,
            file: twin.file,
            fileAccount: photoFileOwner(twin),
            sha256: hash,
            bytes: twin.bytes,
            savedAt: new Date().toISOString(),
          })
          known.add(`${account}:${norm.id}`)
          saveIndex(index)
        }
        continue
      }
      // Uj tartalom: a kesz .part megkapja a vegleges nevet. Az atnevezes egy
      // muvelet ugyanazon a fajlrendszeren -- nincs masodik masolat, es nincs
      // olyan pillanat, amikor a vegleges nev felig kesz fajlra mutat.
      renameSync(partPath, join(dir, file))
      const entry: StoredPhoto = { ...norm, file, bytes: got.bytes, savedAt: new Date().toISOString(), sha256: hash }
      index.push(entry)
      byHash.set(hash, entry)
      known.add(`${account}:${norm.id}`)
      saved++
      saveIndex(index)
    } catch (err: any) {
      // A felbeszakadt darab nem maradhat ott: kulonben minden sikertelen
      // probalkozas utan ott ulne egy .part a lemezen.
      rmSync(partPath, { force: true })
      logger.warn({ err: err.message, id: norm.id }, '[photos] egy kep nem jott le')
      failed++
    }
  }
  return { saved, failed, duplicates, cleaned: cleanup.dropped, selected: items.length, already }
}

export async function tryHandlePhotosPicker(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx

  // A fiokok + fiokonkent az, hogy megvan-e a Fotok-jogosultsag. A frontend
  // ebbol tud EMBERI uzenetet mutatni nyers 403 helyett.
  if (path === '/api/photos/accounts' && method === 'GET') {
    const { accounts, default: def } = googleAccountNames()
    json(res, {
      accounts: accounts.map((a) => ({ name: a, ready: hasPickerScope(tokenEntry(a)) })),
      default: def,
    })
    return true
  }

  // A lementett kepek. Ez a Fotok oldal fo forrasa -- halozat nelkul is megy.
  if (path === '/api/photos/list' && method === 'GET') {
    const account = url.searchParams.get('account') || ''
    const all = loadIndex()
    const list = account ? all.filter((p) => p.account === account) : all
    json(res, {
      photos: sortPhotos(list).map((p) => ({
        id: p.id, account: p.account, mimeType: p.mimeType, isVideo: p.isVideo,
        createdTime: p.createdTime, width: p.width, height: p.height, bytes: p.bytes,
      })),
      // A ket fioknal is szereplo, azonos kep egyetlen fajl: egyszer szamoljuk.
      totalBytes: uniqueBytes(list),
    })
    return true
  }

  // Egy lementett kep bajtjai. Csak az indexben szereplo fajlt adjuk ki --
  // igy a kliens semmilyen utvonalat nem tud "kitalalni".
  if (path === '/api/photos/media' && method === 'GET') {
    const id = url.searchParams.get('id') || ''
    const account = url.searchParams.get('account') || ''
    const entry = loadIndex().find((p) => p.id === id && p.account === account)
    if (!entry) { json(res, { error: 'nincs ilyen kep', code: 'not_found' }, 404); return true }
    // A bajtok egy MASIK fiok konyvtaraban is lehetnek, ha ket fioknal
    // ugyanaz a kep szerepel -- ilyenkor egyetlen peldany van a lemezen.
    // A fajl helyet a LEMEZ donti el (depo vagy regi hely), es a bolyegkep oda
    // kerul, ahol maga a kep van -- kulonben egy koltozes utan a bolyegek
    // arvan maradnanak a regi mappaban.
    const file = photoFilePath(photoFileOwner(entry), entry.file)
    const ownerDir = dirname(file)
    if (!existsSync(file)) { json(res, { error: 'a fajl hianyzik', code: 'file_missing' }, 404); return true }

    // A RACS bolyegkepet ker (`size=thumb`), a nagykep az eredetit. Igy egy
    // vegiggorgetes nem 7 GB, hanem nehany tiz MB -- es a videok sem folynak
    // be a bongeszobe teljes hosszukban.
    if (url.searchParams.get('size') === 'thumb') {
      const thumb = await ensureThumb(file, ownerDir, entry)
      if (thumb) {
        // Kulon ETag ("t" eloteg): kulonben a mar eltarolt NAGY kep azonositoja
        // 304-et valtana ki egy bolyeg-kerésre, es rossz meretu kep jonne elo.
        const tTag = entry.sha256 ? `"t${entry.sha256}"` : photoETag({ sha256: undefined }, thumb)
        if (tTag && requestETag(req.headers['if-none-match']) === tTag) {
          res.writeHead(304, { ETag: tTag, 'Cache-Control': 'private, max-age=86400' })
          res.end()
          return true
        }
        res.writeHead(200, {
          'Content-Type': 'image/jpeg',
          'Content-Length': statSync(thumb).size,
          ...(tTag ? { ETag: tTag } : {}),
          'Cache-Control': 'private, max-age=86400',
        })
        try {
          await pipeline(createReadStream(thumb), res)
        } catch (err: any) {
          logger.debug({ err: err?.message }, '[photos] a bolyegkep kuldese felbeszakadt')
          res.destroy()
        }
        return true
      }
      // Nem lett bolyeg. Videot ilyenkor SEM kuldunk ki: egy 1,8 GB-os fajl a
      // racsban rosszabb, mint egy jelzo negyzet -- a kliens ilyenkor rajzol
      // egy film-ikont. Kepnel az eredeti mehet, csak nagyobb.
      if (entry.isVideo) {
        json(res, { error: 'ehhez a videohoz nem keszult bolyegkep', code: 'no_thumb' }, 415)
        return true
      }
    }

    // A kep AZONOSSAGA a tartalmabol jon (a lenyomat mar megvan az indexben).
    // Ha a bongeszo ugyanezt kuldi vissza, a valasz 304, es EGYETLEN bajt sem
    // megy at a halozaton -- ez az, amiert a fiokba visszaterve nem kell
    // ujratolteni a racsot.
    const tag = photoETag(entry, file)
    if (tag && requestETag(req.headers['if-none-match']) === tag) {
      res.writeHead(304, { ETag: tag, 'Cache-Control': 'private, max-age=86400' })
      res.end()
      return true
    }
    const size = statSync(file).size
    res.writeHead(200, {
      'Content-Type': entry.mimeType || 'application/octet-stream',
      'Content-Length': size,
      ...(tag ? { ETag: tag } : {}),
      // Sajat gepen tarolt maganfenykep: kozbeeso gyorsitotar nem tarolhatja.
      'Cache-Control': 'private, max-age=86400',
    })
    // A bajtok ATFOLYNAK, nem egyben kerulnek a memoriaba. A regi
    // `readFileSync` + `res.end(buf)` a racs betoltesekor kepenkent egy teljes
    // fajlnyi lefoglalas volt: 378 kepnel ez vitte fel a szolgaltatast tobb
    // gigara (Boss, 2026-08-15: "a fotok alatt lejebb tekertem [...] nem
    // voltak betoltve a fotok"). A `pipeline` ezen kivul megvarja a lassu
    // bongeszot is, tehat a kimeno sor sem gyulhet a memoriaban.
    try {
      await pipeline(createReadStream(file), res)
    } catch (err: any) {
      // A bongeszo elnavigalt gorgetes kozben: ez a leggyakoribb eset, es NEM
      // hiba. A valasz feje mar elment, uzenetet mar nem kuldhetunk.
      logger.debug({ err: err?.message }, '[photos] a kep kuldese felbeszakadt')
      res.destroy()
    }
    return true
  }

  // Uj valasztas inditasa: session a Google-nel, es a pickerUri, amit a
  // felhasznalo megnyit.
  if (path === '/api/photos/session' && method === 'POST') {
    const data = JSON.parse((await readBody(req)).toString('utf-8') || '{}')
    const account = String(data.account || '')
    if (!account) { json(res, { error: 'account kotelezo' }, 400); return true }
    if (!hasPickerScope(tokenEntry(account))) {
      json(res, { error: 'ehhez a fiokhoz meg nincs Fotok-engedely', code: 'no_scope', account }, 409)
      return true
    }
    try {
      const token = await getAccessToken(account)
      const s = await pickerJson(SESSIONS_URL, token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
      json(res, {
        sessionId: s.id,
        pickerUri: s.pickerUri,
        // A Google mondja meg, milyen surun kerdezzunk ra -- nem talalunk ki
        // sajat idozitest, mert azt rate limit koveti.
        pollInterval: s.pollingConfig?.pollInterval || '5s',
        expireTime: s.expireTime,
      })
    } catch (err: any) {
      logger.warn({ err: err.message, account }, '[photos] session letrehozas elhasalt')
      const disabled = err.status === 403 ? pickerApiDisabled(err.message || '') : null
      if (disabled) {
        json(res, {
          error: err.message, code: 'api_disabled',
          enableUrl: disabled.url, projectNumber: disabled.projectNumber,
        }, 502)
        return true
      }
      if (pickerNoPhotosAccount(err.message || '')) {
        // 409: nem a mi hibank es nem is a Google-e -- a fiok allapota olyan,
        // amivel ez a muvelet nem vegezheto el. Ujraprobalas UTANA mukodik.
        json(res, { error: err.message, code: 'no_photos_account', account }, 409)
        return true
      }
      json(res, { error: err.message, code: err.status === 403 ? 'forbidden' : 'session_failed' }, 502)
    }
    return true
  }

  // Vegzett-e mar a felhasznalo a valasztassal? Ha igen, AZONNAL lehozzuk a
  // kepeket -- a baseUrl 60 perc mulva halott.
  if (path === '/api/photos/session' && method === 'GET') {
    const sessionId = url.searchParams.get('sessionId') || ''
    const account = url.searchParams.get('account') || ''
    if (!sessionId || !account) { json(res, { error: 'sessionId es account kotelezo' }, 400); return true }
    const runKey = `${account}:${sessionId}`
    try {
      // Ha ehhez a session-hoz mar fut (vagy lefutott) a behozatal, azt varjuk
      // meg, es ugyanazt valaszoljuk. Igy egy kesobb beeso kerdezes sem tolt le
      // semmit ujra, es nem is kap 404-et a mar elengedett session-re.
      const running = getPickerRun(runKey)
      if (running) { json(res, { done: true, ...(await running) }); return true }
      const token = await getAccessToken(account)
      const s = await pickerJson(`${SESSIONS_URL}/${encodeURIComponent(sessionId)}`, token)
      if (!s.mediaItemsSet) { json(res, { done: false }); return true }
      const run = (async () => {
        // VEGIG lapozunk: a kijeloles 100-nal tobb eleme is szamit.
        const picked = await fetchPickedMediaItems(sessionId, token)
        const r = await downloadPicked(picked.items, account, token)
        if (picked.partial) r.partial = true
        // A session-t elengedjuk: nincs ra tobb szuksegunk, es a Google is
        // ezt keri.
        try {
          await fetch(`${SESSIONS_URL}/${encodeURIComponent(sessionId)}`, {
            method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
          })
        } catch { /* nem baj, magatol is lejar */ }
        return r
      })()
      rememberPickerRun(runKey, run)
      json(res, { done: true, ...(await run) })
    } catch (err: any) {
      logger.warn({ err: err.message }, '[photos] session lekerdezes elhasalt')
      // Ugyanaz az eset kozben is elojohet (pl. valaki most kapcsolta ki az
      // API-t a projektben), es itt is ugyanaz a teendo -- ne nyers 403 jojjon.
      const disabled = err.status === 403 ? pickerApiDisabled(err.message || '') : null
      if (disabled) {
        json(res, {
          error: err.message, code: 'api_disabled',
          enableUrl: disabled.url, projectNumber: disabled.projectNumber,
        }, 502)
        return true
      }
      if (pickerSessionGone(err.message || '')) {
        // 410 Gone: ami itt volt, mar nincs. Nem hiba-allapot, hanem lezart
        // valasztas -- a felulet ebbol "kezdd ujra" uzenetet csinal.
        json(res, { error: err.message, code: 'session_gone' }, 410)
        return true
      }
      if (pickerNoPhotosAccount(err.message || '')) {
        json(res, { error: err.message, code: 'no_photos_account', account }, 409)
        return true
      }
      json(res, { error: err.message, code: 'poll_failed' }, 502)
    }
    return true
  }

  // Egy kep eltavolitasa a Marveenbol. A Google Fotokban NEM tortenik semmi --
  // ez csak a mi masolatunk.
  if (path === '/api/photos/remove' && method === 'POST') {
    const data = JSON.parse((await readBody(req)).toString('utf-8') || '{}')
    const id = String(data.id || '')
    const account = String(data.account || '')
    const index = loadIndex()
    const entry = index.find((p) => p.id === id && p.account === account)
    if (!entry) { json(res, { error: 'nincs ilyen kep' }, 404); return true }
    const rest = index.filter((p) => !(p.id === id && p.account === account))
    // A fajl kozos lehet egy masik fiokkal: csak akkor toroljuk, ha mar EGY sor
    // sem mutat ra. Kulonben egy fiokbol valo torles a masik fiok kepet is
    // elvinne -- a lemezen ugyanis egyetlen peldany van belole.
    const stillUsed = rest.some((p) => photoFileOwner(p) === photoFileOwner(entry) && p.file === entry.file)
    if (!stillUsed) {
      try {
        // Mindket helyrol: koltozes kozben mindketto alatt ottlehet.
        for (const ownerDir of photoDirsFor(photoFileOwner(entry))) {
          rmSync(join(ownerDir, entry.file), { force: true })
          // A bolyegkep is menjen vele, kulonben orokre ottmarad a `.thumbs`-ban.
          rmSync(join(ownerDir, THUMB_DIRNAME, thumbFileName(entry)), { force: true })
        }
      } catch { /* a fajl mar nincs meg -- az index takaritasa a lenyeg */ }
    }
    saveIndex(rest)
    json(res, { ok: true })
    return true
  }

  // Mennyi helyet foglal a lemezen. Tiz fioknal ez nem elhanyagolhato.
  if (path === '/api/photos/usage' && method === 'GET') {
    const index = loadIndex()
    const byAccount: Record<string, { count: number; bytes: number }> = {}
    for (const p of index) {
      const b = byAccount[p.account] || { count: 0, bytes: 0 }
      b.count++
      b.bytes += p.bytes || 0
      byAccount[p.account] = b
    }
    // Fiokonkent az marad, amennyit a fiok kepei kitesznek (igy a szam a fiok
    // sajat oldalan ertelmes), de az OSSZESEN a valodi lemezfoglalas: a ket
    // fioknal is szereplo, azonos kep egyszer szerepel benne.
    const totalBytes = uniqueBytes(index)
    // A bolyegkepek is helyet foglalnak -- keveset, de a szam legyen igaz.
    // Mert kulonben "7,1 GB"-ot irnank oda, mikozben 7,1 GB + bolyegek vannak
    // a lemezen, es senki nem ertene, honnan a kulonbseg.
    const thumbBytes = thumbDiskBytes()
    json(res, {
      count: index.length,
      totalBytes,
      human: humanBytes(totalBytes),
      thumbBytes,
      thumbHuman: humanBytes(thumbBytes),
      byAccount,
    })
    return true
  }

  return false
}

/**
 * Mennyi helyet foglalnak a bolyegkepek osszesen, minden fioknal.
 *
 * MINDKET helyet vegigjarja (regi mappa + depo): koltozes kozben a bolyegek is
 * ketfele allnak, es egy felig igaz szam rosszabb, mint semmi -- abbol senki
 * nem erti meg, hova tunt a lemez.
 */
export function thumbDiskBytes(): number {
  let total = 0
  const roots = [PHOTOS_DIR]
  const depot = depotRoot()
  if (depot) {
    // MAI depo-elrendezes: `fotok/<fiok>/.thumbs`. Es a REGI is (`fiokok/<fiok>/
    // fotok/.thumbs`), mert egy sikertelen atkoltoztetes utan ott maradnak a
    // bolyegek -- azt a helyet is meg kell szamolni, kulonben eltunt lemez.
    roots.push(join(depot, DEPOT_PHOTOS), join(depot, DEPOT_ACCOUNTS))
  }
  for (const root of roots) {
    let accounts: string[] = []
    try { accounts = existsSync(root) ? readdirSync(root) : [] } catch { accounts = [] }
    for (const acc of accounts) {
      // A regi elrendezesben <fiok>/.thumbs, a depoban <fiok>/fotok/.thumbs.
      for (const td of [join(root, acc, THUMB_DIRNAME), join(root, acc, DEPOT_PHOTOS, THUMB_DIRNAME)]) {
        try {
          if (!existsSync(td)) continue
          for (const f of readdirSync(td)) {
            try { total += statSync(join(td, f)).size } catch { /* eppen most tunt el */ }
          }
        } catch { /* egy elerhetetlen mappa ne dontse el az egesz osszesitest */ }
      }
    }
  }
  return total
}

/**
 * Csak a teszteknek: a lemezen levo KEPEK szama egy fioknal.
 *
 * A ponttal kezdodo bejegyzesek kimaradnak -- ugyanaz a hatarvonal, amit a
 * takarito seprusok hasznalnak. Igy sem a `.thumbs` mappa, sem egy eppen
 * keszulo `.part` darab nem szamit bele kepnek.
 */
export function countStoredFiles(account: string): number {
  // Mindket hely, de a NEVEK halmaza: koltozes kozben ugyanaz a fajl
  // atmenetileg mindketto alatt ottall, es ketszer szamolni hazugsag lenne.
  const names = new Set<string>()
  for (const dir of photoDirsFor(account)) {
    try {
      if (!existsSync(dir) || !statSync(dir).isDirectory()) continue
      for (const f of readdirSync(dir)) if (!f.startsWith('.')) names.add(f)
    } catch { /* elerhetetlen mappa: 0-nak szamit, nem hibanak */ }
  }
  return names.size
}
