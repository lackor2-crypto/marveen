/**
 * Consistent database snapshot for a backup (#396, plan §2.1 / §2.2).
 *
 * The old scripts/backup.sh ran `PRAGMA wal_checkpoint` and then tarred the DB
 * together with its -wal/-shm: a write between the two gave a torn copy. Here
 * the SQLite Online Backup API (better-sqlite3 `db.backup()`) copies a
 * consistent snapshot while the dashboard keeps writing; `VACUUM INTO` is the
 * fallback when backup() throws. The copy is then switched out of WAL mode (a
 * self-contained single file, no sidecars) and checked with
 * `PRAGMA integrity_check` before it goes into the archive.
 */
import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'

export interface DbSnapshotInfo {
  integrity: 'ok' | string
  counts: Record<string, number>
  schemaFingerprint: string
  userVersion: number
}

/** Plain (non-virtual) user tables of a database, sorted. */
function plainTables(db: Database.Database): string[] {
  const rows = db.prepare(
    "SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all() as { name: string; sql: string | null }[]
  const virtual = new Set(rows.filter((r) => /^\s*CREATE\s+VIRTUAL/i.test(r.sql ?? '')).map((r) => r.name))
  // Shadow tables of a virtual table (fts5 `<t>_data`, `<t>_idx`, ...) belong to
  // it; their row counts are internal and change on every optimize.
  return rows
    .map((r) => r.name)
    .filter((n) => !virtual.has(n) && ![...virtual].some((v) => n.startsWith(`${v}_`)))
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

/** Row counts, schema fingerprint and user_version of an open database. */
export function describeDatabase(db: Database.Database): Omit<DbSnapshotInfo, 'integrity'> {
  const tables = plainTables(db)
  const counts: Record<string, number> = {}
  const shape: string[] = []
  for (const t of tables) {
    try {
      counts[t] = (db.prepare(`SELECT count(*) AS n FROM ${quoteIdent(t)}`).get() as { n: number }).n
    } catch { /* a table the build cannot read: leave it out of the counts */ }
    try {
      const cols = (db.prepare(`PRAGMA table_info(${quoteIdent(t)})`).all() as { name: string }[]).map((c) => c.name).sort()
      shape.push(`${t}:${cols.join(',')}`)
    } catch { shape.push(`${t}:?`) }
  }
  const schemaFingerprint = createHash('sha256').update(shape.sort().join('\n')).digest('hex')
  const userVersion = Number(db.pragma('user_version', { simple: true }) ?? 0)
  return { counts, schemaFingerprint, userVersion }
}

/** Open a database file read-only and describe it, integrity check included. */
export function inspectDatabaseFile(file: string): DbSnapshotInfo {
  const db = new Database(file, { readonly: true, fileMustExist: true })
  try {
    const rows = db.pragma('integrity_check') as { integrity_check: string }[]
    const integrity = rows.length === 1 && rows[0].integrity_check === 'ok'
      ? 'ok'
      : rows.map((r) => r.integrity_check).slice(0, 5).join('; ')
    return { integrity, ...describeDatabase(db) }
  } finally { db.close() }
}

/**
 * #860: the same inspection off the main thread. `PRAGMA integrity_check` plus a count(*) per table is synchronous
 * in better-sqlite3 and held the whole dashboard for ~3.3 s on the 153 MB database (the stall sampler caught it in
 * describeDatabase). The compiled build runs it in a worker thread; a source run (vitest, tsx) has no compiled worker
 * file beside it and keeps the inline call, which returns the very same value.
 */
export function inspectDatabaseFileAsync(file: string): Promise<DbSnapshotInfo> {
  const here = fileURLToPath(import.meta.url)
  if (!here.endsWith('.js')) return Promise.resolve().then(() => inspectDatabaseFile(file))
  return new Promise<DbSnapshotInfo>((resolve, reject) => {
    const w = new Worker(join(dirname(here), 'db-inspect-worker.js'), { workerData: { file } })
    w.once('message', (m: { ok: boolean; info?: DbSnapshotInfo; error?: string }) => (m.ok && m.info ? resolve(m.info) : reject(new Error(m.error || 'inspect failed'))))
    w.once('error', reject)
    w.once('exit', (code) => { if (code !== 0) reject(new Error(`inspect worker exited with ${code}`)) })
  })
}

/**
 * Snapshot `source` (an open handle -- the dashboard's own -- or a DB file path)
 * into `destFile`. The destination must not exist yet.
 */
export async function snapshotDatabase(source: Database.Database | string, destFile: string): Promise<DbSnapshotInfo> {
  const ownHandle = typeof source === 'string'
  // A separate process (the CLI under the systemd timer) opens its own
  // connection. Read-only is enough for the backup API and cannot disturb the
  // dashboard's writes.
  const db = ownHandle ? new Database(source, { readonly: true, fileMustExist: true }) : source
  try {
    try {
      await db.backup(destFile)
    } catch {
      rmSync(destFile, { force: true })
      db.exec(`VACUUM INTO '${destFile.replace(/'/g, "''")}'`)
    }
  } finally {
    if (ownHandle) db.close()
  }
  // The copy inherits the WAL flag in its header; switch it to a plain rollback
  // journal so the file is complete on its own and opening it never needs a
  // -wal next to it (a stale -wal would replay old pages over a restored DB).
  const copy = new Database(destFile)
  try { copy.pragma('journal_mode = DELETE') } finally { copy.close() }
  for (const side of ['-wal', '-shm', '-journal']) {
    if (existsSync(destFile + side)) rmSync(destFile + side, { force: true })
  }
  try { chmodSync(destFile, 0o600) } catch { /* best effort; staging dir is 0700 */ }
  return inspectDatabaseFileAsync(destFile)
}
