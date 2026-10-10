// FROM THE LIFE TREE UP TO GOOGLE DRIVE OR MEGA, INTO A FOLDER THE OWNER PICKS (#525).
//
// The owner (TG 8424): one "Upload to the cloud" button in the Explorer, with
// Google Photos, Google Drive and MEGA under it. And (TG 8500, "525B"): the
// folder in the cloud is chosen by the owner at every upload -- nothing is
// derived from where the file sits in the tree.
//
// Until now a picked Life-tree file could only go up to Google Photos; Drive
// and MEGA only took a file browsed from the computer on their own pages.
//
// The rules are the ones the Photos upload already follows:
//   - nothing goes up without a PLAN the owner has seen (how many, how big,
//     what is already there);
//   - NOTHING IS OVERWRITTEN: a name that already exists in the target folder
//     is left alone and counted, never replaced;
//   - "could not look" is its own answer: a target folder that could not be
//     listed stops the plan, it is never read as "empty";
//   - a refusal that the next file would get too (permission, quota) stops the
//     run and is passed on in the service's own words.
//
// A picked FOLDER goes up as a folder of the same name inside the target,
// with what is below it. The run only READS the Life tree.

import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveLifePath } from './life-explorer.js'
import { listMegaDir, megaMkdir, megaUploadFile, normalizeMegaName } from './mega.js'

export type CloudKind = 'drive' | 'mega'
export const CLOUD_KINDS: readonly CloudKind[] = ['drive', 'mega']
export function isCloudKind(v: unknown): v is CloudKind {
  return typeof v === 'string' && (CLOUD_KINDS as readonly string[]).includes(v)
}

/** A plan lists at most this many files; more is said, never silently cut. */
export const CLOUD_PLAN_MAX_FILES = 2000
/** ... and looks into at most this many target folders. */
export const CLOUD_PLAN_MAX_DIRS = 300
const WALK_MAX_DEPTH = 12

const norm = (rel: string): string => String(rel || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
const dirKey = (dir: string[]): string => dir.join('/')

export type BackendResult<T = object> = ({ ok: true } & T) | { ok: false; message: string; stop?: boolean }

/**
 * One cloud folder the owner picked, and what can be done below it. `dir` is
 * always a list of folder names RELATIVE to that picked folder.
 */
export interface CloudBackend {
  /** The names directly in that folder; `names: null` = the folder does not exist yet. */
  list(dir: string[]): Promise<BackendResult<{ names: Set<string> | null }>>
  /** Make the folder (and its parents) if it is not there. */
  ensureDir(dir: string[]): Promise<BackendResult>
  /** Send one file. Never called for a name `list` reported. */
  put(dir: string[], name: string, abs: string, bytes: number): Promise<BackendResult>
}

export interface CloudPlanFile { rel: string; abs: string; name: string; bytes: number; dir: string[] }
export interface CloudPlan {
  upload: CloudPlanFile[]
  uploadBytes: number
  /** Already in the target folder under that name: left alone. */
  exists: number
  /** Two picked files would land on the same name in the same folder: only the first goes. */
  clash: number
  /** A name the service does not take (empty, a slash, a control character, too long). */
  badName: number
  /** A path that is not in the tree, or could not be read: nothing is concluded about it. */
  unreadable: string[]
  truncated: boolean
  /** The target could not be looked into: the plan is NOT usable, and this is why. */
  blocked: string | null
}

/**
 * What would go up. Reads names and sizes in the tree, and the names in the
 * target folders. Creates nothing.
 */
export async function planCloudUpload(rels: string[], backend: CloudBackend): Promise<CloudPlan> {
  const plan: CloudPlan = { upload: [], uploadBytes: 0, exists: 0, clash: 0, badName: 0, unreadable: [], truncated: false, blocked: null }
  const found: CloudPlanFile[] = []
  const seenRel = new Set<string>()
  const add = (rel: string, abs: string, bytes: number, dir: string[]): void => {
    if (seenRel.has(rel)) return
    seenRel.add(rel)
    const name = rel.slice(rel.lastIndexOf('/') + 1)
    if (normalizeMegaName(name) === null) { plan.badName++; return }
    if (found.length >= CLOUD_PLAN_MAX_FILES) { plan.truncated = true; return }
    found.push({ rel, abs, name, bytes, dir })
  }
  const walk = async (rel: string, abs: string, dir: string[], depth: number): Promise<void> => {
    if (depth > WALK_MAX_DEPTH || plan.truncated) return
    let entries: import('node:fs').Dirent[]
    try { entries = await readdir(abs, { withFileTypes: true }) } catch { plan.unreadable.push(rel); return }
    // A git repository is not a pile of documents: it is never sent up file by file.
    if (entries.some((e) => e.name === '.git')) { plan.unreadable.push(rel); return }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'desktop.ini') continue
      const cr = `${rel}/${e.name}`
      const ca = join(abs, e.name)
      if (e.isDirectory()) {
        if (normalizeMegaName(e.name) === null) { plan.badName++; continue }
        await walk(cr, ca, [...dir, e.name], depth + 1)
        continue
      }
      if (!e.isFile()) continue
      try { const st = await stat(ca); add(cr, ca, st.size, dir) } catch { plan.unreadable.push(cr) }
    }
  }
  for (const raw of rels) {
    const rel = norm(raw)
    const abs = rel ? resolveLifePath(rel) : null
    if (!abs) { plan.unreadable.push(String(raw)); continue }
    let st: import('node:fs').Stats
    try { st = await stat(abs) } catch { plan.unreadable.push(rel); continue }
    if (st.isDirectory()) {
      const name = rel.slice(rel.lastIndexOf('/') + 1)
      if (normalizeMegaName(name) === null) { plan.badName++; continue }
      await walk(rel, abs, [name], 0)
    } else if (st.isFile()) add(rel, abs, st.size, [])
  }

  const dirs = new Map<string, string[]>()
  for (const f of found) if (!dirs.has(dirKey(f.dir))) dirs.set(dirKey(f.dir), f.dir)
  if (dirs.size > CLOUD_PLAN_MAX_DIRS) {
    plan.truncated = true
    const keep = new Set(Array.from(dirs.keys()).slice(0, CLOUD_PLAN_MAX_DIRS))
    for (const k of Array.from(dirs.keys())) if (!keep.has(k)) dirs.delete(k)
  }
  const there = new Map<string, Set<string>>()
  // Shortest first: a folder that is not there has nothing below it either, so its subfolders are not asked about.
  const missing: string[] = []
  for (const [key, dir] of Array.from(dirs.entries()).sort((a, b) => a[1].length - b[1].length)) {
    if (missing.some((m) => key === m || key.startsWith(`${m}/`))) { there.set(key, new Set()); continue }
    const r = await backend.list(dir)
    if (!r.ok) { plan.blocked = r.message; return plan }
    if (r.names === null) missing.push(key)
    there.set(key, r.names ?? new Set())
  }
  const taken = new Set<string>()
  for (const f of found) {
    const key = dirKey(f.dir)
    const names = there.get(key)
    if (!names) continue // beyond the folder limit: counted as truncated above
    if (names.has(f.name)) { plan.exists++; continue }
    const slot = `${key}\u0000${f.name}`
    if (taken.has(slot)) { plan.clash++; continue }
    taken.add(slot)
    plan.upload.push(f)
    plan.uploadBytes += f.bytes
  }
  return plan
}

export interface CloudRunResult {
  uploaded: number
  /** Turned up in the target between the plan and the run: left alone. */
  skipped: number
  failed: Array<{ rel: string; detail: string }>
  /** A refusal the next file would get too: the run stopped here, in the service's words. */
  stopped: string | null
  remaining: number
}

/** Send the planned files, one at a time. */
export async function runCloudUpload(
  plan: CloudPlan, backend: CloudBackend,
  hooks: { onProgress?: (done: number, total: number, current: string) => void; shouldStop?: () => boolean } = {},
): Promise<CloudRunResult> {
  const out: CloudRunResult = { uploaded: 0, skipped: 0, failed: [], stopped: null, remaining: 0 }
  const total = plan.upload.length
  const ready = new Set<string>()
  const names = new Map<string, Set<string>>()
  let done = 0
  for (const f of plan.upload) {
    if (hooks.shouldStop?.() || out.stopped) break
    hooks.onProgress?.(done, total, f.rel)
    const key = dirKey(f.dir)
    let failure: { message: string; stop?: boolean } | null = null
    if (!ready.has(key)) {
      const mk = f.dir.length ? await backend.ensureDir(f.dir) : { ok: true as const }
      if (!mk.ok) failure = mk
      else {
        // Looked at again right before sending: the plan may be minutes old.
        const ls = await backend.list(f.dir)
        if (!ls.ok) failure = ls
        else { names.set(key, ls.names ?? new Set()); ready.add(key) }
      }
    }
    if (!failure) {
      const have = names.get(key) as Set<string>
      if (have.has(f.name)) { out.skipped++; done++; continue }
      const r = await backend.put(f.dir, f.name, f.abs, f.bytes)
      if (r.ok) { out.uploaded++; have.add(f.name) } else failure = r
    }
    if (failure) {
      if (failure.stop) out.stopped = failure.message
      else out.failed.push({ rel: f.rel, detail: failure.message })
    }
    done++
  }
  out.remaining = total - out.uploaded - out.skipped - out.failed.length
  hooks.onProgress?.(done, total, '')
  return out
}

// ---------------------------------------------------------------------------
// MEGA (through rclone, the way the MEGA page does it)
// ---------------------------------------------------------------------------

/** `account` is the MEGA account's name on the Accounts page, `root` the picked folder's path in it. */
export function megaBackend(account: string, root: string): CloudBackend {
  const at = (dir: string[]): string => [root, ...dir].filter(Boolean).join('/')
  const say = (r: { error: string; detail?: string }): string => (r.detail ? `${r.error}: ${r.detail}` : r.error).slice(0, 400)
  // A wrong password or a missing rclone repeats for every file; a single file's trouble does not.
  const stops = (code: string): boolean => ['not_found', 'rclone_missing', 'login_failed', 'twofa', 'not_activated', 'transfer_quota'].includes(code)
  return {
    async list(dir) {
      const r = await listMegaDir(account, at(dir))
      if (r.ok) return { ok: true, names: new Set(r.items.map((i) => i.name)) }
      if (r.error === 'dir_not_found') return { ok: true, names: null }
      return { ok: false, message: say(r), stop: stops(r.error) }
    },
    async ensureDir(dir) {
      for (let i = 1; i <= dir.length; i++) {
        const r = await megaMkdir(account, at(dir.slice(0, i - 1)), dir[i - 1])
        if (!r.ok && r.error !== 'exists') return { ok: false, message: say(r), stop: stops(r.error) }
      }
      return { ok: true }
    },
    async put(dir, name, abs, bytes) {
      const r = await megaUploadFile(account, at(dir), name, abs, bytes)
      return r.ok ? { ok: true } : { ok: false, message: say(r), stop: stops(r.error) }
    },
  }
}

// ---------------------------------------------------------------------------
// GOOGLE DRIVE
// ---------------------------------------------------------------------------

const DRIVE_FILES = 'https://www.googleapis.com/drive/v3/files'
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files'
const FOLDER_MIME = 'application/vnd.google-apps.folder'

export interface DriveHttpResponse { ok: boolean; status: number; text: () => Promise<string>; header: (name: string) => string | null }
/** One HTTP call to Google. Injected so a test never leaves the machine. */
export type DriveHttp = (url: string, init: { method: string; headers: Record<string, string>; body?: unknown; duplex?: 'half' }) => Promise<DriveHttpResponse>

function googleMessage(status: number, text: string): string {
  let msg = text
  try { msg = String(JSON.parse(text)?.error?.message || text) } catch { /* not JSON: Google's raw answer */ }
  return `Google ${status}: ${msg}`.slice(0, 400)
}

/** Inside a Drive query string a quote and a backslash are escaped with a backslash. */
export function driveQuote(name: string): string {
  return String(name).replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

/** `rootId` is the id of the Drive folder the owner picked ('root' = My Drive). */
export function driveBackend(token: string, rootId: string, http: DriveHttp): CloudBackend {
  const auth = { Authorization: `Bearer ${token}` }
  const ids = new Map<string, string | null>([['', rootId]])
  const fail = async (r: DriveHttpResponse): Promise<{ ok: false; message: string; stop: boolean }> =>
    ({ ok: false, message: googleMessage(r.status, await r.text()), stop: r.status === 401 || r.status === 403 || r.status === 429 })

  /** The id of that folder; `null` when it is not there. */
  const idOf = async (dir: string[]): Promise<BackendResult<{ id: string | null }>> => {
    const key = dirKey(dir)
    if (ids.has(key)) return { ok: true, id: ids.get(key) as string | null }
    const parent = await idOf(dir.slice(0, -1))
    if (!parent.ok) return parent
    if (parent.id === null) { ids.set(key, null); return { ok: true, id: null } }
    const q = `'${driveQuote(parent.id)}' in parents and name = '${driveQuote(dir[dir.length - 1] as string)}' and mimeType = '${FOLDER_MIME}' and trashed = false`
    const r = await http(`${DRIVE_FILES}?q=${encodeURIComponent(q)}&fields=${encodeURIComponent('files(id)')}&pageSize=10`, { method: 'GET', headers: auth })
    if (!r.ok) return fail(r)
    let id: string | null = null
    try { id = JSON.parse(await r.text())?.files?.[0]?.id ?? null } catch { return { ok: false, message: 'Google: unreadable answer' } }
    // "Not there" is not remembered: the run creates it a moment later.
    if (id) ids.set(key, id)
    return { ok: true, id }
  }

  return {
    async list(dir) {
      const f = await idOf(dir)
      if (!f.ok) return f
      if (f.id === null) return { ok: true, names: null }
      const names = new Set<string>()
      let page = ''
      for (let i = 0; i < 50; i++) {
        const q = `'${driveQuote(f.id)}' in parents and trashed = false`
        const r = await http(`${DRIVE_FILES}?q=${encodeURIComponent(q)}&fields=${encodeURIComponent('nextPageToken,files(name)')}&pageSize=1000${page ? `&pageToken=${encodeURIComponent(page)}` : ''}`, { method: 'GET', headers: auth })
        if (!r.ok) return fail(r)
        let j: { nextPageToken?: string; files?: Array<{ name?: string }> }
        try { j = JSON.parse(await r.text()) } catch { return { ok: false, message: 'Google: unreadable answer' } }
        for (const x of j.files || []) if (typeof x.name === 'string') names.add(x.name)
        if (!j.nextPageToken) return { ok: true, names }
        page = j.nextPageToken
      }
      // 50 000 names and still more: saying "not there" about the rest would risk a second copy.
      return { ok: false, message: 'Google: the folder has too many items to check' }
    },
    async ensureDir(dir) {
      for (let i = 1; i <= dir.length; i++) {
        const part = dir.slice(0, i)
        const have = await idOf(part)
        if (!have.ok) return have
        if (have.id) continue
        const parent = await idOf(part.slice(0, -1))
        if (!parent.ok) return parent
        const r = await http(`${DRIVE_FILES}?fields=id`, {
          method: 'POST', headers: { ...auth, 'Content-Type': 'application/json; charset=UTF-8' },
          body: JSON.stringify({ name: part[part.length - 1], mimeType: FOLDER_MIME, parents: [parent.id] }),
        })
        if (!r.ok) return fail(r)
        try { ids.set(dirKey(part), String(JSON.parse(await r.text()).id)) } catch { return { ok: false, message: 'Google: unreadable answer' } }
      }
      return { ok: true }
    },
    async put(dir, name, abs, bytes) {
      const f = await idOf(dir)
      if (!f.ok) return f
      if (!f.id) return { ok: false, message: 'the target folder is not there' }
      // Resumable upload: the file is streamed from the disk, never held in memory.
      const start = await http(`${DRIVE_UPLOAD}?uploadType=resumable&fields=id`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': 'application/octet-stream', 'X-Upload-Content-Length': String(bytes) },
        body: JSON.stringify({ name, parents: [f.id] }),
      })
      if (!start.ok) return fail(start)
      const session = start.header('location')
      if (!session || !/^https:\/\/www\.googleapis\.com\//.test(session)) return { ok: false, message: 'Google: no upload address in the answer' }
      const sent = await http(session, {
        method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes) },
        ...(bytes > 0 ? { body: createReadStream(abs), duplex: 'half' as const } : {}),
      })
      return sent.ok ? { ok: true } : fail(sent)
    },
  }
}
