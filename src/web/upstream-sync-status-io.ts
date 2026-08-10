// I/O for the upstream-sync snapshot written by the monthly
// marveen-upstream-divergence-check scheduled task (and by manual runs).
// Pure JSON read, no git calls here -- this module only reads the file.

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
}

export function readUpstreamSyncStatus(): UpstreamSyncStatus | null {
  if (!existsSync(STATUS_PATH)) return null
  try {
    const raw = JSON.parse(readFileSync(STATUS_PATH, 'utf-8'))
    if (!raw || typeof raw !== 'object') return null
    const o = raw as Record<string, unknown>
    const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
    const files = Array.isArray(o.conflictingFiles)
      ? o.conflictingFiles.filter((f): f is string => typeof f === 'string')
      : []
    return {
      checkedAt: typeof o.checkedAt === 'string' ? o.checkedAt : null,
      aheadCount: num(o.aheadCount),
      behindCount: num(o.behindCount),
      conflictingFiles: files,
      conflictCount: num(o.conflictCount) ?? files.length,
      cleanFileCount: num(o.cleanFileCount),
    }
  } catch {
    return null
  }
}
