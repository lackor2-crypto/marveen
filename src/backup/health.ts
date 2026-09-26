/**
 * Backup health for the Overview self-check (#396, plan §9). One row at most:
 * the worst thing that is true, so backup never takes more than its line.
 *
 * The two meanings of zero are kept apart: "no backup yet on a fresh install"
 * is neutral, "no backup on an install that has data" is bad; "the depot has
 * no copy" is told apart from "the depot is not reachable".
 */
import type { HealthRow } from '../web/system-health.js'
import { readState, stateExists, type BackupState } from './state.js'
import { readConfig, type Destination } from './destinations.js'
import { readKeyFile } from './key-store.js'
import { heldPending } from './restore.js'

const HOUR = 60 * 60 * 1000
export const STALE_MS = 36 * HOUR
export const DEAD_MS = 72 * HOUR

export interface HealthInput {
  now: number
  state: BackupState
  stateExists: boolean
  /** Newest .mbk in store/backups (mtime), if any. */
  newestLocalMs: number | null
  destinations: Destination[]
  kitConfirmed: boolean | null
  /** DB has no cards and no memories: nothing to protect yet. */
  freshInstall: boolean
  scheduleTime: string
  /** A restore holds the channels and schedules until the owner confirms the old machine is off. */
  channelsHeld?: boolean
}

export function backupHealthRow(i: HealthInput): HealthRow {
  // First: after a restore, Telegram & co. stay silent until the owner says the
  // old machine is off. Nothing else about backup matters as much right then.
  if (i.channelsHeld) return { id: 'backup_channels_held', status: 'warn' }
  const last = i.state.lastSuccessAt ?? i.newestLocalMs ?? null
  if (!last) {
    if (i.state.lastRun && !i.state.lastRun.ok) return { id: 'backup_failed', status: 'bad', params: { code: i.state.lastRun.error ?? '?' } }
    return i.freshInstall
      ? { id: 'backup_none_yet', status: 'ok', params: { time: i.scheduleTime } }
      : { id: 'backup_missing', status: 'bad' }
  }
  const hours = Math.floor((i.now - last) / HOUR)
  if (i.state.lastRun && !i.state.lastRun.ok && i.state.lastRun.at > last) {
    return { id: 'backup_failed', status: 'bad', params: { code: i.state.lastRun.error ?? '?' } }
  }
  if (i.state.lastVerify && !i.state.lastVerify.ok) return { id: 'backup_verify_failed', status: 'bad' }
  // The downloaded cloud copy did not verify: the off-site copy is not good.
  // (A download that could not even start is a reachability matter, not this.)
  if (i.state.lastOffsiteVerify && !i.state.lastOffsiteVerify.ok && i.state.lastOffsiteVerify.reason === 'verify failed') {
    return { id: 'backup_verify_failed', status: 'bad' }
  }
  if (i.now - last >= DEAD_MS) return { id: 'backup_stale', status: 'bad', params: { h: hours } }
  if (i.now - last >= STALE_MS) return { id: 'backup_stale', status: 'warn', params: { h: hours } }

  const reps = i.state.replicas ?? {}
  const depot = i.destinations.find((d) => d.id === 'depot')
  const cloud = i.destinations.find((d) => d.id === 'cloud')
  if (depot?.enabled && reps.depot && !reps.depot.ok) {
    return { id: reps.depot.reachable ? 'backup_depot_failed' : 'backup_depot_unreachable', status: 'warn' }
  }
  if (cloud?.enabled && reps.cloud && !reps.cloud.ok) {
    return { id: reps.cloud.reachable ? 'backup_cloud_failed' : 'backup_cloud_unreachable', status: 'warn' }
  }
  const copies = 1 + (depot?.enabled && reps.depot?.ok ? 1 : 0) + (cloud?.enabled && reps.cloud?.ok ? 1 : 0)
  if (copies < 2) return { id: 'backup_single_copy', status: 'warn', params: { h: hours } }
  if (i.kitConfirmed === false) return { id: 'backup_kit_unconfirmed', status: 'warn', params: { h: hours } }
  return { id: 'backup_ok_copies', status: 'ok', params: { h: hours, n: copies } }
}

/** The row for this install, reading the state, config and key files. */
export function computeBackupHealth(o: { storeDir: string; destinations: Destination[]; newestLocalMs: number | null; freshInstall: boolean; now?: number }): HealthRow {
  const cfg = readConfig(o.storeDir)
  let kitConfirmed: boolean | null = null
  try { const k = readKeyFile(o.storeDir); kitConfirmed = k ? k.current.confirmedAt != null : null } catch { kitConfirmed = false }
  return backupHealthRow({
    now: o.now ?? Date.now(),
    state: readState(o.storeDir),
    stateExists: stateExists(o.storeDir),
    newestLocalMs: o.newestLocalMs,
    destinations: o.destinations,
    kitConfirmed,
    freshInstall: o.freshInstall,
    scheduleTime: cfg.schedule.time,
    channelsHeld: heldPending(o.storeDir),
  })
}
