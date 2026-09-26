/**
 * Does this backup really restore? (#396 Phase 6 -- the "0" of 3-2-1-1-0:
 * zero errors on a VERIFIED restore, Proxmox-style verify jobs.)
 *
 *   decrypt -> every sha256 -> DB integrity_check -> TRIAL RESTORE into a
 *   throwaway root (the same plan + moves as a real restore) -> the app's own
 *   DB migrations run against the restored copy -> counts compared again.
 *
 * The migrations open the database through src/db.ts, which keeps ONE global
 * handle -- so the real verify always runs in a child process (the CLI), never
 * inside the dashboard. The migrate step is injected for that reason.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { extractBackup, checkManifestHashes } from './extract.js'
import { inspectDatabaseFile } from './db-snapshot.js'
import { buildRestorePlan, applyRestore, postRestoreCheck } from './restore.js'
import { BackupDecryptError } from './crypto.js'

export interface VerifyResult {
  ok: boolean
  stage: 'decrypt' | 'hashes' | 'database' | 'trial_restore' | 'migrate' | 'counts' | 'done'
  reason?: string
  files?: number
  counts?: Record<string, number>
}

export async function verifyBackup(o: {
  file: string
  recoveryKey: string
  /** Where the scratch dirs go (under store/tmp on a real install). */
  scratchBase: string
  /** Run the app's migrations against a DB file (child process only). */
  migrate?: (dbFile: string) => void | Promise<void>
}): Promise<VerifyResult> {
  mkdirSync(o.scratchBase, { recursive: true, mode: 0o700 })
  const stage = mkdtempSync(join(o.scratchBase, 'restore-stage-verify-'))
  const trial = mkdtempSync(join(o.scratchBase, 'restore-stage-trial-'))
  try {
    let manifest
    try {
      manifest = (await extractBackup(o.file, o.recoveryKey, stage)).manifest
    } catch (e) {
      return { ok: false, stage: 'decrypt', reason: e instanceof BackupDecryptError ? e.code : String((e as Error)?.message || e) }
    }
    const h = checkManifestHashes(stage, manifest)
    if (h.missing.length || h.mismatched.length) {
      return { ok: false, stage: 'hashes', reason: `${h.missing.length} missing, ${h.mismatched.length} damaged`, files: manifest.files.length }
    }
    const dbLogical = manifest.categories.database?.[0]
    if (dbLogical) {
      let integrity: string
      try { integrity = inspectDatabaseFile(join(stage, dbLogical)).integrity } catch (e: any) { integrity = String(e?.message || e) }
      if (integrity !== 'ok') return { ok: false, stage: 'database', reason: integrity, files: manifest.files.length }
    }
    // Trial restore: a fresh, empty "machine" with other paths.
    const ctx = { projectRoot: join(trial, 'project'), storeDir: join(trial, 'project', 'store'), home: join(trial, 'home') }
    mkdirSync(ctx.storeDir, { recursive: true })
    mkdirSync(ctx.home, { recursive: true })
    const plan = buildRestorePlan({ id: 'verify', file: o.file, stagingDir: stage, manifest, ctx })
    // A config dir recorded with an absolute path outside home would resolve to
    // that REAL path: a trial must never write outside its own throwaway root.
    plan.items = plan.items.filter((i) => i.target.startsWith(trial + '/'))
    try { applyRestore(plan) } catch (e: any) {
      return { ok: false, stage: 'trial_restore', reason: String(e?.message || e).slice(0, 300) }
    }
    const restoredDb = join(ctx.storeDir, 'claudeclaw.db')
    if (dbLogical && o.migrate) {
      try { await o.migrate(restoredDb) } catch (e: any) {
        return { ok: false, stage: 'migrate', reason: String(e?.message || e).slice(0, 300) }
      }
    }
    const check = postRestoreCheck(ctx.storeDir, manifest.db?.counts ?? {})
    if (!check.ok) return { ok: false, stage: 'counts', reason: check.reason }
    return { ok: true, stage: 'done', files: manifest.files.length, counts: manifest.db?.counts }
  } finally {
    rmSync(stage, { recursive: true, force: true })
    rmSync(trial, { recursive: true, force: true })
  }
}
