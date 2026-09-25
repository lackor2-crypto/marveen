/**
 * The real-install entry points of the full backup (#396): resolve the live
 * paths, the agents, the destinations and the stored recovery key, and call the
 * engine. The engine modules themselves take everything as arguments so tests
 * run on temp roots.
 */
import { readdirSync, statSync } from 'node:fs'
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
