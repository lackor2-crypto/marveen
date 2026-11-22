// MEGA collect (#969): pull the contents of a bound MEGA account DOWN into its own storage folder,
// Rendszer/Tárolók/MEGA/<account>. The mirror of the Drive collect pair (#957); the upload side is mega-backup.ts.
//
// Add-only by construction, so a collect can never destroy anything:
//   - `rclone copy` (never sync/move), `--ignore-existing`: a local file is never overwritten;
//   - nothing is deleted locally or on MEGA;
//   - our own backup folder on the account (MEGA_BACKUP_DIR) is left alone;
//   - an account with nothing in it creates NO folder (#513: no empty account folders).
import { depotAccountDir, DEPOT_MEGA } from './depot.js'
import { readMegaAccounts, rcloneBin, rcloneConfigPath, MEGA_TRANSFERS, type Runner } from './mega.js'
import { MEGA_BACKUP_DIR, longRunner } from './mega-backup.js'

export interface MegaCollectResult {
  account: string
  ok: boolean
  /** The account holds no files outside our own backup folder: nothing was made or copied. */
  empty?: boolean
  /** Files rclone reported as newly copied. */
  copied: number
  /** Files on the account (outside the backup folder) when the run started. */
  remoteFiles: number
  error?: string
  detail?: string
  finishedAt: number
}

const running = new Set<string>()
const last = new Map<string, MegaCollectResult>()

export function isMegaCollectRunning(account: string): boolean { return running.has(account) }
export function lastMegaCollect(account?: string): MegaCollectResult | MegaCollectResult[] | undefined {
  return account ? last.get(account) : [...last.values()]
}

/** The rclone filter that keeps the account's own backup folder out of every collect. */
export const MEGA_COLLECT_EXCLUDE = `/${MEGA_BACKUP_DIR}/**`

export async function collectMegaAccount(
  name: string,
  opts: { run?: Runner; bin?: string | null; dest?: string | null; now?: () => number } = {},
): Promise<MegaCollectResult> {
  const now = opts.now ?? Date.now
  const done = (r: Omit<MegaCollectResult, 'account' | 'finishedAt'>): MegaCollectResult => {
    const res = { account: name, finishedAt: now(), ...r }
    last.set(name, res)
    return res
  }
  const acc = readMegaAccounts().find((a) => a.name === name)
  if (!acc) return done({ ok: false, copied: 0, remoteFiles: 0, error: 'not_found' })
  const bin = opts.bin === undefined ? rcloneBin() : opts.bin
  if (!bin) return done({ ok: false, copied: 0, remoteFiles: 0, error: 'rclone_missing' })
  const dest = opts.dest === undefined ? depotAccountDir(name, DEPOT_MEGA) : opts.dest
  if (!dest) return done({ ok: false, copied: 0, remoteFiles: 0, error: 'no_depot' })
  if (running.has(name)) return done({ ok: false, copied: 0, remoteFiles: 0, error: 'already_running' })

  running.add(name)
  try {
    const run = opts.run ?? longRunner
    const conf = ['--config', rcloneConfigPath()]
    const ls = await run(bin, ['lsjson', '-R', '--files-only', '--no-mimetype', '--exclude', MEGA_COLLECT_EXCLUDE, ...conf, `${acc.remote}:`])
    if (ls.code !== 0) return done({ ok: false, copied: 0, remoteFiles: 0, error: 'list_failed', detail: ls.stderr.trim().slice(-400) })
    let remoteFiles = 0
    try { const a = JSON.parse(ls.stdout || '[]'); remoteFiles = Array.isArray(a) ? a.length : 0 } catch { return done({ ok: false, copied: 0, remoteFiles: 0, error: 'bad_output' }) }
    if (remoteFiles === 0) return done({ ok: true, empty: true, copied: 0, remoteFiles: 0 })

    const cp = await run(bin, ['copy', `${acc.remote}:`, dest, '--ignore-existing', '--exclude', MEGA_COLLECT_EXCLUDE,
      '--transfers', String(MEGA_TRANSFERS), '-v', ...conf])
    if (cp.code !== 0) return done({ ok: false, copied: 0, remoteFiles, error: 'copy_failed', detail: cp.stderr.trim().slice(-400) })
    const copied = (cp.stderr.match(/: Copied \(new\)/g) || []).length
    return done({ ok: true, copied, remoteFiles })
  } finally {
    running.delete(name)
  }
}

/** Collect every bound account, one after the other (two parallel MEGA logins trip its rate limit). */
export async function collectAllMega(names: string[], opts: Parameters<typeof collectMegaAccount>[1] = {}): Promise<MegaCollectResult[]> {
  const out: MegaCollectResult[] = []
  for (const n of names) out.push(await collectMegaAccount(n, opts))
  return out
}
