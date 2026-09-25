/**
 * The Intezo listing, computed OFF the dashboard's main thread (#387).
 *
 * The tree usually lives on a Windows drive reached from WSL (drvfs), where a
 * single readdir can block for seconds while something else reads the disk.
 * Done with the sync fs calls on the main thread, that froze EVERY dashboard
 * request, not just the Intezo: 25 back-to-back list calls measured 0.05 s
 * median but up to 20 s max. Here the same code runs in a worker, so a slow
 * disk only delays the listing that needs it.
 *
 * Messages in:  { id, op: 'list', rel, deep, lang, fresh, content }
 *               { op: 'clear' }   -- a write happened, drop every cache
 *               { op: 'prewarm', lang }
 * Messages out: { id, ok: true, listing } | { id, ok: false, error }
 */
import { parentPort } from 'node:worker_threads'
import { listLife, listLifeCached, clearContentCache, prewarmLifeListings } from './life-explorer.js'

interface ListMsg { id?: number; op: 'list' | 'clear' | 'prewarm'; rel?: string; deep?: boolean; lang?: string; fresh?: boolean; content?: boolean }

parentPort?.on('message', (m: ListMsg) => {
  if (m.op === 'clear') { clearContentCache(); return }
  if (m.op === 'prewarm') { try { prewarmLifeListings(m.lang) } catch { /* the next open lists it */ } return }
  try {
    const listing = m.content === false
      ? listLife(m.rel || '', { deep: false, content: false, lang: m.lang })
      : listLifeCached(m.rel || '', { deep: m.deep !== false, lang: m.lang, fresh: m.fresh === true })
    parentPort?.postMessage({ id: m.id, ok: true, listing })
  } catch (e) {
    parentPort?.postMessage({ id: m.id, ok: false, error: String((e as Error)?.message || e) })
  }
})
