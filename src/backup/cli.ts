/**
 * Terminal / systemd entry point of the full backup (#396).
 *
 *   node dist/backup/cli.js create [--kind scheduled|manual]
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
    const r = await runBackup({ kind })
    if (r.skipped) { console.log('backup: skipped (a backup succeeded less than an hour ago)'); return 0 }
    for (const w of r.warnings) console.error(`backup: warning: ${w}`)
    if (!r.ok) {
      console.error(`backup: FAILED (${r.error})${r.detail ? `: ${r.detail}` : ''}`)
      return r.error === 'locked' || r.error === 'restore_in_progress' ? 75 : 1
    }
    console.log(`backup: wrote ${r.file} (${r.size} bytes, ${r.durationMs} ms)`)
    for (const x of r.replicas ?? []) {
      if (x.dest === 'local') continue
      console.log(`backup: copy to ${x.dest}: ${x.ok ? 'ok' : `NOT DONE (${x.reason}${x.detail ? `: ${x.detail}` : ''})`}`)
    }
    for (const [dest, names] of Object.entries(r.pruned ?? {})) console.log(`backup: pruned ${names?.length} old backup(s) from ${dest}`)
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
  if (cmd === 'restore') return restoreCmd(argv)
  console.error('usage: cli.js create [--kind scheduled|manual] | verify <file> [--key K] | list | restore <file> --unit <dashboard.service> [--key K] [--exclude a,b] [--yes]')
  return 2
}

/**
 * The terminal path of a restore (docs/MIGRATION.md appendix). Same engine as
 * Settings -> Backup: preview first; with --yes the pre-restore backup, then
 * the runner steps in THIS process (it is outside the dashboard's service, so
 * stopping that does not stop us).
 */
async function restoreCmd(argv: string[]): Promise<number> {
  const file = argv[1]
  const unit = arg(argv, '--unit')
  if (!file || !unit) {
    console.error('usage: restore <file> --unit <the dashboard service, e.g. marveen-dashboard.service> [--key K] [--exclude skills,schedules] [--yes]')
    console.error('       list the units with: systemctl --user list-units --type=service')
    return 2
  }
  const { defaultInventoryContext } = await import('./inventory.js')
  const { openPreview, startRestore, RestoreError } = await import('./restore-service.js')
  const { runRestore, systemdHooks } = await import('./restore-runner.js')
  const ctx = await defaultInventoryContext()
  const rctx = { projectRoot: ctx.projectRoot, storeDir: ctx.storeDir, home: ctx.home }
  const { readFileSync, existsSync } = await import('node:fs')
  const appVersion = String(JSON.parse(readFileSync(join(ctx.projectRoot, 'package.json'), 'utf8')).version)
  try {
    const dbFile = join(ctx.storeDir, 'claudeclaw.db')
    const { id, inspection: ins } = await openPreview({ file, uploaded: false, key: arg(argv, '--key'), ctx: rctx, appVersion, currentDb: existsSync(dbFile) ? dbFile : null })
    console.log(`backup made ${ins.manifest.createdAt} by Marveen ${ins.manifest.appVersion}; compatible: ${ins.compat.ok ? 'yes' : `NO (${ins.compat.reason})`}`)
    for (const c of ins.categories) console.log(`  ${c.id}: ${c.willAdd} new, ${c.willOverwrite} overwritten, ${c.held} held until you confirm`)
    for (const t of ['kanban_cards', 'memories']) console.log(`  ${t}: now ${ins.dbCounts.current?.[t] ?? 0} -> backup ${ins.dbCounts.backup[t] ?? 0}`)
    for (const w of ins.warnings) console.log(`  warning: ${w.code}${w.items ? `: ${w.items.slice(0, 5).join(', ')}` : ''}`)
    if (!argv.includes('--yes')) { console.log('nothing changed. Run again with --yes to restore.'); return 0 }
    const exclude = (arg(argv, '--exclude') ?? '').split(',').map((x) => x.trim()).filter(Boolean) as any
    let planFile = ''
    await startRestore(id, exclude, {
      ctx: rctx, unit,
      preBackup: async () => runBackup({ kind: 'pre-restore' }),
      launch: (f) => { planFile = f },
    })
    const plan = JSON.parse(readFileSync(planFile, 'utf8'))
    const out = await runRestore(plan, systemdHooks(unit))
    console.log(out.ok ? 'restore: done. Log in each agent again, then confirm in Settings -> Backup that the old machine is off.' : `restore: FAILED (${out.reason})${out.rolledBack ? ' -- rolled back' : ''}`)
    return out.ok ? 0 : 1
  } catch (err: any) {
    if (err instanceof RestoreError || err instanceof BackupDecryptError) { console.error(`restore: refused (${err.code})`); return 1 }
    throw err
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => { console.error(`backup: FAILED: ${err?.stack || err}`); process.exit(1) },
  )
}
