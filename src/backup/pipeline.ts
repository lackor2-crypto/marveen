/**
 * One complete backup run (#396 Phase 2): make the file, record it, copy it to
 * every enabled destination, prune each destination by its own policy, record
 * everything in store/backup-state.json. Used by the dashboard (button, daily
 * timer) and by the CLI (the 6-hourly systemd unit) alike, so the two triggers
 * cannot drift apart.
 */
import type Database from 'better-sqlite3'
import { createBackup, acquireBackupLock, type BackupResult, type BackupStage } from './create.js'
import { keyIdOf, type BackupKind, type EncryptOptions } from './crypto.js'
import type { InventoryContext } from './inventory.js'
import { prunePreviousKeys } from './key-store.js'
import {
  listDestination, readConfig, removeFromDestination, replicate, resolveDestinations,
  type DestinationDeps, type ReplicaResult,
} from './destinations.js'
import { planPrune, POLICIES, timeFromName, type BackupEntry } from './retention.js'
import { readState, updateState } from './state.js'

/** A scheduled run is skipped when one succeeded this recently (timer + systemd double-fire). */
export const RECENT_SUCCESS_MS = 60 * 60 * 1000

export interface RunResult extends BackupResult {
  skipped?: boolean
  replicas?: ReplicaResult[]
  pruned?: Partial<Record<string, string[]>>
}

export interface RunOptions {
  kind: BackupKind
  ctx: InventoryContext
  recoveryKey: string
  deps: DestinationDeps
  db?: Database.Database | null
  onStage?: (s: BackupStage) => void
  now?: () => number
  encrypt?: EncryptOptions
  appVersion?: string
  appCommit?: string
}

export async function runFullBackup(o: RunOptions): Promise<RunResult> {
  const now = o.now ?? Date.now
  const storeDir = o.ctx.storeDir
  const cfg = readConfig(storeDir)
  if (o.kind === 'scheduled') {
    const st = readState(storeDir)
    if (st.lastSuccessAt && now() - st.lastSuccessAt < RECENT_SUCCESS_MS) {
      return { ok: true, skipped: true, durationMs: 0, warnings: [] }
    }
  }
  const r = await createBackup({
    kind: o.kind, ctx: o.ctx, recoveryKey: o.recoveryKey, db: o.db, includeLogs: cfg.includeLogs,
    onStage: (s) => { if (s !== 'done') o.onStage?.(s) }, encrypt: o.encrypt,
    appVersion: o.appVersion, appCommit: o.appCommit,
  })
  // A refused start (another run holds the lock) is not a failed backup.
  if (!r.ok && (r.error === 'locked' || r.error === 'restore_in_progress')) return r
  updateState(storeDir, (s) => {
    s.lastRun = { at: now(), kind: o.kind, ok: r.ok, name: r.name, error: r.error, detail: r.detail, durationMs: r.durationMs, warnings: r.warnings.slice(0, 20) }
    if (r.ok && r.name) {
      s.lastSuccessAt = now()
      s.lastSuccessName = r.name
      ;(s.backups ??= {})[r.name] = { kind: o.kind, keyId: keyIdOf(o.recoveryKey), createdAt: now(), size: r.size }
    }
  })
  if (!r.ok || !r.file || !r.name) return r

  // The pre-restore copy is the state being replaced: it stays on this machine.
  let replicas: ReplicaResult[] = [{ dest: 'local', ok: true, reachable: true }]
  if (o.kind !== 'pre-restore') {
    o.onStage?.('copying')
    replicas = await replicate(r.file, r.name, cfg, o.deps)
  }
  updateState(storeDir, (s) => {
    s.replicas ??= {}
    for (const x of replicas) s.replicas[x.dest] = { at: now(), ok: x.ok, reachable: x.reachable, reason: x.reason, detail: x.detail, name: r.name }
  })

  const pruned = await pruneAll(o, r.name)
  o.onStage?.('done')
  return { ...r, replicas, pruned }
}

/** Apply each destination's retention. A destination whose listing failed is left alone. */
export async function pruneAll(o: Pick<RunOptions, 'ctx' | 'deps'>, justMade?: string): Promise<Partial<Record<string, string[]>>> {
  const storeDir = o.ctx.storeDir
  const cfg = readConfig(storeDir)
  const known = readState(storeDir).backups ?? {}
  const out: Partial<Record<string, string[]>> = {}
  const release = acquireBackupLock(storeDir, 'prune')
  if (!release) return out
  try {
    for (const d of resolveDestinations(cfg, o.deps)) {
      if (!d.enabled) continue
      const listing = await listDestination(d, o.deps)
      if (!listing.ok) continue
      const entries: BackupEntry[] = listing.files.map((f) => ({
        name: f.name, time: timeFromName(f.name), kind: known[f.name]?.kind, verified: known[f.name]?.verified === true,
      }))
      const policy = d.id === 'local' ? POLICIES.local : d.id === 'depot' ? POLICIES.depot : POLICIES.cloud
      const { drop } = planPrune(entries, policy)
      const removed: string[] = []
      for (const e of drop) {
        if (e.name === justMade) continue
        const f = listing.files.find((x) => x.name === e.name)!
        try { await removeFromDestination(d, f, o.deps); removed.push(e.name) } catch { /* next run retries */ }
      }
      if (removed.length) out[d.id] = removed
    }
    // Keys no retained backup needs any more can go (the kit then lists fewer).
    const inUse = new Set<string>()
    const st = readState(storeDir)
    const gone = new Set(Object.values(out).flat() as string[])
    for (const [name, b] of Object.entries(st.backups ?? {})) if (!gone.has(name)) inUse.add(b.keyId)
    // Only with a real record to judge by: a lost/empty state file must never
    // make old keys disappear (the backups made with them may still exist).
    if (Object.keys(st.backups ?? {}).length > 0) prunePreviousKeys(storeDir, inUse)
  } finally { release() }
  return out
}
