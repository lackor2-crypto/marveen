/**
 * Which backups to keep, per destination (#396, plan Phase 2).
 *
 * Grandfather-father-son: the newest backup of each of the last N days, weeks
 * and months that HAVE a backup (restic's --keep-daily semantics: a period
 * without a backup does not use up a slot), plus the newest `last` ones.
 *
 * Hard rules, stronger than any policy:
 *   - the newest VERIFIED backup is never dropped;
 *   - a pre-restore backup younger than 30 days is never dropped;
 *   - the newest backup is never dropped;
 *   - a failed listing prunes nothing ("0 files" is not "nothing there", §9)
 *     -- enforced by the caller: planPrune only ever sees a real listing.
 */
import type { BackupKind } from './crypto.js'

export interface BackupEntry {
  name: string
  /** ms since epoch, from the file name (local wall clock at creation). */
  time: number
  kind?: BackupKind
  verified?: boolean
}

export interface RetentionPolicy { last?: number; daily?: number; weekly?: number; monthly?: number }

export const POLICIES: Record<'local' | 'depot' | 'cloud', RetentionPolicy> = {
  local: { last: 3 },
  depot: { daily: 7, weekly: 4, monthly: 6 },
  cloud: { daily: 7, weekly: 4, monthly: 3 },
}

const PRE_RESTORE_KEEP_MS = 30 * 24 * 60 * 60 * 1000

/** marveen-backup-YYYYmmdd-HHMMSS-... -> local-time ms, or NaN. */
export function timeFromName(name: string): number {
  const m = /^marveen-backup-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-/.exec(name)
  if (!m) return NaN
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime()
}

function dayKey(t: number): string {
  const d = new Date(t)
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

function weekKey(t: number): string {
  // ISO week: the Thursday of this week decides the year.
  const d = new Date(t)
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7))
  const jan4 = new Date(d.getFullYear(), 0, 4)
  const week = 1 + Math.round(((d.getTime() - jan4.getTime()) / 86400000 - 3 + ((jan4.getDay() + 6) % 7)) / 7)
  return `${d.getFullYear()}-W${week}`
}

function monthKey(t: number): string {
  const d = new Date(t)
  return `${d.getFullYear()}-${d.getMonth() + 1}`
}

export function planPrune(list: BackupEntry[], policy: RetentionPolicy, now = Date.now()): { keep: BackupEntry[]; drop: BackupEntry[] } {
  const sorted = [...list].filter((e) => Number.isFinite(e.time)).sort((a, b) => b.time - a.time)
  const keep = new Set<string>()
  if (sorted.length) keep.add(sorted[0].name)
  sorted.slice(0, policy.last ?? 0).forEach((e) => keep.add(e.name))
  const bucket = (n: number | undefined, key: (t: number) => string) => {
    if (!n) return
    const seen = new Set<string>()
    for (const e of sorted) {
      const k = key(e.time)
      if (seen.has(k)) continue
      seen.add(k)
      keep.add(e.name)
      if (seen.size >= n) break
    }
  }
  bucket(policy.daily, dayKey)
  bucket(policy.weekly, weekKey)
  bucket(policy.monthly, monthKey)
  const newestVerified = sorted.find((e) => e.verified)
  if (newestVerified) keep.add(newestVerified.name)
  for (const e of sorted) {
    if (e.kind === 'pre-restore' && now - e.time < PRE_RESTORE_KEEP_MS) keep.add(e.name)
  }
  // Entries without a parsable time are never ours to judge: keep them.
  for (const e of list) if (!Number.isFinite(e.time)) keep.add(e.name)
  return {
    keep: list.filter((e) => keep.has(e.name)),
    drop: list.filter((e) => !keep.has(e.name)),
  }
}
