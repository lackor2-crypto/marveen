/**
 * #929: one shared answer for the Workbench tree's disk listing.
 *
 * Measured 2026-11-16: the tree asks the server for its folder listing every 10 s per open page, and one answer is
 * 290 to 1100 synchronous file calls on the Windows drive (9p, 2 to 14 ms each, 6.4 s once when Windows was slow):
 * 1.4 to 8 s of main-thread work per poll. Several open pages (phone, second tab) multiply it, and when Windows
 * stalls the polls queue up behind each other. 337 000 such calls = 19 minutes (11%) of the dashboard's main
 * thread in 3 hours.
 *
 * The listing is now computed ONCE and handed to everyone who asks within WORK_FOLDERS_FRESH_MS, while
 * concurrent askers share the one computation that is already running. It is forgotten at once when:
 *   - any request that can change something (POST/PUT/PATCH/DELETE) starts or ends,
 *   - the program itself writes under the depot (synchronous fs write calls, see startDepotWriteEpoch),
 *   - an assistant turn is running (its commands move files; the owner wants to see that at once, 2026-11-07).
 * What happens on the disk outside the program (Windows Explorer) shows within WORK_FOLDERS_FRESH_MS: the owner
 * asked for "about 20 seconds" for that (2026-10-13).
 */
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'

/** How long an unchanged answer is reused. Disk changes made outside the program show up after at most this. */
export const WORK_FOLDERS_FRESH_MS = 20_000

type Entry = { at: number; epoch: number; value: unknown; hasValue: boolean; inflight?: { epoch: number; promise: Promise<unknown> } }

const entries = new Map<string, Entry>()
let epoch = 0
let hits = 0
let misses = 0
let joined = 0
let bypassed = 0
const bumpCauses = new Map<string, number>()

/** Something may have changed on the disk or in the registry: every remembered answer is now old. */
export function bumpDepotEpoch(cause = 'other'): void { epoch++; bumpCauses.set(cause, (bumpCauses.get(cause) ?? 0) + 1) }

/**
 * Requests that only poll or talk to other parts (the code bridge, the message queue, kanban, performance) never move
 * a file in the depot, and they arrive every few seconds: counting them as changes kept the listing from ever being
 * reused on the live dashboard (measured 2026-11-16: 0 hits, epoch +26..40 per 30 s). A file the program really moves
 * is still seen by the synchronous write hook and by the other (file-moving) requests.
 */
export function requestMayChangeDepot(method: string, path: string): boolean {
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return false
  return !/^\/api\/(code|messages|kanban|perf|tool-log|agents\/[^/]+\/(heartbeat|status|drain-inbox)|rate-limit|memories|schedule|approvals)(\/|$)/.test(path)
}

export function currentDepotEpoch(): number { return epoch }

/**
 * `compute` is the real (slow) listing. `bypass`: the caller wants a fresh one (an assistant turn is running); it
 * still joins a computation that started after the last change.
 */
export async function sharedListing<T>(
  key: string,
  compute: () => Promise<T>,
  opts: { bypass?: boolean; now?: () => number; ttlMs?: number } = {},
): Promise<T> {
  const now = (opts.now ?? Date.now)()
  const ttl = opts.ttlMs ?? WORK_FOLDERS_FRESH_MS
  let e = entries.get(key)
  if (e && e.hasValue && e.epoch === epoch && now - e.at < ttl) {
    if (!opts.bypass) { hits++; return e.value as T }
    bypassed++
  }
  if (e && e.inflight && e.inflight.epoch === epoch) { joined++; return e.inflight.promise as Promise<T> }
  misses++
  const startedEpoch = epoch
  if (!e) { e = { at: 0, epoch: -1, value: undefined, hasValue: false }; entries.set(key, e) }
  const entry = e
  const promise: Promise<T> = (async () => {
    try {
      const value = await compute()
      // A change that landed while the listing was being read may or may not be in it: do not remember it.
      if (startedEpoch === epoch) { entry.value = value; entry.hasValue = true; entry.at = (opts.now ?? Date.now)(); entry.epoch = startedEpoch }
      return value
    } finally {
      // Runs after the first await, so `promise` is assigned by then.
      queueMicrotask(() => { if (entry.inflight && entry.inflight.promise === promise) entry.inflight = undefined })
    }
  })()
  entry.inflight = { epoch: startedEpoch, promise }
  return promise
}

export function listingCacheStats(): { hits: number; misses: number; joined: number; bypassed: number; entries: number; epoch: number; bump_causes: Record<string, number> } {
  return { hits, misses, joined, bypassed, entries: entries.size, epoch, bump_causes: Object.fromEntries(bumpCauses) }
}

export function _resetListingCache(): void { entries.clear(); hits = misses = joined = bypassed = 0; epoch = 0; bumpCauses.clear() }

const WRITE_OPS = [
  'writeFileSync', 'appendFileSync', 'mkdirSync', 'renameSync', 'unlinkSync', 'rmSync', 'rmdirSync', 'copyFileSync',
  'utimesSync', 'symlinkSync', 'linkSync', 'truncateSync',
] as const

const originals = new Map<string, (...a: unknown[]) => unknown>()

/**
 * Every synchronous fs write whose path (first argument, and the destination of rename/copy/link) lies under the
 * depot root bumps the epoch, so a change the program makes itself is never hidden by a remembered listing.
 * It changes nothing about the call. Idempotent.
 */
export function startDepotWriteEpoch(getRoot: () => string | null): void {
  if (originals.size) return
  const target = fs as unknown as Record<string, unknown>
  for (const op of WRITE_OPS) {
    const fn = target[op]
    if (typeof fn !== 'function') continue
    originals.set(op, fn as (...a: unknown[]) => unknown)
    target[op] = function (this: unknown, ...args: unknown[]): unknown {
      let inDepot = false
      try {
        const root = getRoot()
        if (root) {
          const a = args[0], b = args[1]
          inDepot = (typeof a === 'string' && a.startsWith(root)) || (typeof b === 'string' && b.startsWith(root))
        }
      } catch { /* the check must never change the call */ }
      if (inDepot) bumpDepotEpoch('fs-write')
      try {
        return (fn as (...x: unknown[]) => unknown).apply(this, args)
      } finally {
        // Also AFTER the call: a listing that started between the bump and the write must not be remembered.
        if (inDepot) epoch++
      }
    }
  }
  try { syncBuiltinESMExports() } catch { /* the plain object is patched either way */ }
}

export function _stopDepotWriteEpoch(): void {
  const target = fs as unknown as Record<string, unknown>
  for (const [op, fn] of originals) target[op] = fn
  originals.clear()
  try { syncBuiltinESMExports() } catch { /* nothing */ }
}
