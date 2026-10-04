// #484: folder size for the Explorer, measured OFF the request path.
// `du -sk` through async execFile never blocks the event loop; a portable
// async walk is the fallback where `du` is missing (fresh Windows install).
import { execFile } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'

export interface DirSize { bytes: number; partial: boolean }

const TTL_MS = 10 * 60 * 1000
const DU_TIMEOUT_MS = 120_000
const MAX_PARALLEL = 2
const cache = new Map<string, { at: number; value: DirSize }>()
const inflight = new Map<string, Promise<DirSize>>()
let running = 0
const waiters: Array<() => void> = []

async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= MAX_PARALLEL) await new Promise<void>((r) => waiters.push(r))
  running++
  try { return await fn() } finally { running--; waiters.shift()?.() }
}

function duSize(abs: string): Promise<DirSize | null> {
  return new Promise((resolve) => {
    execFile('du', ['-sk', '--', abs], { timeout: DU_TIMEOUT_MS, maxBuffer: 1 << 20 }, (err, stdout) => {
      const kb = parseInt(String(stdout || '').split(/\s/)[0], 10)
      if (Number.isFinite(kb)) {
        // du exits non-zero on unreadable subfolders but still prints a total.
        resolve({ bytes: kb * 1024, partial: !!err })
      } else resolve(null)
    })
  })
}

async function walkSize(abs: string, deadline: number): Promise<DirSize> {
  let bytes = 0
  let partial = false
  const stack = [abs]
  while (stack.length) {
    if (Date.now() > deadline) { partial = true; break }
    const dir = stack.pop() as string
    let ents
    try { ents = await fsp.readdir(dir, { withFileTypes: true }) } catch { partial = true; continue }
    for (const e of ents) {
      const p = join(dir, e.name)
      if (e.isSymbolicLink()) continue
      if (e.isDirectory()) { stack.push(p); continue }
      try { bytes += (await fsp.lstat(p)).size } catch { partial = true }
    }
  }
  return { bytes, partial }
}

/** Total size of a folder; cached ~10 min, concurrent callers share one run. */
export function lifeDirSize(abs: string, fresh = false): Promise<DirSize> {
  const hit = cache.get(abs)
  if (!fresh && hit && Date.now() - hit.at < TTL_MS) return Promise.resolve(hit.value)
  const run = inflight.get(abs)
  if (run) return run
  const p = slot(async () => {
    const value = (await duSize(abs)) ?? (await walkSize(abs, Date.now() + DU_TIMEOUT_MS))
    cache.set(abs, { at: Date.now(), value })
    return value
  }).finally(() => { inflight.delete(abs) })
  inflight.set(abs, p)
  return p
}
