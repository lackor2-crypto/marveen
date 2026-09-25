/**
 * Make one full, encrypted backup file (#396, plan §4 / Phase 1).
 *
 *   1. lock (store/locks/backup.lock, stale after 2 h or a dead pid)
 *   2. staging dir (0700) under STORE_DIR/tmp -- never /tmp
 *   3. copy the inventory into its logical roots
 *   4. snapshot the DB with the Online Backup API
 *   5. bundle local-only git commits
 *   6. hash every file into manifest.json
 *   7. tar -czf - | encryptStream -> <outDir>/<name>.mbk.partial
 *   8. fsync, rename to .mbk
 *   9. remove the staging dir (finally)
 *
 * Every file it creates is 0600, every dir 0700.
 */
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync, closeSync, cpSync, createWriteStream, existsSync, fsyncSync, lstatSync,
  mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, readlinkSync, renameSync, rmSync, statSync,
  unlinkSync, writeFileSync,
} from 'node:fs'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type Database from 'better-sqlite3'
import { encryptStream, type BackupKind, type EncryptOptions } from './crypto.js'
import { collectInventory, type BackupCategory, type ConfigRoot, type InventoryContext } from './inventory.js'
import { snapshotDatabase, type DbSnapshotInfo } from './db-snapshot.js'

export const MANIFEST_FORMAT = 1
const LOCK_STALE_MS = 2 * 60 * 60 * 1000
const STAGING_STALE_MS = 60 * 60 * 1000
export const STAGING_PREFIX = 'backup-stage-'

export type BackupStage = 'collecting' | 'database' | 'encrypting' | 'copying' | 'done'

export interface ManifestFile { path: string; size: number; sha256: string; mode: number }
export interface ManifestLink { path: string; target: string }

export interface BackupManifest {
  format: number
  createdAt: string
  appVersion: string
  appCommit: string
  kind: BackupKind
  db: (Omit<DbSnapshotInfo, 'integrity'> & { integrityCheck: string }) | null
  roots: Record<string, { kind: ConfigRoot['kind']; base: ConfigRoot['base']; rel: string }>
  agents: string[]
  categories: Partial<Record<BackupCategory, string[]>>
  files: ManifestFile[]
  links: ManifestLink[]
  pathHints: { PROJECT_ROOT: string; HOME: string; STORE_DIR: string; projectSlug: string }
  excludedCategories: string[]
  missing: string[]
}

export interface BackupResult {
  ok: boolean
  file?: string
  name?: string
  size?: number
  counts?: Record<string, number>
  durationMs: number
  warnings: string[]
  /** Machine code when ok=false: locked | restore_in_progress | db_integrity | tar_failed | io_error */
  error?: string
  detail?: string
}

export interface CreateBackupOptions {
  kind: BackupKind
  includeLogs?: boolean
  ctx: InventoryContext
  recoveryKey: string
  /** Where the .mbk lands. Default: <storeDir>/backups. */
  outDir?: string
  /** The dashboard's open handle; otherwise the DB file is opened read-only. */
  db?: Database.Database | null
  appVersion?: string
  appCommit?: string
  now?: Date
  onStage?: (stage: BackupStage) => void
  /** Test seam: cheaper scrypt. */
  encrypt?: EncryptOptions
}

/** Claude Code's project-dir encoding of a path (same as projectsDirFor()). */
export function claudeProjectSlug(dir: string): string {
  return dir.replace(/[/.]/g, '-')
}

/** Local wall-clock time with its UTC offset, e.g. 2026-09-25T20:15:00+02:00. */
export function localIso(d: Date): string {
  const pad = (n: number) => String(Math.abs(n)).padStart(2, '0')
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.trunc(off / 60))}:${pad(off % 60)}`
}

export function shortHost(): string {
  const h = String(hostname() || 'host').split('.')[0].toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
  return (h || 'host').slice(0, 24)
}

export function backupFileName(d: Date, host = shortHost()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `marveen-backup-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${host}.mbk`
}

export const BACKUP_NAME_RE = /^marveen-backup-\d{8}-\d{6}-[a-z0-9-]{1,24}(?:-\d+)?\.mbk$/

// ---------------------------------------------------------------------------
// Lock
// ---------------------------------------------------------------------------

export function lockPath(storeDir: string): string {
  return join(storeDir, 'locks', 'backup.lock')
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (e: any) { return e?.code === 'EPERM' }
}

/** Take the shared backup/restore lock; null when someone else holds it. */
export function acquireBackupLock(storeDir: string, purpose: string): (() => void) | null {
  const p = lockPath(storeDir)
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 })
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(p, 'wx', 0o600)
      writeFileSync(fd, JSON.stringify({ pid: process.pid, purpose, at: Date.now() }))
      closeSync(fd)
      return () => { try { unlinkSync(p) } catch { /* already gone */ } }
    } catch (err: any) {
      if (err?.code !== 'EEXIST') throw err
      let stale = false
      try {
        const cur = JSON.parse(readFileSync(p, 'utf8')) as { pid?: number; at?: number }
        stale = !cur.at || Date.now() - cur.at > LOCK_STALE_MS || (typeof cur.pid === 'number' && !pidAlive(cur.pid))
      } catch { stale = true }
      if (!stale) return null
      try { unlinkSync(p) } catch { /* raced */ }
    }
  }
  return null
}

/** Remove staging dirs a crashed run left behind (they hold plaintext secrets). */
export function sweepStaleStaging(storeDir: string, maxAgeMs = STAGING_STALE_MS): number {
  const base = join(storeDir, 'tmp')
  let n = 0
  let names: string[] = []
  try { names = readdirSync(base) } catch { return 0 }
  for (const name of names) {
    if (!name.startsWith(STAGING_PREFIX) && !name.startsWith('restore-stage-')) continue
    const p = join(base, name)
    try {
      if (Date.now() - statSync(p).mtimeMs > maxAgeMs) { rmSync(p, { recursive: true, force: true }); n++ }
    } catch { /* gone */ }
  }
  return n
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readAppVersion(projectRoot: string): string {
  try { return String(JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8')).version || '0.0.0') } catch { return '0.0.0' }
}

function readAppCommit(projectRoot: string): string {
  try {
    return execFileSync('git', ['-C', projectRoot, 'rev-parse', '--short=8', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }).trim()
  } catch { return '' }
}

function sha256File(p: string): string {
  const h = createHash('sha256')
  const fd = openSync(p, 'r')
  try {
    const buf = Buffer.alloc(1 << 20)
    for (let pos = 0; ;) {
      const n = readSync(fd, buf, 0, buf.length, pos)
      if (n <= 0) break
      h.update(buf.subarray(0, n))
      pos += n
    }
  } finally { closeSync(fd) }
  return h.digest('hex')
}

/** Walk the staging tree: regular files get hashed, symlinks recorded. */
export function walkStaged(root: string, rel = ''): { files: ManifestFile[]; links: ManifestLink[] } {
  const files: ManifestFile[] = []
  const links: ManifestLink[] = []
  const dir = rel ? join(root, rel) : root
  for (const name of readdirSync(dir).sort()) {
    const r = rel ? `${rel}/${name}` : name
    const abs = join(root, r)
    const st = lstatSync(abs)
    if (st.isSymbolicLink()) links.push({ path: r, target: readlinkSync(abs) })
    else if (st.isDirectory()) {
      const sub = walkStaged(root, r)
      files.push(...sub.files)
      links.push(...sub.links)
    } else if (st.isFile()) files.push({ path: r, size: st.size, sha256: sha256File(abs), mode: st.mode & 0o777 })
  }
  return { files, links }
}

function runTarInto(stage: string, entries: string[], sink: NodeJS.WritableStream & { on: any }, transform: NodeJS.ReadWriteStream): Promise<void> {
  return new Promise((resolve, reject) => {
    const tar = spawn('tar', ['-czf', '-', '-C', stage, ...entries], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    tar.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    let tarCode: number | null | undefined
    let piped = false
    const settle = () => {
      if (tarCode === undefined || !piped) return
      if (tarCode !== 0) reject(Object.assign(new Error(`tar exited ${tarCode}: ${stderr.trim().slice(0, 400)}`), { code: 'tar_failed' }))
      else resolve()
    }
    tar.on('error', (e) => reject(Object.assign(e, { code: 'tar_failed' })))
    tar.on('close', (code) => { tarCode = code; settle() })
    pipeline(tar.stdout, transform, sink as any).then(() => { piped = true; settle() }, reject)
  })
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function createBackup(opts: CreateBackupOptions): Promise<BackupResult> {
  const t0 = Date.now()
  const { ctx } = opts
  const warnings: string[] = []
  const stage = (s: BackupStage) => { try { opts.onStage?.(s) } catch { /* UI callback must not break a backup */ } }

  if (opts.kind === 'scheduled' && existsSync(join(ctx.storeDir, 'restore-in-progress.json'))) {
    return { ok: false, error: 'restore_in_progress', durationMs: Date.now() - t0, warnings }
  }
  const release = acquireBackupLock(ctx.storeDir, `backup:${opts.kind}`)
  if (!release) return { ok: false, error: 'locked', durationMs: Date.now() - t0, warnings }

  const tmpBase = join(ctx.storeDir, 'tmp')
  let staging = ''
  let partial = ''
  try {
    sweepStaleStaging(ctx.storeDir)
    mkdirSync(tmpBase, { recursive: true, mode: 0o700 })
    try { chmodSync(tmpBase, 0o700) } catch { /* best effort */ }
    staging = mkdtempSync(join(tmpBase, STAGING_PREFIX))
    chmodSync(staging, 0o700)

    // -- 3. inventory -> logical roots
    stage('collecting')
    const inv = collectInventory(ctx, { includeLogs: opts.includeLogs })
    for (const u of inv.unreadable) warnings.push(`unreadable: ${u.path} (${u.error})`)
    const categories: Partial<Record<BackupCategory, string[]>> = {}
    for (const it of inv.items) {
      const dest = join(staging, it.logical)
      try {
        mkdirSync(dirname(dest), { recursive: true, mode: 0o700 })
        cpSync(it.abs, dest, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true, force: true })
        ;(categories[it.category] ??= []).push(it.logical)
      } catch (err: any) {
        warnings.push(`unreadable: ${it.logical} (${err?.code || err?.message || err})`)
      }
    }

    // -- 4. database
    stage('database')
    let dbInfo: BackupManifest['db'] = null
    const dbFile = join(ctx.storeDir, 'claudeclaw.db')
    const storeRel = ctx.storeDir.startsWith(ctx.projectRoot + '/') ? ctx.storeDir.slice(ctx.projectRoot.length + 1) : 'store'
    const dbLogical = `project/${storeRel}/claudeclaw.db`
    if (opts.db || existsSync(dbFile)) {
      const dest = join(staging, dbLogical)
      mkdirSync(dirname(dest), { recursive: true, mode: 0o700 })
      const info = await snapshotDatabase(opts.db ?? dbFile, dest)
      if (info.integrity !== 'ok') {
        return { ok: false, error: 'db_integrity', detail: info.integrity, durationMs: Date.now() - t0, warnings }
      }
      dbInfo = { integrityCheck: info.integrity, counts: info.counts, schemaFingerprint: info.schemaFingerprint, userVersion: info.userVersion }
      categories.database = [dbLogical]
    } else {
      warnings.push('no database file yet (fresh install)')
    }

    // -- 5. local-only git commits
    if (existsSync(join(ctx.projectRoot, '.git'))) {
      const bundle = join(staging, 'project', 'local-commits.bundle')
      mkdirSync(dirname(bundle), { recursive: true, mode: 0o700 })
      try {
        execFileSync('git', ['-C', ctx.projectRoot, 'bundle', 'create', bundle, '--branches', '--not', '--remotes=origin'], { stdio: 'ignore', timeout: 120_000 })
        chmodSync(bundle, 0o600)
        categories.git = ['project/local-commits.bundle']
      } catch {
        // "empty bundle" (everything is pushed) is the good case, not an error.
        rmSync(bundle, { force: true })
      }
    }

    // -- 6. manifest
    const now = opts.now ?? new Date()
    const appVersion = opts.appVersion ?? readAppVersion(ctx.projectRoot)
    const appCommit = opts.appCommit ?? readAppCommit(ctx.projectRoot)
    const walked = walkStaged(staging)
    const manifest: BackupManifest = {
      format: MANIFEST_FORMAT,
      createdAt: localIso(now),
      appVersion,
      appCommit,
      kind: opts.kind,
      db: dbInfo,
      roots: Object.fromEntries(inv.configRoots.map((r) => [`config/${r.owner}`, { kind: r.kind, base: r.base, rel: r.rel }])),
      agents: ctx.agents.map((a) => a.name),
      categories,
      files: walked.files,
      links: walked.links,
      pathHints: { PROJECT_ROOT: ctx.projectRoot, HOME: ctx.home, STORE_DIR: ctx.storeDir, projectSlug: claudeProjectSlug(ctx.projectRoot) },
      excludedCategories: opts.includeLogs ? ['claude-credentials'] : ['logs', 'claude-credentials'],
      missing: inv.missing,
    }
    writeFileSync(join(staging, 'manifest.json'), JSON.stringify(manifest, null, 1), { mode: 0o600 })

    // -- 7. tar | encrypt -> .partial
    stage('encrypting')
    const outDir = opts.outDir ?? join(ctx.storeDir, 'backups')
    mkdirSync(outDir, { recursive: true, mode: 0o700 })
    let name = backupFileName(now)
    for (let i = 2; existsSync(join(outDir, name)); i++) name = name.replace(/(?:-\d+)?\.mbk$/, `-${i}.mbk`)
    const file = join(outDir, name)
    partial = `${file}.partial`
    const enc = encryptStream(opts.recoveryKey, { createdAt: manifest.createdAt, appVersion, appCommit, kind: opts.kind }, opts.encrypt)
    const fdOut = openSync(partial, 'w', 0o600)
    writeFileSync(fdOut, enc.header)
    const sink = createWriteStream('', { fd: fdOut, autoClose: false })
    const entries = readdirSync(staging).sort((a, b) => (a === 'manifest.json' ? -1 : b === 'manifest.json' ? 1 : a.localeCompare(b)))
    try {
      await runTarInto(staging, entries, sink, enc.transform)
      fsyncSync(fdOut)
    } finally { closeSync(fdOut) }

    // -- 8. publish
    stage('copying')
    renameSync(partial, file)
    partial = ''
    try { const d = openSync(outDir, 'r'); try { fsyncSync(d) } finally { closeSync(d) } } catch { /* not all fs allow dir fsync */ }
    const size = statSync(file).size
    stage('done')
    return { ok: true, file, name, size, counts: dbInfo?.counts, durationMs: Date.now() - t0, warnings }
  } catch (err: any) {
    return {
      ok: false,
      error: err?.code === 'tar_failed' ? 'tar_failed' : 'io_error',
      detail: String(err?.message || err).slice(0, 500),
      durationMs: Date.now() - t0,
      warnings,
    }
  } finally {
    if (partial) rmSync(partial, { force: true })
    if (staging) rmSync(staging, { recursive: true, force: true })
    release()
  }
}
