/**
 * Things that can quietly rot, checked on every Áttekintés load.
 *
 * Boss, 2026-08-19: "nezz korul az egesz marveenban. barmi ami elromolhat arra
 * tegyunk ellenorzest. ami itt jelenik meg." The self-check card already
 * watches credential expiry; this is the rest of the same idea -- the failures
 * that produce NO error message at the time they happen, and are therefore only
 * discovered when it is too late to act on them.
 *
 * Each check earns its place by a failure that was MEASURED on this machine,
 * not by being cheap to write:
 *
 *  - BACKUP CONTENT. The 6-hourly archive carried the database and the
 *    dashboard token and nothing else from store/ (verified inside
 *    claudeclaw-20260819-125659.tar.gz). Ten connected Google accounts, both
 *    GitHub tokens, the OAuth client and the vault key were all outside it, so
 *    a restore would have looked like it worked and then failed at every
 *    integration. A backup is only a backup once its CONTENT is checked; the
 *    exit code says nothing about what went in.
 *  - BACKUP FRESHNESS. A timer that stops firing leaves the newest archive
 *    ageing in place, which looks identical to a healthy system from the
 *    outside.
 *  - SECRETS IN LOGS. The dashboard printed its own bearer token to stderr,
 *    which systemd redirects into a 0664 log file: 365 lines' worth. Fixed at
 *    the source (web.ts checks isTTY now), watched here so it cannot creep back
 *    in through some other writer.
 *  - DISK. Everything above degrades silently when the disk fills; this is the
 *    cheap early word.
 *
 * Design constraints, same as credential-expiry.ts: file-only, no network, no
 * shelling out, bounded work (a tar listing is read as a stream, logs are
 * sampled from the tail), so the overview endpoint stays fast.
 */
import { existsSync, readdirSync, readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs'
import { statfsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { PROJECT_ROOT, STORE_DIR } from '../config.js'

export type HealthStatus = 'ok' | 'warn' | 'bad'

export interface HealthRow {
  /** Stable key the client maps to a translated label + advice. */
  id: string
  status: HealthStatus
  /** Numbers the translated text interpolates ({n}, {d}...). Never free text
   *  from disk: the client renders these into HTML without escaping. */
  params?: Record<string, string | number>
}

/** Files a restore cannot regenerate. Kept next to the check that enforces it
 *  so the two cannot drift apart -- the drift is exactly what went wrong. */
export const MUST_BACKUP = [
  'google-tokens.json',
  'google-oauth-client.json',
  '.github-tokens.json',
  '.vault-key',
  'vault.json',
] as const

const DAY_MS = 24 * 60 * 60 * 1000
/** The timer runs every ~6h; a day of silence is a real stall, not a hiccup. */
const BACKUP_STALE_MS = DAY_MS
const BACKUP_DEAD_MS = 3 * DAY_MS

function backupsDir(): string { return join(PROJECT_ROOT, 'backups') }

/** Newest claudeclaw-*.tar.gz, or null. */
function newestArchive(dir: string): { path: string; mtime: number } | null {
  if (!existsSync(dir)) return null
  let best: { path: string; mtime: number } | null = null
  for (const name of readdirSync(dir)) {
    if (!name.startsWith('claudeclaw-') || !name.endsWith('.tar.gz')) continue
    const p = join(dir, name)
    try {
      const m = statSync(p).mtimeMs
      if (!best || m > best.mtime) best = { path: p, mtime: m }
    } catch { /* raced away mid-prune; the next one will do */ }
  }
  return best
}

/**
 * Which of MUST_BACKUP are inside the archive.
 *
 * `tar -tzf` is the only outside command here, and it is worth it: reading the
 * member names is the only way to check the archive as it actually IS rather
 * than as the script's file list claims it should be -- and the file list being
 * right while the archive was wrong is the failure mode that hid for weeks. It
 * lists names only (no extraction), with a timeout, and a failure degrades to
 * "cannot tell" rather than to a false all-clear.
 */
/**
 * Memo for the tar listing, keyed by the archive's identity (path + mtime +
 * size), which is exactly what changes when a new backup lands.
 *
 * Measured 2026-08-19 after wiring this in: /api/connections/summary went to
 * 235 ms, of which `tar -tzf` on the 7 MB archive was 200 ms -- paid on every
 * single Overview load. An archive is immutable once written, so re-listing it
 * is pure waste; a new backup gets a new name and re-checks itself.
 */
let archiveMemo: { key: string; value: string[] | null } | null = null

function archiveKey(path: string): string {
  try {
    const s = statSync(path)
    return `${path}:${s.mtimeMs}:${s.size}`
  } catch {
    return `${path}:?`
  }
}

export function archiveMissing(archivePath: string): string[] | null {
  const key = archiveKey(archivePath)
  if (archiveMemo && archiveMemo.key === key) return archiveMemo.value
  const value = archiveMissingUncached(archivePath)
  archiveMemo = { key, value }
  return value
}

/** For tests: forget the memo so a rewritten fixture is re-read. */
export function _resetHealthCache(): void { archiveMemo = null; logMemo = null }

function archiveMissingUncached(archivePath: string): string[] | null {
  let listing: string
  try {
    listing = execFileSync('tar', ['-tzf', archivePath], {
      encoding: 'utf8', timeout: 20_000, maxBuffer: 8 * 1024 * 1024,
      // tar's own complaint about a corrupt archive is not the dashboard's
      // output; we report that case ourselves, in the operator's language.
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return null
  }
  const names = new Set(listing.split('\n').map(l => l.trim()).filter(Boolean))
  const has = (f: string) => {
    for (const n of names) if (n.endsWith('/' + f) || n === f) return true
    return false
  }
  return MUST_BACKUP.filter(f => !has(f))
}

function backupRows(now: number): HealthRow[] {
  const newest = newestArchive(backupsDir())
  if (!newest) {
    return [{ id: 'backup_missing', status: 'bad' }]
  }
  const age = now - newest.mtime
  const rows: HealthRow[] = []
  const hours = Math.floor(age / (60 * 60 * 1000))
  if (age >= BACKUP_DEAD_MS) rows.push({ id: 'backup_stale', status: 'bad', params: { h: hours } })
  else if (age >= BACKUP_STALE_MS) rows.push({ id: 'backup_stale', status: 'warn', params: { h: hours } })

  const missing = archiveMissing(newest.path)
  if (missing === null) {
    rows.push({ id: 'backup_unreadable', status: 'warn' })
  } else if (missing.length > 0) {
    // Names of well-known files, not paths from disk -- safe to render.
    rows.push({ id: 'backup_incomplete', status: 'bad', params: { n: missing.length, files: missing.join(', ') } })
  } else if (rows.length === 0) {
    rows.push({ id: 'backup_ok', status: 'ok', params: { h: hours } })
  }
  return rows
}

/**
 * Credentials sitting in a log file.
 *
 * Only the tail of each log is sampled: the leak that matters is a CURRENT one,
 * a hit deep in a rotated-away past does not change what to do today, and
 * scanning multi-megabyte logs on every page load would.
 */
const SECRET_IN_LOG = /token=[a-f0-9]{24}|refresh_token"\s*:\s*"[^"]{10}|client_secret"\s*:\s*"[^"]{10}|Bearer\s+[A-Za-z0-9_-]{24}/
const TAIL_BYTES = 256 * 1024

function tail(path: string, bytes: number): string {
  let fd: number | null = null
  try {
    const size = statSync(path).size
    const start = Math.max(0, size - bytes)
    const len = Math.min(bytes, size)
    if (len === 0) return ''
    fd = openSync(path, 'r')
    const buf = Buffer.allocUnsafe(len)
    readSync(fd, buf, 0, len, start)
    return buf.toString('utf8')
  } catch {
    return ''
  } finally {
    if (fd !== null) try { closeSync(fd) } catch { /* already gone */ }
  }
}

/** Log scanning is cheap per file but not free across a growing store/, and the
 *  answer cannot change meaningfully between two page loads. */
let logMemo: { at: number; dir: string; value: string[] } | null = null
const LOG_SCAN_TTL_MS = 60_000

export function secretsInLogs(storeDir = STORE_DIR, now = Date.now()): string[] {
  if (logMemo && logMemo.dir === storeDir && now - logMemo.at < LOG_SCAN_TTL_MS) return logMemo.value
  const hits: string[] = []
  let names: string[]
  try { names = readdirSync(storeDir) } catch { return hits }
  for (const name of names) {
    if (!name.endsWith('.log')) continue
    if (SECRET_IN_LOG.test(tail(join(storeDir, name), TAIL_BYTES))) hits.push(name)
  }
  logMemo = { at: now, dir: storeDir, value: hits }
  return hits
}

function diskRow(): HealthRow | null {
  try {
    const s = statfsSync(PROJECT_ROOT)
    const freeGb = (s.bavail * s.bsize) / 1024 ** 3
    const totalGb = (s.blocks * s.bsize) / 1024 ** 3
    const pct = totalGb > 0 ? (freeGb / totalGb) * 100 : 100
    if (freeGb < 2 || pct < 3) return { id: 'disk_low', status: 'bad', params: { gb: freeGb.toFixed(1) } }
    if (freeGb < 10 || pct < 8) return { id: 'disk_low', status: 'warn', params: { gb: freeGb.toFixed(1) } }
    return null
  } catch {
    return null
  }
}

/** Everything at once, worst first. `ok` rows are included on purpose: the card
 *  has to be able to state the healthy case, not just fall silent. */
export function systemHealth(now: number = Date.now()): HealthRow[] {
  const rows: HealthRow[] = [...backupRows(now)]
  const leaks = secretsInLogs()
  if (leaks.length > 0) {
    rows.push({ id: 'secret_in_log', status: 'warn', params: { n: leaks.length, files: leaks.join(', ') } })
  }
  const disk = diskRow()
  if (disk) rows.push(disk)
  const order: Record<HealthStatus, number> = { bad: 0, warn: 1, ok: 2 }
  return rows.sort((a, b) => order[a.status] - order[b.status])
}

export function worstHealthStatus(rows: HealthRow[]): HealthStatus {
  if (rows.some(r => r.status === 'bad')) return 'bad'
  if (rows.some(r => r.status === 'warn')) return 'warn'
  return 'ok'
}
