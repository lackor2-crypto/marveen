/**
 * BELYEGKEPEK AZ INTEZOBEN (kartya #373).
 *
 * Boss, 2026-09-24: az Intezoben a kepek csak .jpg nevekkent latszanak --
 * "kis vagy kozepes ikonos belyegkep-nezet kell, pont mint a Raktar -> Fotok
 * alatt, hogy latsszon mi van a kepen. Videokra is elonezet."
 *
 * A belyegkepet az FFmpeg keszíti (kep: kicsinyites, az EXIF-forgatast is
 * alkalmazza; video: egy kocka az elejerol), es a `store/cache/life-thumbs`
 * ala kerul. A kulcs az ut + modositasi ido + meret: ha a fajl valtozik, uj
 * kep keszul, a regi magatol kiesik a takaritasnal.
 *
 * FFMPEG NELKUL (friss telepites): a bongeszo altal megjelenitheto kepeket
 * (jpg/png/webp/gif) az EREDETI bajtokkal szolgaljuk ki, a bongeszo kicsinyit.
 * Videohoz es mas formatumhoz ilyenkor nincs kep -- ezt a valasz KIMONDJA
 * (`reason: 'no_ffmpeg'`), a felulet pedig ikont mutat. A "nem sikerult" es a
 * "nincs hozza eszkoz" ket kulon ok, nem egy nema ures kep.
 */
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, renameSync } from 'node:fs'
import { extname, join } from 'node:path'
import { STORE_DIR } from './config.js'
import { fileKind } from './file-kind.js'
import { logger } from './logger.js'

/** A belyegkep hosszabbik oldala (px). A kis/kozepes nezet ugyanezt kicsinyiti. */
export const THUMB_EDGE = 320

const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'tif', 'tiff', 'heic', 'heif'])
const VIDEO_EXT = new Set(['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi', '3gp', 'mts', 'm2ts', 'wmv', 'ogv', 'mpg', 'mpeg'])

/** Milyen elonezet jarhat ehhez a fajlnevhez: kep, video, vagy semmi. */
export function thumbMediaKind(name: string): 'image' | 'video' | null {
  const ext = extname(String(name || '')).slice(1).toLowerCase()
  if (IMAGE_EXT.has(ext)) return 'image'
  if (VIDEO_EXT.has(ext)) return 'video'
  return null
}

let cacheDirOverride: string | null = null
/** Csak tesztnek: a gyorsitotar helye. */
export function setThumbCacheDirForTests(dir: string | null): void { cacheDirOverride = dir }
function cacheDir(): string { return cacheDirOverride ?? join(STORE_DIR, 'cache', 'life-thumbs') }

let ffmpegOverride: string | null | undefined
/** Csak tesztnek: `null` = nincs FFmpeg, string = ez az ut, undefined = valodi kereses. */
export function setThumbFfmpegForTests(p: string | null | undefined): void { ffmpegOverride = p }

async function ffmpegPath(): Promise<string | null> {
  if (ffmpegOverride !== undefined) return ffmpegOverride
  try {
    // Kesleltetett betoltes: a workbench-capabilities sok mindent huz be (a
    // Munkapad agenset is), a fa-listazas pedig ezt a modult importalja.
    const { probeFfmpeg } = await import('./workbench-capabilities.js')
    const p = await probeFfmpeg()
    return p.available && p.path ? p.path : null
  } catch { return null }
}

// Egyszerre legfeljebb ennyi FFmpeg fut: egy 300 kepes mappa megnyitasa ne
// ultesse le a gepet. A tobbi sorban all.
const MAX_PARALLEL = 2
let running = 0
const queue: Array<() => void> = []
function acquire(): Promise<void> {
  if (running < MAX_PARALLEL) { running++; return Promise.resolve() }
  return new Promise((r) => queue.push(() => { running++; r() }))
}
function release(): void {
  running--
  const next = queue.shift()
  if (next) next()
}

// Ugyanarra a fajlra egyszerre csak egy keszites fusson (a felulet ujrarajzolasa
// ketszer is kerheti).
const inflight = new Map<string, Promise<boolean>>()
// Ami egyszer mar elbukott (serult fajl, ismeretlen kodek), azt ne probaljuk
// ujra minden gorgetesnel. A kulcs a fajl allapotat is tartalmazza, tehat egy
// kicserelt fajl ujra probalkozhat.
const failed = new Set<string>()

function runFfmpeg(bin: string, args: string[], timeoutMs = 30_000): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
    let err = ''
    child.stderr?.on('data', (d) => { if (err.length < 2000) err += String(d) })
    const timer = setTimeout(() => { if (!done) { done = true; child.kill('SIGKILL'); resolve(false) } }, timeoutMs)
    child.on('error', () => { if (!done) { done = true; clearTimeout(timer); resolve(false) } })
    child.on('close', (code) => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (code !== 0) logger.debug({ code, err: err.slice(0, 300) }, '[intezo] belyegkep: az FFmpeg nem sikerult')
      resolve(code === 0)
    })
  })
}

function nonEmpty(p: string): boolean {
  try { return statSync(p).size > 0 } catch { return false }
}

async function generate(bin: string, abs: string, media: 'image' | 'video', out: string): Promise<boolean> {
  const tmp = out + '.part.jpg'
  const scale = `scale=w='min(${THUMB_EDGE},iw)':h='min(${THUMB_EDGE},ih)':force_original_aspect_ratio=decrease`
  const tail = ['-vf', scale, '-frames:v', '1', '-q:v', '5', '-y', tmp]
  let ok = false
  if (media === 'video') {
    // Egy masodpercnel: az elso kocka gyakran fekete. Ha a video ennel rovidebb,
    // a legelso kockat vesszuk.
    ok = await runFfmpeg(bin, ['-v', 'error', '-ss', '1', '-i', abs, ...tail]) && nonEmpty(tmp)
    if (!ok) ok = await runFfmpeg(bin, ['-v', 'error', '-i', abs, ...tail]) && nonEmpty(tmp)
  } else {
    ok = await runFfmpeg(bin, ['-v', 'error', '-i', abs, ...tail]) && nonEmpty(tmp)
  }
  if (!ok) { try { unlinkSync(tmp) } catch { /* nem jott letre */ } return false }
  try { renameSync(tmp, out); return true } catch { return false }
}

let writes = 0
/** A gyorsitotar ne nojon a vegtelensegig: a legregebbiek mennek. */
const MAX_CACHE_FILES = 5000
function pruneCache(dir: string): void {
  try {
    const files = readdirSync(dir).filter((f) => f.endsWith('.jpg'))
    if (files.length <= MAX_CACHE_FILES) return
    const withTime = files.map((f) => {
      try { return { f, t: statSync(join(dir, f)).mtimeMs } } catch { return { f, t: 0 } }
    }).sort((a, b) => a.t - b.t)
    for (const { f } of withTime.slice(0, files.length - MAX_CACHE_FILES)) {
      try { unlinkSync(join(dir, f)) } catch { /* mar nincs meg */ }
    }
  } catch { /* a takaritas sosem akadalyozza a kiszolgalast */ }
}

export type ThumbResult =
  | { ok: true; kind: 'thumb'; path: string; etag: string }
  | { ok: true; kind: 'original'; path: string; mime: string; etag: string }
  | { ok: false; reason: 'not_media' | 'no_ffmpeg' | 'failed' | 'too_big' }

/** Az eredeti fajl kiszolgalasanak felso hatara FFmpeg nelkul (a bongeszo kicsinyit). */
const MAX_ORIGINAL_BYTES = 25 * 1024 * 1024

/**
 * A belyegkep egy mar ELLENORZOTT (a fa belsejebe eso) abszolut utra.
 * Az utvonal-hatart a hivo (`resolveLifePath`) adja, ez itt nem ellenoriz.
 */
export async function lifeThumb(abs: string, name: string): Promise<ThumbResult> {
  const media = thumbMediaKind(name)
  if (!media) return { ok: false, reason: 'not_media' }
  let st
  try { st = statSync(abs) } catch { return { ok: false, reason: 'failed' } }
  if (!st.isFile()) return { ok: false, reason: 'not_media' }
  const key = createHash('sha1').update(`${abs}\0${st.mtimeMs}\0${st.size}\0${THUMB_EDGE}`).digest('hex')
  const dir = cacheDir()
  const out = join(dir, key + '.jpg')
  if (existsSync(out)) return { ok: true, kind: 'thumb', path: out, etag: key }

  const bin = await ffmpegPath()
  const browserImage = fileKind(name).kind === 'image'
  const original = (): ThumbResult => {
    if (!browserImage) return { ok: false, reason: bin ? 'failed' : 'no_ffmpeg' }
    if (st.size > MAX_ORIGINAL_BYTES) return { ok: false, reason: 'too_big' }
    return { ok: true, kind: 'original', path: abs, mime: fileKind(name).mime || 'application/octet-stream', etag: key + '-o' }
  }
  if (!bin || failed.has(key)) return original()

  let job = inflight.get(key)
  if (!job) {
    job = (async () => {
      await acquire()
      try {
        try { mkdirSync(dir, { recursive: true }) } catch { /* a generate ugyis elbukik */ }
        const ok = await generate(bin, abs, media, out)
        if (ok && ++writes % 200 === 0) pruneCache(dir)
        return ok
      } finally { release() }
    })()
    inflight.set(key, job)
    job.finally(() => inflight.delete(key)).catch(() => {})
  }
  const ok = await job
  if (ok) return { ok: true, kind: 'thumb', path: out, etag: key }
  failed.add(key)
  return original()
}
