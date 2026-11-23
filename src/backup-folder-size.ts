// #951: the size of the folder behind a backup rule, for the backup map's "folder size" column.
//
// Measuring a big photo folder takes a while, so it NEVER runs on the request: the first ask starts
// a background walk (async fs only, one folder at a time, a yield every few hundred entries so the
// dashboard keeps answering), the page polls, and a finished number is kept for CACHE_MS. A folder
// that cannot be read is reported as such, never as "0 bytes". Symlinks are not followed.
import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'

export interface FolderSize {
  state: 'measuring' | 'done' | 'failed'
  bytes: number | null
  files: number | null
  at: string | null
}

const CACHE_MS = 10 * 60 * 1000
const cache = new Map<string, FolderSize & { atMs: number }>()
const queue: Array<{ key: string; abs: string }> = []
let running = false

/** Test hook. */
export function resetFolderSizes(): void { cache.clear(); queue.length = 0 }

export async function measureFolder(abs: string): Promise<{ bytes: number; files: number }> {
  let bytes = 0
  let files = 0
  let seen = 0
  const stack = [abs]
  while (stack.length) {
    const dir = stack.pop()!
    const entries = await readdir(dir, { withFileTypes: true })
    for (const e of entries) {
      if (++seen % 300 === 0) await new Promise<void>((r) => setImmediate(r))
      const full = join(dir, e.name)
      if (e.isSymbolicLink()) continue
      if (e.isDirectory()) { stack.push(full); continue }
      if (!e.isFile()) continue
      try { bytes += (await lstat(full)).size; files++ } catch { /* gone while walking */ }
    }
  }
  return { bytes, files }
}

async function pump(): Promise<void> {
  if (running) return
  running = true
  try {
    while (queue.length) {
      const job = queue.shift()!
      try {
        const r = await measureFolder(job.abs)
        cache.set(job.key, { state: 'done', bytes: r.bytes, files: r.files, at: new Date().toISOString(), atMs: Date.now() })
      } catch {
        cache.set(job.key, { state: 'failed', bytes: null, files: null, at: new Date().toISOString(), atMs: Date.now() })
      }
    }
  } finally { running = false }
}

/**
 * The current knowledge for `key` (a rule path); starts a background measurement when there is none
 * or it is older than the cache time. `abs` null = the folder is not in the tree: failed, not zero.
 */
export function folderSize(key: string, abs: string | null): FolderSize {
  const hit = cache.get(key)
  if (hit && (hit.state === 'measuring' || Date.now() - hit.atMs < CACHE_MS)) {
    return { state: hit.state, bytes: hit.bytes, files: hit.files, at: hit.at }
  }
  if (!abs) return { state: 'failed', bytes: null, files: null, at: null }
  const old = hit && hit.state === 'done' ? hit : null
  cache.set(key, { state: 'measuring', bytes: old ? old.bytes : null, files: old ? old.files : null, at: old ? old.at : null, atMs: Date.now() })
  queue.push({ key, abs })
  void pump()
  return { state: 'measuring', bytes: old ? old.bytes : null, files: old ? old.files : null, at: old ? old.at : null }
}
