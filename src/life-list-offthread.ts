/**
 * Main-thread side of the off-thread Intezo listing (#387).
 *
 * Why: the listing reads a drvfs drive with sync fs calls. On the main thread a
 * slow readdir froze the whole dashboard (measured: 25 back-to-back list calls,
 * median 0.05 s, max 20 s -- and the SAME folder 0.05 s, then 1.86 s on the
 * next call). Two workers (see life-list-worker.ts):
 *   - `light`: names and types only (content=0), so the first draw is never
 *     queued behind a deep measurement;
 *   - `full`: the deep listing with its caches, background measures and
 *     revalidation -- all of which now block only this worker.
 *
 * Stale-while-revalidate on top: when we already answered this exact request,
 * we ask the worker again but wait at most `RACE_MS`. A responsive worker gives
 * the fresh answer; a stalled disk gets the previous answer immediately, and the
 * worker's reply refreshes the copy for the next call (the UI's silent refetch).
 * Any write through Marveen (`clearOffThreadListings`) drops the copies, so a
 * user never sees the state from before their own action.
 *
 * No worker file (running from the TS sources, e.g. tests) or a worker that
 * died: we fall back to the in-thread code, i.e. the old behaviour -- slower
 * under load, never wrong.
 */
import { Worker } from 'node:worker_threads'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { listLife, listLifeCached, clearContentCache, prewarmLifeListings, type LifeListing } from './life-explorer.js'
import { logger } from './logger.js'

type Kind = 'light' | 'full'
type Listing = LifeListing & { cached?: boolean }
interface Pending { resolve: (l: Listing) => void; reject: (e: Error) => void }

/** How long a request with a previous answer waits for the fresh one. */
const RACE_MS = 150
/** A worker silent for this long on one request is treated as failed. */
const WORKER_TIMEOUT_MS = 25_000
const COPY_MAX = 400
const RESTART_MAX = 5

const workers: Partial<Record<Kind, Worker | null>> = {}
const restarts: Record<Kind, number> = { light: 0, full: 0 }
const pending = new Map<number, Pending>()
const inflight = new Map<string, Promise<Listing>>()
const copies = new Map<string, Listing>()
let nextId = 1
let generation = 0

function workerFile(): string | null {
  try {
    const p = fileURLToPath(new URL('./life-list-worker.js', import.meta.url))
    return existsSync(p) ? p : null
  } catch { return null }
}

function getWorker(kind: Kind): Worker | null {
  if (workers[kind]) return workers[kind] as Worker
  if (workers[kind] === null && restarts[kind] >= RESTART_MAX) return null
  const file = workerFile()
  if (!file) { workers[kind] = null; restarts[kind] = RESTART_MAX; return null }
  let w: Worker
  try { w = new Worker(file) } catch (e) {
    logger.warn(`[life] listazo szal nem indult (${kind}): ${String(e)}`)
    workers[kind] = null; restarts[kind]++
    return null
  }
  w.unref()
  w.on('message', (m: { id: number; ok: boolean; listing?: Listing; error?: string }) => {
    const p = pending.get(m.id)
    if (!p) return
    pending.delete(m.id)
    if (m.ok && m.listing) p.resolve(m.listing)
    else p.reject(new Error(m.error || 'listing failed'))
  })
  const dead = (why: string) => {
    if (workers[kind] !== w) return
    logger.warn(`[life] listazo szal leallt (${kind}): ${why}`)
    workers[kind] = null; restarts[kind]++
    // Its open requests will never be answered: fail them now, not after the timeout.
    for (const [id, p] of pending) { if ((p as Pending & { kind?: Kind }).kind === kind) { pending.delete(id); p.reject(new Error(why)) } }
  }
  w.on('error', (e) => dead(String(e)))
  w.on('exit', (code) => dead(`exit ${code}`))
  workers[kind] = w
  return w
}

function ask(kind: Kind, msg: { rel: string; deep: boolean; lang?: string; fresh: boolean; content: boolean }): Promise<Listing> {
  const w = getWorker(kind)
  if (!w) {
    // In-thread fallback -- the pre-worker behaviour.
    try {
      return Promise.resolve(msg.content
        ? listLifeCached(msg.rel, { deep: msg.deep, lang: msg.lang, fresh: msg.fresh })
        : listLife(msg.rel, { deep: false, content: false, lang: msg.lang }))
    } catch (e) { return Promise.reject(e) }
  }
  const id = nextId++
  return new Promise<Listing>((resolve, reject) => {
    const tm = setTimeout(() => {
      if (pending.delete(id)) reject(new Error('listing timed out'))
    }, WORKER_TIMEOUT_MS)
    if (typeof tm.unref === 'function') tm.unref()
    const entry: Pending & { kind: Kind } = {
      kind,
      resolve: (l) => { clearTimeout(tm); resolve(l) },
      reject: (e) => { clearTimeout(tm); reject(e) },
    }
    pending.set(id, entry)
    w.postMessage({ id, op: 'list', ...msg })
  })
}

function remember(key: string, listing: Listing): void {
  if (listing.message) return
  if (copies.size >= COPY_MAX && !copies.has(key)) {
    const oldest = copies.keys().next().value
    if (oldest !== undefined) copies.delete(oldest)
  }
  copies.delete(key)
  copies.set(key, listing)
}

/**
 * The Intezo listing without blocking the main thread. `content: false` is the
 * light first-draw list (names and types only).
 */
export function listLifeOffThread(rel: string, opts: { deep?: boolean; lang?: string; fresh?: boolean; content?: boolean } = {}): Promise<Listing> {
  const msg = {
    rel: String(rel || ''),
    deep: opts.content === false ? false : opts.deep !== false,
    lang: opts.lang,
    fresh: opts.fresh === true,
    content: opts.content !== false,
  }
  const kind: Kind = msg.content ? 'full' : 'light'
  const key = `${kind}\u0000${msg.rel}\u0000${msg.deep ? 1 : 0}\u0000${msg.lang || ''}`
  const gen = generation
  // One question per key at a time: a stalled disk must not pile up copies of
  // the same job in the worker's queue.
  let p = msg.fresh ? undefined : inflight.get(key)
  if (!p) {
    p = ask(kind, msg).then((l) => {
      // A write happened while this was computed: the answer may predate it.
      if (gen === generation) remember(key, l)
      return l
    })
    const mine = p
    inflight.set(key, mine)
    mine.finally(() => { if (inflight.get(key) === mine) inflight.delete(key) }).catch(() => {})
  }
  const prev = msg.fresh ? undefined : copies.get(key)
  if (!prev) return p
  const fresh = p
  return new Promise<Listing>((resolve) => {
    let done = false
    const tm = setTimeout(() => { if (!done) { done = true; resolve({ ...prev, cached: true }) } }, RACE_MS)
    fresh.then(
      (l) => { if (!done) { done = true; clearTimeout(tm); resolve(l) } },
      () => { if (!done) { done = true; clearTimeout(tm); resolve({ ...prev, cached: true }) } },
    )
  })
}

/** A write went through Marveen: every copy and every worker cache is stale. */
export function clearOffThreadListings(): void {
  generation++
  copies.clear()
  inflight.clear()
  clearContentCache()
  for (const kind of ['light', 'full'] as Kind[]) {
    const w = workers[kind]
    if (w) w.postMessage({ op: 'clear' })
  }
}

/** Startup prewarm, in the full worker when there is one. */
export function prewarmOffThread(lang?: string): void {
  const w = getWorker('full')
  if (w) { w.postMessage({ op: 'prewarm', lang }); return }
  prewarmLifeListings(lang)
}

/** Tests only. */
export function _offThreadState(): { copies: number; workerFile: string | null } {
  return { copies: copies.size, workerFile: workerFile() }
}
