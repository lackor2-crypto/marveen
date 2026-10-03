/**
 * MEGA -> machine (card #463 sub-card e801eee8, Boss TG 2200: "like the Drive Sync-now button, the MEGA
 * accounts get a download too"). One MEGA account's ROOT is brought down into its own mirror folder
 * (Depot/Storages/MEGA/<account>), the direction the upload mirror of src/mega-backup.ts does not cover.
 *
 * The rules, the same protection the other direction has:
 *   1. A file whose name (relative path) already exists locally is SKIPPED: no overwrite, no double
 *      download. Two layers: the plan leaves it out, and rclone gets `--ignore-existing` as well.
 *   2. Nothing is deleted anywhere. `rclone copy` with an explicit `--files-from-raw` list (exactly the
 *      previewed list), never `sync`, never a `--delete*` flag. A file deleted on MEGA stays on the machine.
 *   3. MEGA's own `Marveen-backup/` folder (the uploads of the backup rules) is not brought back down.
 *   4. A download starts by a button press after a preview (how many files, how big, does it fit the free
 *      disk space).
 *
 * Every rclone call goes through a `Runner`, so the tests use a mock and never reach a real account.
 */
import { mkdtempSync, rmSync, statfsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MEGA_BACKUP_DIR, MEGA_MIRROR, longRunner, megaRemoteDir, walkForMega, type LocalWalk } from './mega-backup.js'
import { excludeRules } from './backup-exclude.js'
import { MEGA_TRANSFERS, rcloneConfigPath, type Runner } from './mega.js'

export interface RemoteFile { rel: string; size: number }
export type SizedRemoteList = { ok: true; files: RemoteFile[] } | { ok: false; error: string }

/**
 * One MEGA account carries a single per-IP transfer budget, so an upload and a download must never run
 * together -- in EITHER direction. Given what runs now, returns the error code that blocks a new transfer
 * (`busy` = an upload is running, `busy_down` = a download is running), or null when the account is free.
 * Both the upload and the download run endpoint ask this before starting, so neither direction can slip past
 * the other (card #463 added the download side; the upload side used to check uploads only).
 */
export function megaTransferBusyCode(uploadRunning: boolean, downloadRunning: boolean): 'busy' | 'busy_down' | null {
  if (uploadRunning) return 'busy'
  if (downloadRunning) return 'busy_down'
  return null
}

/** Every file in the account with its size. A missing folder is an empty account, not an error. */
export async function listMegaRemoteSized(bin: string, remoteDir: string, run: Runner): Promise<SizedRemoteList> {
  const r = await run(bin, ['lsjson', '-R', '--files-only', '--no-mimetype', '--config', rcloneConfigPath(), remoteDir])
  if (r.code !== 0) {
    if (/directory not found/i.test(r.stderr)) return { ok: true, files: [] }
    return { ok: false, error: r.stderr.trim().slice(-400) || `rclone exit ${r.code}` }
  }
  try {
    const arr = JSON.parse(r.stdout || '[]')
    const files: RemoteFile[] = []
    for (const x of Array.isArray(arr) ? arr : []) {
      const rel = String(x?.Path || '')
      if (rel) files.push({ rel, size: typeof x?.Size === 'number' && x.Size >= 0 ? x.Size : 0 })
    }
    return { ok: true, files }
  } catch (e: any) {
    return { ok: false, error: `rclone lsjson: ${String(e?.message || e)}` }
  }
}

export interface MegaDownloadPlan {
  download: RemoteFile[]
  downloadBytes: number
  /** Same name already on the machine: skipped, never overwritten. */
  skippedExisting: number
  /** MEGA's Marveen-backup folder: not brought back. */
  skippedBackupDir: number
  /** The local folder could not be read completely: only rclone's --ignore-existing protects then. */
  localIncomplete: boolean
}

const inBackupDir = (rel: string): boolean => rel === MEGA_BACKUP_DIR || rel.startsWith(MEGA_BACKUP_DIR + '/')

/** Pure: what one download would bring down. */
export function planMegaDownload(remote: RemoteFile[], local: LocalWalk): MegaDownloadPlan {
  const have = new Set(local.files.map((f) => f.rel))
  const download: RemoteFile[] = []
  let skippedExisting = 0
  let skippedBackupDir = 0
  for (const f of remote) {
    if (inBackupDir(f.rel)) { skippedBackupDir++; continue }
    if (have.has(f.rel)) { skippedExisting++; continue }
    download.push(f)
  }
  return {
    download,
    downloadBytes: download.reduce((n, f) => n + f.size, 0),
    skippedExisting, skippedBackupDir,
    localIncomplete: local.truncated || local.unreachable,
  }
}

/** Free bytes on the disk holding `dir`, null when unknown. */
export function freeDiskBytes(dir: string): number | null {
  try { const s = statfsSync(dir); return s.bavail * s.bsize } catch { return null }
}

/** Walk the local mirror folder (nothing excluded: every present name counts as "exists"). */
export function walkMirrorForDownload(base: string): LocalWalk {
  return walkForMega(base, excludeRules([]))
}

export interface DownloadResult { downloaded: number; failed: string[]; error: string | null }

/**
 * Bring down exactly `files` (the previewed list). Then ask the machine which of them arrived: a file that
 * did not arrive is reported as failed, so the next preview offers it again.
 */
export async function runMegaDownload(opts: {
  bin: string; remote: string; dest: string; files: RemoteFile[]; run?: Runner
  /** Test seam: which of the files exist on disk afterwards. */
  arrived?: (dest: string, files: RemoteFile[]) => Set<string>
}): Promise<DownloadResult> {
  const run = opts.run ?? longRunner
  if (!opts.files.length) return { downloaded: 0, failed: [], error: null }
  const dir = mkdtempSync(join(tmpdir(), 'marveen-mega-down-'))
  const list = join(dir, 'files.txt')
  let code = 0
  let stderr = ''
  try {
    writeFileSync(list, opts.files.map((f) => f.rel).join('\n') + '\n', 'utf-8')
    const r = await run(opts.bin, [
      'copy', megaRemoteDir(opts.remote, MEGA_MIRROR), opts.dest,
      '--files-from-raw', list, '--no-traverse', '--ignore-existing',
      '--transfers', String(MEGA_TRANSFERS),
      '--config', rcloneConfigPath(),
    ])
    code = r.code
    stderr = r.stderr
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  const arrived = opts.arrived ? opts.arrived(opts.dest, opts.files) : new Set(walkMirrorForDownload(opts.dest).files.map((f) => f.rel))
  const failed = opts.files.filter((f) => !arrived.has(f.rel)).map((f) => f.rel)
  const error = code !== 0 ? (stderr.trim().slice(-400) || `rclone exit ${code}`) : null
  return { downloaded: opts.files.length - failed.length, failed, error }
}
