/**
 * Terminal / systemd entry point of the full backup (#396).
 *
 *   node dist/backup/cli.js create [--kind scheduled|manual] [--include-logs]
 *   node dist/backup/cli.js verify <file> [--key <recovery key>]
 *   node dist/backup/cli.js list
 *
 * scripts/backup.sh (the 6-hourly unit) calls `create --kind scheduled`.
 * Exit codes: 0 ok, 1 failure, 2 usage, 75 skipped (locked / restore running).
 */
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readHeader, BackupDecryptError, type BackupKind } from './crypto.js'
import { extractBackup, checkManifestHashes } from './extract.js'
import { inspectDatabaseFile } from './db-snapshot.js'
import { findKeyById } from './key-store.js'
import { runBackup, storeDir, listBackupsIn, localBackupDir } from './service.js'

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}

export async function main(argv: string[]): Promise<number> {
  const cmd = argv[0]
  if (cmd === 'create') {
    const kind = (arg(argv, '--kind') ?? 'manual') as BackupKind
    if (!['scheduled', 'manual', 'pre-restore'].includes(kind)) { console.error('backup: unknown --kind'); return 2 }
    const r = await runBackup({ kind, includeLogs: argv.includes('--include-logs') })
    for (const w of r.warnings) console.error(`backup: warning: ${w}`)
    if (!r.ok) {
      console.error(`backup: FAILED (${r.error})${r.detail ? `: ${r.detail}` : ''}`)
      return r.error === 'locked' || r.error === 'restore_in_progress' ? 75 : 1
    }
    console.log(`backup: wrote ${r.file} (${r.size} bytes, ${r.durationMs} ms)`)
    return 0
  }
  if (cmd === 'list') {
    const store = await storeDir()
    for (const b of listBackupsIn(localBackupDir(store))) console.log(`${b.name}\t${b.size}`)
    return 0
  }
  if (cmd === 'verify') {
    const file = argv[1]
    if (!file) { console.error('usage: verify <file> [--key <recovery key>]'); return 2 }
    const store = await storeDir()
    let key = arg(argv, '--key')
    if (!key) {
      const { header } = readHeader(file)
      key = findKeyById(store, header.keyId)?.key
      if (!key) { console.error(`backup: no stored key with id ${header.keyId}; pass --key`); return 2 }
    }
    const base = join(store, 'tmp')
    mkdirSync(base, { recursive: true, mode: 0o700 })
    const dir = mkdtempSync(join(base, 'restore-stage-'))
    try {
      const { manifest } = await extractBackup(file, key, dir)
      const h = checkManifestHashes(dir, manifest)
      if (h.missing.length || h.mismatched.length) {
        console.error(`backup: verify FAILED: ${h.missing.length} missing, ${h.mismatched.length} damaged file(s)`)
        return 1
      }
      const dbPath = manifest.categories.database?.[0]
      if (dbPath) {
        const info = inspectDatabaseFile(join(dir, dbPath))
        if (info.integrity !== 'ok') { console.error(`backup: verify FAILED: database integrity: ${info.integrity}`); return 1 }
      }
      console.log(`backup: verify ok (${manifest.files.length} files, created ${manifest.createdAt})`)
      return 0
    } catch (err) {
      if (err instanceof BackupDecryptError) { console.error(`backup: verify FAILED (${err.code}): ${err.message}`); return 1 }
      throw err
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
  console.error('usage: cli.js create [--kind scheduled|manual] [--include-logs] | verify <file> [--key K] | list')
  return 2
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => { console.error(`backup: FAILED: ${err?.stack || err}`); process.exit(1) },
  )
}
