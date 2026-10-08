/**
 * #490: which request blocks the dashboard? The Node.js guidance ("Don't block the event loop") is to measure
 * before rewriting: a timer that should fire every TICK_MS notices when it fires late, and the requests that were
 * in flight at that moment are the suspects (a synchronous walk over the slow 9p depot mount, a big JSON, ...).
 * Each stall over STALL_MS is logged once with the suspects; the worst ones are kept for GET /api/perf/stalls.
 * Measuring costs one timer and a Set insert per request; it never changes what a request does.
 */
import type http from 'node:http'
import { logger } from '../logger.js'

export const TICK_MS = 100
export const STALL_MS = 300
const KEEP = 30

export type Stall = { at: number; lagMs: number; inflight: string[] }

const inflight = new Map<number, string>()
let seq = 0
const stalls: Stall[] = []
let timer: NodeJS.Timeout | null = null

/** Remember the request while it runs (method + path, never the query: it can carry a token). */
export function trackRequest(req: http.IncomingMessage, res: http.ServerResponse, path: string): void {
  const id = ++seq
  inflight.set(id, (req.method || 'GET') + ' ' + path)
  const done = (): void => { inflight.delete(id) }
  res.once('finish', done)
  res.once('close', done)
}

/** Record one late tick; exported for the test (the timer calls it with the measured lag). */
export function noteLag(lagMs: number, now = Date.now()): Stall | null {
  if (lagMs < STALL_MS) return null
  const s: Stall = { at: now, lagMs: Math.round(lagMs), inflight: [...new Set(inflight.values())].slice(0, 10) }
  stalls.push(s)
  stalls.sort((a, b) => b.lagMs - a.lagMs)
  if (stalls.length > KEEP) stalls.length = KEEP
  logger.warn({ lagMs: s.lagMs, inflight: s.inflight }, 'event loop stalled (#490): these requests were running')
  return s
}

export function recentStalls(): Stall[] {
  return stalls.slice()
}

export function startEventLoopWatch(): void {
  if (timer) return
  let expected = Date.now() + TICK_MS
  timer = setInterval(() => {
    const now = Date.now()
    noteLag(now - expected, now)
    expected = now + TICK_MS
  }, TICK_MS)
  timer.unref()
}

export function _resetEventLoopWatch(): void {
  if (timer) clearInterval(timer)
  timer = null
  inflight.clear()
  stalls.length = 0
}
