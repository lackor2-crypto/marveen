/**
 * store/backup-state.json -- what the last backup runs did (#396 Phase 2):
 * the last run, the last success, per-destination replica results, the last
 * verify, and what is known about each backup file (kind, key id, verified).
 * The health check (system-health.ts) and the Settings -> Backup page read it.
 *
 * Written by both the dashboard and the CLI (the systemd timer), always as an
 * atomic whole-file replace, so a reader never sees half a file.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteFileSync } from '../web/atomic-write.js'
import type { BackupKind } from './crypto.js'
import type { DestinationId } from './destinations.js'

export interface ReplicaState { at: number; ok: boolean; reachable: boolean; reason?: string; detail?: string; name?: string }

export interface KnownBackup { kind: BackupKind; keyId: string; createdAt: number; size?: number; verified?: boolean; verifiedAt?: number; verifyReason?: string }

export interface BackupState {
  lastRun?: { at: number; kind: BackupKind; ok: boolean; name?: string; error?: string; detail?: string; durationMs: number; warnings?: string[] }
  lastSuccessAt?: number
  lastSuccessName?: string
  /** Wall-clock day (in the install's timezone) of the last scheduled attempt. */
  lastScheduledDay?: string
  replicas?: Partial<Record<DestinationId, ReplicaState>>
  lastVerify?: { at: number; ok: boolean; name: string; reason?: string; detail?: string }
  lastVerifyStartedAt?: number
  lastOffsiteStartedAt?: number
  lastOffsiteVerify?: { at: number; ok: boolean; name: string; reason?: string; detail?: string }
  backups?: Record<string, KnownBackup>
}

const MAX_KNOWN = 300

export function statePath(storeDir: string): string {
  return join(storeDir, 'backup-state.json')
}

export function readState(storeDir: string): BackupState {
  const p = statePath(storeDir)
  if (!existsSync(p)) return {}
  try {
    const s = JSON.parse(readFileSync(p, 'utf8'))
    return s && typeof s === 'object' ? s as BackupState : {}
  } catch { return {} }
}

export function stateExists(storeDir: string): boolean {
  return existsSync(statePath(storeDir))
}

export function updateState(storeDir: string, fn: (s: BackupState) => void): BackupState {
  const s = readState(storeDir)
  fn(s)
  if (s.backups) {
    const names = Object.keys(s.backups).sort()
    for (const n of names.slice(0, Math.max(0, names.length - MAX_KNOWN))) delete s.backups[n]
  }
  mkdirSync(storeDir, { recursive: true })
  atomicWriteFileSync(statePath(storeDir), JSON.stringify(s, null, 1) + '\n', { mode: 0o600 })
  return s
}
