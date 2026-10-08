// "One copy" principle (#513): a document lives in ONE place, the Life tree.
//
// The Drive/MEGA mirror under `System/Storages/Drive` is a download cache. When
// the owner moves a mirrored file OUT of it into the Life tree (Explorer
// cut/paste), that file is no longer a cache entry, it is the real copy. The
// sync must then neither download it again (the local path is missing) nor ask
// "delete it in the cloud too?" (it looks locally deleted).
//
// The marks live in their own small ledger instead of the sync state: a running
// sync keeps its own in-memory copy of the state and would overwrite a mark
// written from the Explorer side.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { STORE_DIR } from './config.js'
import { DEPOT_DRIVE, DEPOT_MEGA } from './depot.js'

export const MIGRATED_PATH = join(STORE_DIR, 'mirror-migrated.json')

export interface MigratedEntry {
  /** Depot-relative path the item had inside the mirror (file or folder). */
  from: string
  /** Where it went in the Life tree. */
  to: string
  at: number
}

function normalize(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
}

export function isInsideMirror(rel: string): boolean {
  const r = normalize(rel)
  return [DEPOT_DRIVE, DEPOT_MEGA].some((root) => {
    const n = normalize(root)
    return r === n || r.startsWith(n + '/')
  })
}

export function loadMigrated(path = MIGRATED_PATH): MigratedEntry[] {
  try {
    if (!existsSync(path)) return []
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    return Array.isArray(raw) ? raw.filter((e) => e && typeof e.from === 'string') : []
  } catch {
    return []
  }
}

function save(list: MigratedEntry[], path: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(list, null, 2))
  renameSync(tmp, path)
}

/**
 * Called after a successful move. Records the move only when the source was
 * inside the mirror and the destination is outside it.
 */
export function noteMovedOutOfMirror(fromRel: string, toRel: string, path = MIGRATED_PATH): boolean {
  if (!isInsideMirror(fromRel) || isInsideMirror(toRel)) return false
  const from = normalize(fromRel)
  const list = loadMigrated(path).filter((e) => e.from !== from)
  list.push({ from, to: normalize(toRel), at: Date.now() })
  save(list, path)
  return true
}

/** Is this mirror path (file) covered by a recorded move, directly or via its folder? */
export function isMigratedPath(rel: string, list: MigratedEntry[]): boolean {
  const r = normalize(rel)
  return list.some((e) => r === e.from || r.startsWith(e.from + '/'))
}

/** Drop marks the sync no longer needs (the cloud copy is gone / re-synced). */
export function dropMigrated(pred: (e: MigratedEntry) => boolean, path = MIGRATED_PATH): number {
  const list = loadMigrated(path)
  const keep = list.filter((e) => !pred(e))
  if (keep.length !== list.length) save(keep, path)
  return list.length - keep.length
}
