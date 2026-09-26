/**
 * The real-install entry points of the full backup (#396): resolve the live
 * paths, the agents, the destinations and the stored recovery key, and call the
 * engine. The engine modules themselves take everything as arguments so tests
 * run on temp roots.
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { BACKUP_NAME_RE, type BackupStage } from './create.js'
import { defaultInventoryContext } from './inventory.js'
import { getOrCreateKey } from './key-store.js'
import { realDeps } from './destinations.js'
import { runFullBackup, type RunResult } from './pipeline.js'
import type { BackupKind } from './crypto.js'

export async function storeDir(): Promise<string> {
  return (await import('../config.js')).STORE_DIR
}

export function localBackupDir(store: string): string {
  return join(store, 'backups')
}

export async function runBackup(opts: { kind: BackupKind; db?: Database.Database | null; onStage?: (s: BackupStage) => void }): Promise<RunResult> {
  const ctx = await defaultInventoryContext()
  const key = getOrCreateKey(ctx.storeDir)
  const deps = await realDeps(ctx.storeDir)
  return runFullBackup({ kind: opts.kind, ctx, recoveryKey: key.key, deps, db: opts.db ?? null, onStage: opts.onStage })
}

export interface LocalBackupEntry { name: string; file: string; size: number; mtimeMs: number }

/** The .mbk files in a directory, newest first. Throws when the dir cannot be read. */
export function listBackupsIn(dir: string): LocalBackupEntry[] {
  let names: string[]
  try { names = readdirSync(dir) } catch (err: any) {
    if (err?.code === 'ENOENT') return []
    throw err
  }
  return names
    .filter((n) => BACKUP_NAME_RE.test(n))
    .map((name) => {
      const file = join(dir, name)
      const st = statSync(file)
      return { name, file, size: st.size, mtimeMs: st.mtimeMs }
    })
    .sort((a, b) => b.name.localeCompare(a.name))
}

/**
 * Verify in a CHILD process (#396 Phase 6): the trial restore runs the DB
 * migrations through src/db.ts's single global handle, which must never be the
 * dashboard's own. The child records the result in store/backup-state.json.
 */
export async function spawnVerify(args: string[]): Promise<boolean> {
  const { PROJECT_ROOT } = await import('../config.js')
  const cli = join(PROJECT_ROOT, 'dist', 'backup', 'cli.js')
  if (!existsSync(cli)) return false
  const child = spawn(process.execPath, [cli, ...args], { detached: true, stdio: 'ignore' })
  child.on('error', () => { /* reported by the missing state update */ })
  child.unref()
  return true
}
