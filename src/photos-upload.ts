// FROM THE LIFE TREE UP TO GOOGLE PHOTOS (#520, second half).
//
// The owner (TG 8327, TG 8331): build the upload on Google's official channel,
// and REMEMBER which Life-tree folder each photo went up from, so a later
// download puts it back there.
//
// What Google allows (Library API, scope photoslibrary.appendonly): add new
// media. Not: overwrite, delete, or put into an album the app did not create.
// So an upload cannot be taken back from here -- which is why
//
//   - nothing goes up without a PLAN the owner has seen (how many, how big,
//     what is already up);
//   - the same content is never sent twice to the same account: the log keeps
//     the SHA-256 of every file that went up;
//   - a refusal from Google (quota, missing permission, API not enabled) stops
//     the run and is passed on in GOOGLE'S OWN WORDS -- the limits are not
//     guessed here (the documentation page could not be read when this was
//     written; the real answer is the measurement).
//
// The run only READS the Life tree.

import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { PROJECT_ROOT } from './config.js'
import { resolveLifePath } from './life-explorer.js'
import { logger } from './logger.js'

export const UPLOAD_SCOPE = 'https://www.googleapis.com/auth/photoslibrary.appendonly'
const UPLOADS_URL = 'https://photoslibrary.googleapis.com/v1/uploads'
const BATCH_URL = 'https://photoslibrary.googleapis.com/v1/mediaItems:batchCreate'
/** Google: at most 50 new items per batchCreate call. */
export const BATCH_MAX = 50
/** A plan lists at most this many files; more is said, never silently cut. */
export const PLAN_MAX_FILES = 2000

const MIME: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp',
  '.heic': 'image/heic', '.heif': 'image/heif', '.bmp': 'image/bmp', '.tif': 'image/tiff', '.tiff': 'image/tiff',
  '.avif': 'image/avif', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.m4v': 'video/x-m4v', '.avi': 'video/x-msvideo',
  '.mkv': 'video/x-matroska', '.webm': 'video/webm', '.3gp': 'video/3gpp', '.mpg': 'video/mpeg', '.mpeg': 'video/mpeg', '.wmv': 'video/x-ms-wmv',
}
export function mediaMime(name: string): string | null {
  return MIME[extname(String(name || '')).toLowerCase()] || null
}

export interface UploadLogRow {
  account: string
  sha256: string
  /** The Life-tree folder the file went up from. */
  lifeRel: string
  file: string
  bytes: number
  mtimeMs: number
  /** Google's id of the created media item ('' when Google returned none). */
  mediaItemId: string
  uploadedAt: string
}

const DIR = join(PROJECT_ROOT, 'store', 'photos')
const LOG = join(DIR, 'upload-log.json')
const norm = (rel: string): string => String(rel || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')

export function loadUploadLog(): UploadLogRow[] {
  try {
    const j = JSON.parse(readFileSync(LOG, 'utf8'))
    return Array.isArray(j) ? j.filter((r) => r && typeof r.account === 'string' && typeof r.sha256 === 'string' && typeof r.file === 'string') : []
  } catch { return [] }
}

function saveUploadLog(rows: UploadLogRow[]): void {
  mkdirSync(DIR, { recursive: true })
  const tmp = `${LOG}.tmp`
  writeFileSync(tmp, JSON.stringify(rows, null, 2), 'utf8')
  renameSync(tmp, LOG)
}

export function hasUploadScope(entry: unknown): boolean {
  const scope = entry && typeof entry === 'object' ? (entry as { scope?: unknown }).scope : null
  return typeof scope === 'string' && scope.split(/\s+/).includes(UPLOAD_SCOPE)
}

function sha256Of(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256')
    const s = createReadStream(file)
    s.on('error', reject)
    s.on('data', (c) => h.update(c))
    s.on('end', () => resolve(h.digest('hex')))
  })
}

export interface PlanFile { rel: string; lifeRel: string; file: string; bytes: number; mtimeMs: number; mime: string }
export interface UploadPlan {
  account: string
  upload: PlanFile[]
  uploadBytes: number
  /** Already sent to this account from this very place, unchanged since. */
  already: number
  /** Not a photo or a video by its extension: left out, counted. */
  notMedia: number
  /** A path that is not in the tree, or could not be read: nothing is concluded about it. */
  unreadable: string[]
  /** More files than a plan lists: the rest is NOT included, and that is said. */
  truncated: boolean
}

/**
 * What would go up: the picked files, and the files directly inside (and
 * below) the picked folders. Reads names, sizes and dates only.
 */
export async function planUpload(account: string, rels: string[]): Promise<UploadPlan> {
  const plan: UploadPlan = { account, upload: [], uploadBytes: 0, already: 0, notMedia: 0, unreadable: [], truncated: false }
  const log = loadUploadLog().filter((r) => r.account === account)
  const sentFrom = new Map<string, UploadLogRow>()
  for (const r of log) sentFrom.set(`${r.lifeRel}/${r.file}`, r)
  const seen = new Set<string>()
  const add = (rel: string, bytes: number, mtimeMs: number): void => {
    if (seen.has(rel)) return
    seen.add(rel)
    const cut = rel.lastIndexOf('/')
    const file = cut < 0 ? rel : rel.slice(cut + 1)
    const mime = mediaMime(file)
    if (!mime) { plan.notMedia++; return }
    const before = sentFrom.get(rel)
    if (before && before.bytes === bytes && before.mtimeMs === mtimeMs) { plan.already++; return }
    if (plan.upload.length >= PLAN_MAX_FILES) { plan.truncated = true; return }
    plan.upload.push({ rel, lifeRel: cut < 0 ? '' : rel.slice(0, cut), file, bytes, mtimeMs, mime })
    plan.uploadBytes += bytes
  }
  const walk = async (rel: string, abs: string, depth: number): Promise<void> => {
    if (depth > 12 || plan.truncated) return
    let entries: import('node:fs').Dirent[]
    try { entries = await readdir(abs, { withFileTypes: true }) } catch { plan.unreadable.push(rel); return }
    if (entries.some((e) => e.name === '.git')) return
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'desktop.ini') continue
      const cr = rel ? `${rel}/${e.name}` : e.name
      const ca = join(abs, e.name)
      if (e.isDirectory()) { await walk(cr, ca, depth + 1); continue }
      if (!e.isFile()) continue
      try { const st = await stat(ca); add(cr, st.size, Math.round(st.mtimeMs)) } catch { plan.unreadable.push(cr) }
    }
  }
  for (const raw of rels) {
    const rel = norm(raw)
    const abs = rel ? resolveLifePath(rel) : null
    if (!abs) { plan.unreadable.push(String(raw)); continue }
    let st: import('node:fs').Stats
    try { st = await stat(abs) } catch { plan.unreadable.push(rel); continue }
    if (st.isDirectory()) await walk(rel, abs, 0)
    else if (st.isFile()) add(rel, st.size, Math.round(st.mtimeMs))
  }
  return plan
}

export interface UploadResult {
  uploaded: number
  /** Same content had already gone up to this account (from another place or under another name). */
  duplicates: number
  failed: Array<{ rel: string; detail: string }>
  /** Google refused in a way that would repeat for every file: the run stopped here, in Google's words. */
  stopped: { status: number; message: string } | null
  remaining: number
}

export interface UploadDeps {
  /** One HTTP call to Google. Injected so a test never leaves the machine. */
  http: (url: string, init: { method: string; headers: Record<string, string>; body: unknown; duplex?: 'half' }) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>
  onProgress?: (done: number, total: number, current: string) => void
  shouldStop?: () => boolean
}

/** A refusal that the next file would get too: wrong permission, API off, quota. */
function isRunStopper(status: number): boolean {
  return status === 401 || status === 403 || status === 429
}

function googleMessage(text: string): string {
  try { const j = JSON.parse(text); return String(j?.error?.message || text).slice(0, 400) } catch { return String(text || '').slice(0, 400) }
}

/**
 * Send the planned files. Bytes first (one upload token per file), then the
 * media items are created in batches of at most 50, one batch at a time.
 */
export async function runUpload(plan: UploadPlan, token: string, deps: UploadDeps): Promise<UploadResult> {
  const res: UploadResult = { uploaded: 0, duplicates: 0, failed: [], stopped: null, remaining: 0 }
  const log = loadUploadLog()
  const sentHashes = new Set(log.filter((r) => r.account === plan.account).map((r) => r.sha256))
  let pending: Array<{ f: PlanFile; sha: string; uploadToken: string }> = []

  const flush = async (): Promise<boolean> => {
    if (!pending.length) return true
    const batch = pending
    pending = []
    const r = await deps.http(BATCH_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ newMediaItems: batch.map((b) => ({ simpleMediaItem: { uploadToken: b.uploadToken, fileName: b.f.file } })) }),
    })
    const text = await r.text()
    if (!r.ok) {
      for (const b of batch) res.failed.push({ rel: b.f.rel, detail: googleMessage(text) })
      if (isRunStopper(r.status)) { res.stopped = { status: r.status, message: googleMessage(text) }; return false }
      return true
    }
    let results: any[] = []
    try { results = JSON.parse(text)?.newMediaItemResults || [] } catch { results = [] }
    const byToken = new Map<string, any>()
    for (const x of results) if (x && typeof x.uploadToken === 'string') byToken.set(x.uploadToken, x)
    for (let i = 0; i < batch.length; i++) {
      const b = batch[i]
      const x = byToken.get(b.uploadToken) ?? results[i]
      // No status, or code 0 / message "Success" / "OK", with a media item: created.
      const code = Number(x?.status?.code || 0)
      const id = typeof x?.mediaItem?.id === 'string' ? x.mediaItem.id : ''
      if (!x || code !== 0 || !id) {
        res.failed.push({ rel: b.f.rel, detail: String(x?.status?.message || 'Google did not confirm this item').slice(0, 300) })
        continue
      }
      log.push({ account: plan.account, sha256: b.sha, lifeRel: b.f.lifeRel, file: b.f.file, bytes: b.f.bytes, mtimeMs: b.f.mtimeMs, mediaItemId: id, uploadedAt: new Date().toISOString() })
      sentHashes.add(b.sha)
      res.uploaded++
    }
    saveUploadLog(log)
    return true
  }

  for (let i = 0; i < plan.upload.length; i++) {
    const f = plan.upload[i]
    if (deps.shouldStop?.()) { res.remaining = plan.upload.length - i; break }
    deps.onProgress?.(i, plan.upload.length, f.rel)
    const dir = resolveLifePath(f.lifeRel)
    const abs = dir ? join(dir, f.file) : null
    try {
      if (!abs || !existsSync(abs)) { res.failed.push({ rel: f.rel, detail: 'the file is no longer there' }); continue }
      const st = statSync(abs)
      // The plan was made on these bytes; a file that changed since is not what the owner agreed to send.
      if (st.size !== f.bytes || Math.round(st.mtimeMs) !== f.mtimeMs) { res.failed.push({ rel: f.rel, detail: 'the file changed after the preview' }); continue }
      const sha = await sha256Of(abs)
      if (sentHashes.has(sha)) {
        // Same content is already up (from another folder / name): not sent again, and this place is remembered too.
        res.duplicates++
        const first = log.find((r) => r.account === plan.account && r.sha256 === sha)
        log.push({ account: plan.account, sha256: sha, lifeRel: f.lifeRel, file: f.file, bytes: f.bytes, mtimeMs: f.mtimeMs, mediaItemId: first?.mediaItemId || '', uploadedAt: new Date().toISOString() })
        saveUploadLog(log)
        continue
      }
      const up = await deps.http(UPLOADS_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream',
          'X-Goog-Upload-Content-Type': f.mime, 'X-Goog-Upload-Protocol': 'raw', 'Content-Length': String(f.bytes),
        },
        body: createReadStream(abs), duplex: 'half',
      })
      const text = await up.text()
      if (!up.ok || !text.trim()) {
        res.failed.push({ rel: f.rel, detail: googleMessage(text) || `HTTP ${up.status}` })
        if (isRunStopper(up.status)) { res.stopped = { status: up.status, message: googleMessage(text) }; res.remaining = plan.upload.length - i - 1; break }
        continue
      }
      pending.push({ f, sha, uploadToken: text.trim() })
      // Two files with the same content in one run: the second is not sent either.
      sentHashes.add(sha)
      if (pending.length >= BATCH_MAX) { if (!(await flush())) { res.remaining = plan.upload.length - i - 1; break } }
    } catch (err: any) {
      logger.warn({ err: err?.message, rel: f.rel }, '[photos-upload] one file did not go up')
      res.failed.push({ rel: f.rel, detail: String(err?.message || err).slice(0, 300) })
    }
  }
  if (!res.stopped) await flush()
  else if (pending.length) for (const b of pending) res.failed.push({ rel: b.f.rel, detail: 'not created: the run stopped' })
  deps.onProgress?.(plan.upload.length - res.remaining, plan.upload.length, '')
  return res
}

/**
 * Where a picked Google Photos item went up FROM, if this program sent it.
 * By Google's id when it matches; otherwise by file name, and only when
 * exactly one logged file of that account has that name -- an ambiguous name
 * is not guessed.
 */
export function uploadedPlaceFor(account: string, item: { id?: string; filename?: string }): UploadLogRow | null {
  const log = loadUploadLog().filter((r) => r.account === account)
  if (item.id) { const byId = log.find((r) => r.mediaItemId && r.mediaItemId === item.id); if (byId) return byId }
  const name = String(item.filename || '')
  if (!name) return null
  const same = log.filter((r) => r.file === name)
  const places = new Set(same.map((r) => `${r.lifeRel}/${r.file}`))
  return places.size === 1 ? same[same.length - 1] : null
}
