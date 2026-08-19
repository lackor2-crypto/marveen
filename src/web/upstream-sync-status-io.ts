// I/O for the upstream-sync snapshot written by
// scripts/upstream-divergence-check.sh (weekly timer + manual runs).
// Pure JSON read, no git calls here -- this module only reads the file.
//
// The header used to name a "monthly marveen-upstream-divergence-check
// scheduled task". Measured 2026-08-19: no such task existed in
// scheduled_tasks, and nothing in the repo ever wrote this file -- the
// snapshot was hand-typed once on 2026-08-10 and frozen there. Two of its
// numbers were not reproducible from git (cleanFileCount 110 vs the real
// 108, aheadCount 95 vs the real 87). Hence the shell script, and hence the
// staleness fields below: a number the reader cannot date is a number the
// reader cannot distrust.

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../config.js'

const STATUS_PATH = join(PROJECT_ROOT, 'store', 'upstream-sync-status.json')

export interface UpstreamSyncStatus {
  checkedAt: string | null
  aheadCount: number | null
  behindCount: number | null
  conflictingFiles: string[]
  conflictCount: number | null
  cleanFileCount: number | null
  // Which two points were compared. Without these the numbers are
  // unfalsifiable: "63 new commits" means nothing until you know it was
  // main against upstream/develop.
  localRef: string | null
  upstreamRef: string | null
  // False when the run could not reach the network, so the upstream side of
  // the comparison is whatever was last fetched, not what is there now.
  fetchOk: boolean
  // How old the measurement is, in whole days, computed server-side so the
  // browser clock cannot disagree with the server about staleness.
  ageDays: number | null
}

// A measurement older than this is reported as stale. The timer runs
// weekly, so ten days means two missed runs -- late enough that the
// silence is real, early enough that the Boss is not looking at numbers
// from another era. The 2026-08-10 snapshot sat here for nine days
// looking exactly as authoritative on day nine as on day one.
export const STALE_AFTER_DAYS = 10

export function ageInDays(checkedAt: string | null, now: number): number | null {
  if (!checkedAt) return null
  const t = Date.parse(checkedAt)
  if (!Number.isFinite(t)) return null
  // A clock skew that puts the file in the future is not "negative days
  // old"; it is zero days old plus a clock problem.
  return Math.max(0, Math.floor((now - t) / 86_400_000))
}

export function readUpstreamSyncStatus(now: number = Date.now()): UpstreamSyncStatus | null {
  if (!existsSync(STATUS_PATH)) return null
  try {
    const raw = JSON.parse(readFileSync(STATUS_PATH, 'utf-8'))
    if (!raw || typeof raw !== 'object') return null
    const o = raw as Record<string, unknown>
    const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
    const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)
    const files = Array.isArray(o.conflictingFiles)
      ? o.conflictingFiles.filter((f): f is string => typeof f === 'string')
      : []
    const checkedAt = typeof o.checkedAt === 'string' ? o.checkedAt : null
    return {
      checkedAt,
      aheadCount: num(o.aheadCount),
      behindCount: num(o.behindCount),
      conflictingFiles: files,
      conflictCount: num(o.conflictCount) ?? files.length,
      cleanFileCount: num(o.cleanFileCount),
      localRef: str(o.localRef),
      upstreamRef: str(o.upstreamRef),
      // Pre-script snapshots have no fetchOk field. Absent is not "yes":
      // an unknown network state is reported the same as a failed one, so
      // the card never claims freshness it cannot back up.
      fetchOk: o.fetchOk === true,
      ageDays: ageInDays(checkedAt, now),
    }
  } catch {
    return null
  }
}
