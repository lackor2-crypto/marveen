// GOOGLE PHOTOS INTO THE LIFE TREE (#520).
//
// The owner (TG 8313, TG 8327): one Google Photos account can hold the photos
// of several people, so the place of a download is chosen PER BATCH, in the
// Life tree -- and nothing goes under `Rendszer` any more.
//
// Why a module and an index of its own, apart from `photos-picker.ts`: the
// old store is the program's private folder, and its code cleans it -- it
// deletes files the index does not know ("orphans") and the second of two
// identical files. Pointed at a folder of the Life tree, that would delete the
// owner's own files. Here the rules are the opposite:
//
//   - NOTHING in the chosen folder is ever deleted, replaced or renamed. A
//     name that is taken gets " (2)"; a failed download removes only the
//     temporary file this run itself created.
//   - Photos come down in ORIGINAL size (`=d`), under their original file
//     name: the Life tree holds the primary copy, and a preview-sized file
//     would be uploaded back as a preview.
//   - Removing a photo on the page moves it to the Life tree's trash.
//   - A row is dropped as "gone" only when its folder could be READ and the
//     file is not in it. An unreachable folder concludes nothing.

import { createHash, randomBytes } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { dirname, extname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { PROJECT_ROOT } from './config.js'
import { explorerRoot, resolveLifePath, trashLife } from './life-explorer.js'
import { trashRelPath } from './life-tree.js'
import { logger } from './logger.js'

export interface LifePhoto {
  id: string
  account: string
  /** The Life-tree folder the file is in (`/` separated, relative to the tree root). */
  lifeRel: string
  file: string
  mimeType: string
  createdTime: string
  width: number
  height: number
  isVideo: boolean
  bytes: number
  sha256: string
  savedAt: string
  /**
   * The file was NOT brought down by this program: the row only points at a file the owner already
   * had (picked in Google Photos, found unchanged in its folder). Taking such a row off the page
   * never touches the file.
   */
  linked?: boolean
}

const DIR = join(PROJECT_ROOT, 'store', 'photos')
const INDEX = join(DIR, 'life-index.json')
const LAST_DEST = join(DIR, 'life-last-dest.json')
/** Thumbnails of Life-tree photos live in the program folder: no hidden folder is put into the Life tree. */
export const LIFE_THUMB_BASE = join(DIR, 'life')

const norm = (rel: string): string => String(rel || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')

function writeAtomic(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, file)
}

export function loadLifeIndex(): LifePhoto[] {
  try {
    const j = JSON.parse(readFileSync(INDEX, 'utf8'))
    return Array.isArray(j) ? j.filter((p) => p && typeof p.id === 'string' && typeof p.file === 'string' && typeof p.lifeRel === 'string') : []
  } catch { return [] }
}

export function saveLifeIndex(list: LifePhoto[]): void {
  writeAtomic(INDEX, JSON.stringify(list, null, 2))
}

/** The folder chosen for this account the last time, or '' -- so a second batch to the same place is one click. */
export function lastLifeDest(account: string): string {
  try { return norm((JSON.parse(readFileSync(LAST_DEST, 'utf8')) || {})[account] || '') } catch { return '' }
}

export function rememberLifeDest(account: string, rel: string): void {
  let all: Record<string, string> = {}
  try { all = JSON.parse(readFileSync(LAST_DEST, 'utf8')) || {} } catch { all = {} }
  all[account] = norm(rel)
  try { writeAtomic(LAST_DEST, JSON.stringify(all, null, 2)) } catch (err) { logger.warn({ err: String(err) }, '[photos-life] could not remember the chosen folder') }
}

const PLACE_MEMORY = join(DIR, 'place-memory.json')
const PLACE_MEMORY_MAX = 50_000
interface PlaceRow { account: string; id: string; lifeRel: string; at: string }

function loadPlaceMemory(): PlaceRow[] {
  try {
    const j = JSON.parse(readFileSync(PLACE_MEMORY, 'utf8'))
    return Array.isArray(j) ? j.filter((r) => r && typeof r.id === 'string' && typeof r.account === 'string' && typeof r.lifeRel === 'string') : []
  } catch { return [] }
}

/**
 * The folder the owner chose for ONE photo the last time it was downloaded (TG 8393: "file-onkent
 * kell hogy megjegyezze hogy hova szeretnenk letolteni"). '' when nothing is remembered.
 */
export function rememberedPhotoPlace(account: string, id: string): string {
  const row = loadPlaceMemory().find((r) => r.account === account && r.id === id)
  return row ? norm(row.lifeRel) : ''
}

/** Remember the folder chosen per photo. One write for a whole batch. */
export function rememberPhotoPlaces(account: string, places: Record<string, string>): void {
  const ids = Object.keys(places).filter((id) => norm(places[id]))
  if (!ids.length) return
  const at = new Date().toISOString()
  const rest = loadPlaceMemory().filter((r) => !(r.account === account && ids.includes(r.id)))
  const all = [...rest, ...ids.map((id) => ({ account, id, lifeRel: norm(places[id]), at }))]
  try { writeAtomic(PLACE_MEMORY, JSON.stringify(all.slice(-PLACE_MEMORY_MAX), null, 2)) } catch (err) {
    logger.warn({ err: String(err) }, '[photos-life] could not remember the folders chosen per photo')
  }
}

// --- photos this program uploaded: on the page without being picked again (#528) ------
// Owner, 2026-10-09 (TG 8468): what went up from the Life tree "meg kene, hogy jelenjen a
// fotok alatt itt". The upload log knows the file and its folder, so the page gets a row
// that points at the file -- nothing is downloaded, nothing is copied.

const UNLINKED = join(DIR, 'life-unlinked.json')
const placeKey = (account: string, lifeRel: string, file: string): string => `${account}|${norm(lifeRel)}/${file}`

function loadUnlinked(): string[] {
  try { const j = JSON.parse(readFileSync(UNLINKED, 'utf8')); return Array.isArray(j) ? j.filter((x) => typeof x === 'string') : [] } catch { return [] }
}

function setUnlinked(key: string, on: boolean): void {
  const cur = loadUnlinked()
  const has = cur.includes(key)
  if (has === on) return
  const next = on ? [...cur, key] : cur.filter((k) => k !== key)
  try { writeAtomic(UNLINKED, JSON.stringify(next.slice(-50_000), null, 2)) } catch (err) {
    logger.warn({ err: String(err) }, '[photos-life] could not remember a photo taken off the page')
  }
}

export interface UploadedPhoto {
  /** Google's id of the uploaded item, or '' when Google returned none. */
  id: string
  lifeRel: string
  file: string
  bytes: number
  sha256: string
  mimeType: string
  uploadedAt: string
}

/**
 * Put the uploaded photos of one account on the page. A row is added only when the file is
 * still in its folder with the size it went up with, the page has no row for that file yet,
 * and the owner did not take it off the page. Returns how many rows were added.
 */
export function linkUploadedPhotos(account: string, uploads: UploadedPhoto[]): number {
  if (!uploads.length) return 0
  const index = loadLifeIndex()
  const mine = index.filter((p) => p.account === account)
  const ids = new Set(mine.map((p) => p.id))
  const places = new Set(mine.map((p) => `${norm(p.lifeRel)}/${p.file}`))
  // The same picture already on the page from another folder (an earlier download of it): one tile is enough.
  const hashes = new Set(mine.map((p) => p.sha256).filter(Boolean))
  const off = new Set(loadUnlinked())
  let added = 0
  for (const u of uploads) {
    const rel = norm(u.lifeRel)
    const id = u.id || `up-${u.sha256.slice(0, 40)}`
    if (!rel || !u.file || ids.has(id) || places.has(`${rel}/${u.file}`) || (u.sha256 && hashes.has(u.sha256)) || off.has(placeKey(account, rel, u.file))) continue
    const abs = lifePhotoPath({ lifeRel: rel, file: u.file })
    let same = false
    try { same = !!abs && statSync(abs).isFile() && statSync(abs).size === u.bytes } catch { same = false }
    if (!same) continue
    index.push({
      id, account, lifeRel: rel, file: u.file, mimeType: u.mimeType, createdTime: u.uploadedAt,
      width: 0, height: 0, isVideo: u.mimeType.startsWith('video/'), bytes: u.bytes, sha256: u.sha256,
      savedAt: new Date().toISOString(), linked: true,
    })
    ids.add(id)
    places.add(`${rel}/${u.file}`)
    if (u.sha256) hashes.add(u.sha256)
    added++
  }
  if (added) saveLifeIndex(index)
  return added
}

export type DestCheck = { ok: true; abs: string; rel: string } | { ok: false; code: 'needs_dest' | 'dest_not_in_tree' | 'dest_missing' | 'dest_trash' | 'dest_in_repo' }

/** The chosen folder, checked: in the Life tree, exists, not the trash, not inside a git repository. */
export function checkPhotoDest(dest: unknown): DestCheck {
  const rel = norm(typeof dest === 'string' ? dest : '')
  if (!rel) return { ok: false, code: 'needs_dest' }
  const root = explorerRoot()
  const abs = resolveLifePath(rel)
  if (!root || !abs) return { ok: false, code: 'dest_not_in_tree' }
  let isDir = false
  try { isDir = statSync(abs).isDirectory() } catch { isDir = false }
  if (!isDir) return { ok: false, code: 'dest_missing' }
  const trash = norm(trashRelPath())
  if (rel === trash || rel.startsWith(trash + '/')) return { ok: false, code: 'dest_trash' }
  for (let d = abs, i = 0; i < 64; i++) {
    if (existsSync(join(d, '.git'))) return { ok: false, code: 'dest_in_repo' }
    const up = dirname(d)
    if (up === d || d === root) break
    d = up
  }
  return { ok: true, abs, rel }
}

/**
 * The folder an uploaded photo came from, made again if it is gone (the owner, TG 8331: "ha nincs
 * olyan mappa akkor meg letrehozna"). Null when it cannot be: outside the tree, in the trash,
 * inside a repository, or the tree is not reachable -- the item then goes to the chosen folder.
 */
function homeFolder(lifeRel: string): { abs: string; rel: string } | null {
  const rel = norm(lifeRel)
  const root = explorerRoot()
  const abs = rel ? resolveLifePath(rel) : null
  if (!rel || !root || !abs) return null
  const trash = norm(trashRelPath())
  if (rel === trash || rel.startsWith(trash + '/')) return null
  // The tree itself must be there: a folder is never re-created on an unmounted drive.
  try { if (!statSync(root).isDirectory()) return null } catch { return null }
  try { mkdirSync(abs, { recursive: true }) } catch { return null }
  const chk = checkPhotoDest(rel)
  return chk.ok ? { abs: chk.abs, rel: chk.rel } : null
}

/** Where the file of a Life photo is, or null when the tree is not reachable. */
export function lifePhotoPath(p: Pick<LifePhoto, 'lifeRel' | 'file'>): string | null {
  const dir = resolveLifePath(p.lifeRel)
  return dir ? join(dir, p.file) : null
}

/**
 * A file name that is safe on Windows and Linux and keeps its extension.
 * Falls back to the Google id when the original name is unusable.
 */
export function safeOriginalName(original: unknown, id: string, mimeType: string): string {
  const fallbackExt = mimeType === 'image/jpeg' ? '.jpg' : mimeType === 'image/png' ? '.png' : mimeType === 'image/heic' ? '.heic'
    : mimeType === 'image/webp' ? '.webp' : mimeType === 'image/gif' ? '.gif' : mimeType === 'video/mp4' ? '.mp4'
    : mimeType === 'video/quicktime' ? '.mov' : mimeType.startsWith('video/') ? '.mp4' : '.jpg'
  let name = String(typeof original === 'string' ? original : '').replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_').replace(/^[.\s]+|[.\s]+$/g, '')
  if (!name || name.length > 180) name = String(id || 'photo').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || 'photo'
  if (!extname(name)) name += fallbackExt
  return name
}

/** A name that is free in `dir`: the name itself, or "name (2).ext", "name (3).ext" ... Never an existing one. */
export function freeName(dir: string, name: string, taken: Set<string> = new Set()): string {
  const ext = extname(name)
  const base = name.slice(0, name.length - ext.length)
  for (let i = 1; i < 10_000; i++) {
    const cand = i === 1 ? name : `${base} (${i})${ext}`
    if (!taken.has(cand.toLowerCase()) && !existsSync(join(dir, cand))) return cand
  }
  return `${base} (${randomBytes(4).toString('hex')})${ext}`
}

export interface LifeDownloadResult {
  saved: number
  failed: number
  duplicates: number
  cleaned: number
  selected: number
  already: number
  partial?: boolean
  /** Where the new files are (Life-tree path). */
  dest: string
  /** Items put back into the folder they were uploaded from, instead of the chosen one. */
  restored: number
  /** How many new files went into which Life-tree folder (a batch can go to several). */
  places: Record<string, number>
}

export interface LifeDownloadDeps {
  /** GET the bytes of one picked item. Injected so a test never reaches Google. */
  fetchBytes: (url: string, token: string) => Promise<{ ok: boolean; body: unknown }>
  /** Ids this account already has in the OLD store: they are "already here", not downloaded twice. */
  knownElsewhere?: Set<string>
  /** Called before each item (the caller's memory / pause throttle). */
  breathe?: () => Promise<void>
  isAllowedUrl: (url: string) => boolean
  /**
   * Where this item went up FROM, when this program uploaded it (#520, TG 8331): it goes back to
   * that folder instead of the chosen one. `bytes` lets an unchanged file be recognised without a download.
   */
  placeFor?: (item: { id: string; filename: string }) => { lifeRel: string; file: string; bytes: number } | null
  /**
   * The folder the owner chose for THIS item on the review list (TG 8393). It wins over everything
   * else; an item without one falls back to `placeFor`, then to the batch folder.
   */
  destFor?: (item: { id: string; filename: string }) => string | null
}

function hashFile(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256')
    createReadStream(file).on('data', (c) => h.update(c)).on('error', reject).on('end', () => resolve(h.digest('hex')))
  })
}

async function streamToFileHashed(body: unknown, dest: string): Promise<{ hash: string; bytes: number }> {
  const hash = createHash('sha256')
  let bytes = 0
  const src = body instanceof Readable ? body : Readable.fromWeb(body as any)
  src.on('data', (c: Buffer) => { hash.update(c); bytes += c.length })
  await pipeline(src, createWriteStream(dest))
  return { hash: hash.digest('hex'), bytes }
}

/**
 * Bring the picked items into `destRel`. Photos in original size (`=d`),
 * videos as the original video (`=dv`).
 */
export async function downloadPickedToLife(
  items: any[], account: string, token: string, destRel: string, deps: LifeDownloadDeps,
): Promise<LifeDownloadResult> {
  // The batch folder is optional once every item brings its own (`destFor`).
  const chk = checkPhotoDest(destRel)
  if (!chk.ok && !(deps.destFor && !norm(destRel))) throw Object.assign(new Error(chk.code), { code: chk.code })
  const dir = chk.ok ? chk.abs : ''
  const batchRel = chk.ok ? chk.rel : ''
  const index = loadLifeIndex()
  const known = new Set(index.filter((p) => p.account === account).map((p) => p.id))
  const byHash = new Map<string, LifePhoto>()
  for (const p of index) if (p.sha256 && !byHash.has(p.sha256)) byHash.set(p.sha256, p)
  const usedByDir = new Map<string, Set<string>>()
  const usedIn = (d: string): Set<string> => { let u = usedByDir.get(d); if (!u) { u = new Set(); usedByDir.set(d, u) } return u }
  const r: LifeDownloadResult = { saved: 0, failed: 0, duplicates: 0, cleaned: 0, selected: items.length, already: 0, dest: batchRel, restored: 0, places: {} }
  for (const raw of items) {
    const id = typeof raw?.id === 'string' ? raw.id : ''
    const mf = raw?.mediaFile || {}
    const meta = mf.mediaFileMetadata || {}
    const mimeType = typeof mf.mimeType === 'string' ? mf.mimeType : ''
    if (!id || !mimeType) { r.failed++; continue }
    if (known.has(id) || deps.knownElsewhere?.has(id)) { r.already++; continue }
    const isVideo = mimeType.startsWith('video/') || !!meta.videoMetadata
    const base = String(mf.baseUrl || '')
    const url = base ? `${base}=${isVideo ? 'dv' : 'd'}` : ''
    if (!url || !deps.isAllowedUrl(url)) { r.failed++; continue }
    // An item this program uploaded goes back where it came from. If the file is still there,
    // unchanged in size, it is simply "already here": nothing is downloaded.
    let itemDir = dir
    let itemRel = batchRel
    let wantName = ''
    const ident = { id, filename: typeof mf.filename === 'string' ? mf.filename : '' }
    const place = deps.placeFor ? deps.placeFor(ident) : null
    const chosen = norm(deps.destFor ? deps.destFor(ident) || '' : '')
    // The chosen folder wins. The upload place applies when nothing was chosen, or when the
    // owner chose exactly that folder (then the file keeps its name, and an unchanged one is skipped).
    const target = chosen || (place ? norm(place.lifeRel) : '')
    if (target) {
      const home = homeFolder(target)
      if (home) {
        if (place && norm(place.lifeRel) === home.rel) {
          const there = join(home.abs, place.file)
          let same = false
          try { same = statSync(there).isFile() && statSync(there).size === place.bytes } catch { same = false }
          if (same) {
            // Picked in Google Photos and already on this machine: nothing comes down, but the
            // page shows it -- a row that points at the file that is there (owner, TG 8417:
            // "az en fotom [...] itt meg kene hogy jelenjen").
            setUnlinked(placeKey(account, home.rel, place.file), false)
            // The page may already show this file (linked at upload): never a second row for it.
            if (index.some((p) => p.account === account && norm(p.lifeRel) === home.rel && p.file === place.file)) { known.add(id); r.already++; continue }
            // The real hash, so the thumbnail of this file never collides with a same-named one elsewhere.
            let sum = ''
            try { sum = await hashFile(there) } catch { sum = '' }
            index.push({
              id, account, lifeRel: home.rel, file: place.file, mimeType,
              createdTime: typeof raw.createTime === 'string' ? raw.createTime : '',
              width: Number(meta.width) || 0, height: Number(meta.height) || 0, isVideo,
              bytes: place.bytes, sha256: sum, savedAt: new Date().toISOString(), linked: true,
            })
            known.add(id)
            saveLifeIndex(index)
            r.already++
            continue
          }
          wantName = place.file
        }
        itemDir = home.abs
        itemRel = home.rel
      } else if (chosen) {
        // The folder the owner named cannot be used (gone drive, trash, repository): this item
        // does NOT quietly go somewhere else.
        r.failed++
        continue
      }
    }
    if (!itemDir) { r.failed++; continue }
    // A hidden temporary name of our OWN making: it is the only file this run may ever remove.
    const part = join(itemDir, `.marveen-foto-${randomBytes(6).toString('hex')}.part`)
    try {
      if (deps.breathe) await deps.breathe()
      const res = await deps.fetchBytes(url, token)
      if (!res.ok) { r.failed++; continue }
      const got = await streamToFileHashed(res.body, part)
      const twin = byHash.get(got.hash)
      const twinPath = twin ? lifePhotoPath(twin) : null
      if (twin && twinPath && existsSync(twinPath)) {
        // The same bytes are already in the Life tree: no second copy is written. This account's
        // row points at the file that is there.
        rmSync(part, { force: true })
        r.duplicates++
        index.push({ ...twin, id, account, createdTime: typeof raw.createTime === 'string' ? raw.createTime : '', savedAt: new Date().toISOString() })
        known.add(id)
        saveLifeIndex(index)
        continue
      }
      const file = freeName(itemDir, wantName || safeOriginalName(mf.filename, id, mimeType), usedIn(itemDir))
      usedIn(itemDir).add(file.toLowerCase())
      if (place && norm(place.lifeRel) === itemRel) r.restored++
      r.places[itemRel] = (r.places[itemRel] || 0) + 1
      renameSync(part, join(itemDir, file))
      const entry: LifePhoto = {
        id, account, lifeRel: itemRel, file, mimeType,
        createdTime: typeof raw.createTime === 'string' ? raw.createTime : '',
        width: Number(meta.width) || 0, height: Number(meta.height) || 0, isVideo,
        bytes: got.bytes, sha256: got.hash, savedAt: new Date().toISOString(),
      }
      index.push(entry)
      byHash.set(got.hash, entry)
      known.add(id)
      r.saved++
      saveLifeIndex(index)
    } catch (err: any) {
      rmSync(part, { force: true })
      logger.warn({ err: err?.message, id }, '[photos-life] one item did not come down')
      r.failed++
    }
  }
  return r
}

/**
 * Take a photo off the page. The file goes to the Life tree's TRASH (never
 * erased), and only when no other row shows the same file.
 */
export function removeLifePhoto(id: string, account: string): { ok: true; trashed: boolean } | { ok: false; code: 'not_found' | 'trash_failed'; message?: string } {
  const index = loadLifeIndex()
  const entry = index.find((p) => p.id === id && p.account === account)
  if (!entry) return { ok: false, code: 'not_found' }
  const rest = index.filter((p) => !(p.id === id && p.account === account))
  const stillUsed = rest.some((p) => p.lifeRel === entry.lifeRel && p.file === entry.file)
  let trashed = false
  // A linked row never owned the file: only the row goes.
  if (!stillUsed && !entry.linked) {
    const abs = lifePhotoPath(entry)
    if (abs && existsSync(abs)) {
      const t = trashLife(`${entry.lifeRel}/${entry.file}`)
      if (!t.ok) return { ok: false, code: 'trash_failed', message: t.message }
      trashed = true
    }
  }
  // A linked photo taken off the page stays off: the upload log would otherwise put it back.
  if (entry.linked) setUnlinked(placeKey(account, entry.lifeRel, entry.file), true)
  saveLifeIndex(rest)
  return { ok: true, trashed }
}

/**
 * The page follows the disk (#517): a row whose file was moved or deleted by
 * other means goes. But only a folder that could be LISTED may say "not here".
 */
export async function pruneLifePhotosMissing(): Promise<number> {
  const index = loadLifeIndex()
  if (!index.length) return 0
  const listed = new Map<string, Set<string> | null>()
  for (const rel of new Set(index.map((p) => p.lifeRel))) {
    const dir = resolveLifePath(rel)
    if (!dir) { listed.set(rel, null); continue }
    try { listed.set(rel, new Set(await readdir(dir))) } catch (err: any) {
      // The folder itself is gone (ENOENT) while its PARENT can be read: the files are gone with it.
      // Anything else (unreachable drive, no permission) concludes nothing.
      if (err?.code === 'ENOENT') {
        try { await readdir(dirname(dir)); listed.set(rel, new Set()) } catch { listed.set(rel, null) }
      } else listed.set(rel, null)
    }
  }
  const keep = index.filter((p) => { const names = listed.get(p.lifeRel); return !names || names.has(p.file) })
  const dropped = index.length - keep.length
  if (dropped) { saveLifeIndex(keep); logger.info({ dropped }, '[photos-life] rows of files that are no longer in their folder removed') }
  return dropped
}
