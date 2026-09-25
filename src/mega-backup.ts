/**
 * MEGA BACKUP of a backup rule (card #350, last part).
 *
 * A folder whose rule says "back up to MEGA <account>" is uploaded with the
 * same protection the Drive backup has (src/web/routes/drive-sync.ts header):
 *
 *   1. machine -> MEGA: a new or changed file goes up. `rclone copy` with an
 *      explicit `--files-from` list -- NEVER `rclone sync`, never a `--delete*`
 *      flag. The exclusions (backup-exclude + sub-folders with their own
 *      rule) are applied while the list is built, so nothing excluded can
 *      reach the list at all.
 *   2. A file deleted ON MEGA is not uploaded again: every uploaded file is
 *      recorded here (size + mtime), and "recorded, but gone from MEGA" means
 *      somebody deleted it there on purpose.
 *   3. A file deleted ON THE MACHINE is never deleted on MEGA by itself: it goes
 *      into a confirmation queue, one yes/no per file, behind the same brakes
 *      as the Drive (local folder unreachable / truncated walk / the
 *      shouldBrakeDeletions() percentage). "Yes" moves the MEGA copy to MEGA's
 *      own rubbish bin (rclone's mega backend default, hard_delete=false).
 *   4. Nothing starts by itself. Setting a rule uploads nothing; an upload is
 *      a button press after a preview (how many files, how big, does it fit
 *      the measured free space), and it uploads exactly the previewed list.
 *
 * Every rclone call goes through a `Runner`, so the tests use a mock and never
 * reach a real account (Boss, 2026-09-24: "de még ne töltsd fel semmit").
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { STORE_DIR } from './config.js'
import { isExcludedDir, isExcludedFile, type ExcludeRules } from './backup-exclude.js'
import { rcloneConfigPath, MEGA_TRANSFERS, type Runner, type RunResult } from './mega.js'
import { shouldBrakeDeletions } from './web/routes/drive-sync.js'

/** The folder on MEGA every Marveen backup goes under. */
export const MEGA_BACKUP_DIR = 'Marveen-backup'
/** A walk longer than this is "truncated": no deletion is concluded from it. */
export const MEGA_MAX_FILES = 200_000

let storeOverride: string | null = null
/** Test-only: where the state and the queue live. */
export function setMegaBackupStoreForTests(dir: string | null): void { storeOverride = dir }
function store(): string { return storeOverride ?? STORE_DIR }

// ---------------------------------------------------------------- local walk

export interface LocalFile { rel: string; size: number; mtimeMs: number }
export interface LocalWalk { files: LocalFile[]; truncated: boolean; unreachable: boolean }

/**
 * Every file under `base`, relative, with the exclusions applied. An
 * unreadable `base` is `unreachable` (brake 1) -- never "an empty folder",
 * which would read as "every file was deleted".
 */
export function walkForMega(base: string, rules: ExcludeRules, max = MEGA_MAX_FILES): LocalWalk {
  try {
    if (!statSync(base).isDirectory()) return { files: [], truncated: false, unreachable: true }
    readdirSync(base)
  } catch {
    return { files: [], truncated: false, unreachable: true }
  }
  const files: LocalFile[] = []
  const queue: string[] = ['']
  while (queue.length) {
    const rel = queue.shift()!
    let entries: { name: string; dir: boolean }[]
    try {
      entries = readdirSync(join(base, rel), { withFileTypes: true }).map((d) => ({ name: d.name, dir: d.isDirectory() }))
    } catch {
      // A sub-folder we could not read is NOT SEEN, so the result is not a
      // complete picture any more: no deletion may be concluded from it.
      return { files, truncated: true, unreachable: false }
    }
    for (const e of entries) {
      const child = rel ? `${rel}/${e.name}` : e.name
      if (e.dir) {
        if (!isExcludedDir(rules, child)) queue.push(child)
        continue
      }
      if (e.name.endsWith('.part')) continue
      if (isExcludedFile(rules, child)) continue
      if (files.length >= max) return { files, truncated: true, unreachable: false }
      try {
        const st = statSync(join(base, child))
        files.push({ rel: child, size: st.size, mtimeMs: Math.round(st.mtimeMs) })
      } catch {
        return { files, truncated: true, unreachable: false }
      }
    }
  }
  return { files, truncated: false, unreachable: false }
}

// --------------------------------------------------------------- state file

export interface MegaFileState { size: number; mtimeMs: number; uploadedAt: string }
export interface MegaBackupState { account: string; path: string; files: Record<string, MegaFileState> }

function ruleKey(account: string, path: string): string {
  return createHash('sha1').update(`${account}\u0000${path}`).digest('hex').slice(0, 16)
}
export function megaStateFile(account: string, path: string): string {
  return join(store(), 'mega-backup', `${ruleKey(account, path)}.json`)
}

/** Missing file = first backup (empty). Unreadable file = `broken`, never "empty". */
export function loadMegaState(account: string, path: string): { state: MegaBackupState; broken: string | null } {
  const f = megaStateFile(account, path)
  const empty: MegaBackupState = { account, path, files: {} }
  if (!existsSync(f)) return { state: empty, broken: null }
  try {
    const d = JSON.parse(readFileSync(f, 'utf-8'))
    const files: Record<string, MegaFileState> = {}
    for (const [k, v] of Object.entries(d?.files || {})) {
      const s = v as any
      if (s && typeof s.size === 'number' && typeof s.mtimeMs === 'number') files[k] = { size: s.size, mtimeMs: s.mtimeMs, uploadedAt: String(s.uploadedAt || '') }
    }
    return { state: { account, path, files }, broken: null }
  } catch (e: any) {
    return { state: empty, broken: String(e?.message || e) }
  }
}

function writeJsonAtomic(f: string, body: unknown): void {
  mkdirSync(dirname(f), { recursive: true })
  const tmp = f + '.tmp'
  writeFileSync(tmp, JSON.stringify(body, null, 2) + '\n', 'utf-8')
  renameSync(tmp, f)
}

export function saveMegaState(state: MegaBackupState): void {
  writeJsonAtomic(megaStateFile(state.account, state.path), state)
}

// -------------------------------------------------------------- remote side

/** `mega_x:Marveen-backup/<rule path>` -- the rule's own folder on MEGA. */
/**
 * The key of an account's own mirror folder (Raktar/Tarolok/MEGA/<account>,
 * card #360): its files go to the ROOT of that MEGA account (owner, 2026-09-25:
 * "1A, 2A" -- by hand, into the account root). Never a rule path: a rule path
 * comes from `normRulePath`, which cannot start with a colon-pair folder the
 * Explorer would create.
 */
export const MEGA_MIRROR = '::mirror'

export function megaRemoteDir(remote: string, path: string): string {
  if (path === MEGA_MIRROR) return `${remote}:`
  return `${remote}:${MEGA_BACKUP_DIR}${path ? '/' + path : ''}`
}

/** One file under a remote folder -- the account root has no trailing slash to add. */
export function megaRemoteFile(dir: string, rel: string): string {
  return dir.endsWith(':') ? dir + rel : `${dir}/${rel}`
}

export type RemoteList = { ok: true; files: Set<string> } | { ok: false; error: string }

/** Every file already on MEGA under the rule's folder. A missing folder = first backup. */
export async function listMegaRemote(bin: string, remoteDir: string, run: Runner): Promise<RemoteList> {
  const r = await run(bin, ['lsjson', '-R', '--files-only', '--no-mimetype', '--config', rcloneConfigPath(), remoteDir])
  if (r.code !== 0) {
    if (/directory not found/i.test(r.stderr)) return { ok: true, files: new Set() }
    return { ok: false, error: r.stderr.trim().slice(-400) || `rclone exit ${r.code}` }
  }
  try {
    const arr = JSON.parse(r.stdout || '[]')
    return { ok: true, files: new Set((Array.isArray(arr) ? arr : []).map((x: any) => String(x?.Path || '')).filter(Boolean)) }
  } catch (e: any) {
    return { ok: false, error: `rclone lsjson: ${String(e?.message || e)}` }
  }
}

// --------------------------------------------------------------------- plan

export interface MegaPlan {
  upload: LocalFile[]
  uploadBytes: number
  /** Uploaded earlier, deleted on MEGA since: NOT uploaded again. */
  remoteDeleted: string[]
  /** Already on MEGA, never uploaded by Marveen: left alone (mirror only). */
  remoteUntracked: string[]
  /** Gone from the machine, still on MEGA: only ever a confirmation-queue item. */
  wouldDelete: { rel: string; size: number }[]
  /** Recorded, but gone from both sides: dropped from the record. */
  forget: string[]
  /** Brake 3 fired: nothing goes into the queue. */
  brake: boolean
  tracked: number
  /** Brake 2: the walk was truncated, no deletion concluded. */
  truncated: boolean
}

/** Pure: what one backup run would do. */
export function planMegaBackup(
  walk: LocalWalk, state: MegaBackupState, remote: Set<string>, rules: ExcludeRules,
  opts: { keepRemoteUntracked?: boolean } = {},
): MegaPlan {
  const upload: LocalFile[] = []
  const remoteDeleted: string[] = []
  const remoteUntracked: string[] = []
  const localSet = new Set<string>()
  for (const f of walk.files) {
    localSet.add(f.rel)
    const s = state.files[f.rel]
    if (!s) {
      // Mirror of an account root: a file already there that Marveen never
      // uploaded (put there on the MEGA website) is NEVER overwritten.
      if (opts.keepRemoteUntracked && remote.has(f.rel)) { remoteUntracked.push(f.rel); continue }
      upload.push(f); continue
    }
    if (!remote.has(f.rel)) { remoteDeleted.push(f.rel); continue }
    if (s.size !== f.size || Math.round(s.mtimeMs) !== Math.round(f.mtimeMs)) upload.push(f)
  }
  const wouldDelete: { rel: string; size: number }[] = []
  const forget: string[] = []
  const tracked = Object.keys(state.files).length
  if (!walk.truncated && !walk.unreachable) {
    for (const [rel, s] of Object.entries(state.files)) {
      if (localSet.has(rel)) continue
      // An exclusion added later is NOT a deletion: the file was just not looked at.
      if (isExcludedFile(rules, rel)) continue
      if (remote.has(rel)) wouldDelete.push({ rel, size: s.size })
      else forget.push(rel)
    }
  }
  return {
    upload, uploadBytes: upload.reduce((n, f) => n + f.size, 0),
    remoteDeleted, remoteUntracked, wouldDelete, forget,
    brake: shouldBrakeDeletions(wouldDelete.length, tracked),
    tracked, truncated: walk.truncated,
  }
}

// ------------------------------------------------------------------- upload

/** No timeout: an upload can take hours. Same signature as mega.ts `Runner`. */
export const longRunner: Runner = (bin, args, input) =>
  new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (b) => { stdout += String(b) })
    child.stderr.on('data', (b) => { stderr = (stderr + String(b)).slice(-20_000) })
    child.on('error', (e) => resolve({ code: 1, stdout, stderr: stderr || String(e?.message || e) }))
    child.on('close', (code) => resolve({ code: typeof code === 'number' ? code : 1, stdout, stderr }))
    child.stdin.end(input ?? '')
  })

export interface UploadResult { uploaded: number; failed: string[]; error: string | null }

/**
 * Upload exactly `files` (the previewed list) with `rclone copy`, then ask MEGA
 * which of them actually arrived: only those are recorded. A file whose upload
 * failed is not recorded, so the next preview offers it again.
 */
export async function runMegaUpload(opts: {
  bin: string; remote: string; account: string; path: string; base: string
  files: LocalFile[]; run?: Runner; now?: () => Date
}): Promise<UploadResult> {
  const run = opts.run ?? longRunner
  const now = opts.now ?? (() => new Date())
  if (!opts.files.length) return { uploaded: 0, failed: [], error: null }
  const dest = megaRemoteDir(opts.remote, opts.path)
  const dir = mkdtempSync(join(tmpdir(), 'marveen-mega-'))
  const list = join(dir, 'files.txt')
  let r: RunResult
  try {
    writeFileSync(list, opts.files.map((f) => f.rel).join('\n') + '\n', 'utf-8')
    r = await run(opts.bin, [
      'copy', opts.base, dest,
      '--files-from-raw', list, '--no-traverse',
      '--transfers', String(MEGA_TRANSFERS),
      '--config', rcloneConfigPath(),
    ])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  const check = await listMegaRemote(opts.bin, dest, run)
  const loaded = loadMegaState(opts.account, opts.path)
  if (loaded.broken) return { uploaded: 0, failed: opts.files.map((f) => f.rel), error: `state unreadable: ${loaded.broken}` }
  const state = loaded.state
  const failed: string[] = []
  let uploaded = 0
  for (const f of opts.files) {
    if (check.ok && check.files.has(f.rel)) {
      state.files[f.rel] = { size: f.size, mtimeMs: f.mtimeMs, uploadedAt: now().toISOString() }
      uploaded++
    } else failed.push(f.rel)
  }
  saveMegaState(state)
  const error = r.code !== 0 ? (r.stderr.trim().slice(-400) || `rclone exit ${r.code}`)
    : !check.ok ? check.error : null
  return { uploaded, failed, error }
}

/** Drop records of files that are gone from both sides (plan.forget). */
export function forgetMegaFiles(account: string, path: string, rels: string[]): void {
  if (!rels.length) return
  const { state, broken } = loadMegaState(account, path)
  if (broken) return
  for (const r of rels) delete state.files[r]
  saveMegaState(state)
}

// --------------------------------------------------------- deletion queue

export interface MegaDeleteItem {
  id: string
  account: string
  /** The rule's folder. */
  path: string
  /** The file, relative to the rule's folder. */
  rel: string
  size: number
  detectedAt: string
}

function queueFile(): string { return join(store(), 'mega-delete-queue.json') }

export function loadMegaDeleteQueue(): { items: MegaDeleteItem[]; broken: string | null } {
  const f = queueFile()
  if (!existsSync(f)) return { items: [], broken: null }
  try {
    const d = JSON.parse(readFileSync(f, 'utf-8'))
    const items = (Array.isArray(d?.items) ? d.items : []).filter((x: any) =>
      x && typeof x.id === 'string' && typeof x.account === 'string' && typeof x.path === 'string' && typeof x.rel === 'string')
    return { items, broken: null }
  } catch (e: any) {
    return { items: [], broken: String(e?.message || e) }
  }
}

export function megaItemId(account: string, path: string, rel: string): string {
  return `${account}\u0000${path}\u0000${rel}`
}

/**
 * Replace one rule's queue items with the CURRENT picture: kept items keep
 * their first-seen time, new ones come in, stale ones go. Call only from a
 * complete picture (not truncated, brake not fired).
 */
export function syncMegaDeleteQueue(account: string, path: string, current: { rel: string; size: number }[], now = new Date().toISOString()): number {
  const { items, broken } = loadMegaDeleteQueue()
  if (broken) return 0   // never overwrite a list the user is deciding on
  const others = items.filter((i) => !(i.account === account && i.path === path))
  const old = new Map(items.filter((i) => i.account === account && i.path === path).map((i) => [i.id, i]))
  const mine = current.map((c) => {
    const id = megaItemId(account, path, c.rel)
    return old.get(id) ?? { id, account, path, rel: c.rel, size: c.size, detectedAt: now }
  })
  writeJsonAtomic(queueFile(), { items: [...others, ...mine] })
  return mine.length
}

/**
 * One yes/no answer. "yes" = the MEGA copy goes to MEGA's rubbish bin
 * (`rclone deletefile`, one file, never a folder). "no" = nothing is deleted:
 * the file stops being tracked, so it is not asked about again and stays on MEGA.
 */
export async function decideMegaDelete(opts: {
  id: string; yes: boolean; bin: string | null; remoteOf: (account: string) => string | null; run: Runner
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const { items, broken } = loadMegaDeleteQueue()
  if (broken) return { ok: false, error: `queue unreadable: ${broken}` }
  const item = items.find((i) => i.id === opts.id)
  if (!item) return { ok: false, error: 'not_found' }
  if (opts.yes) {
    const remote = opts.remoteOf(item.account)
    if (!remote) return { ok: false, error: 'no_account' }
    if (!opts.bin) return { ok: false, error: 'rclone_missing' }
    const target = megaRemoteFile(megaRemoteDir(remote, item.path), item.rel)
    const r = await opts.run(opts.bin, ['deletefile', '--config', rcloneConfigPath(), target])
    if (r.code !== 0) return { ok: false, error: r.stderr.trim().slice(-400) || `rclone exit ${r.code}` }
  }
  forgetMegaFiles(item.account, item.path, [item.rel])
  writeJsonAtomic(queueFile(), { items: items.filter((i) => i.id !== item.id) })
  return { ok: true }
}
