/**
 * #929: which synchronous file call holds the dashboard's main thread?
 *
 * Measured 2026-11-16 (90 s profile of the live dashboard, /proc/<pid>/task/<pid>/stat + wchan every 20 ms): the main
 * thread was in uninterruptible disk wait (state D) 15% of the time, and in 437 of 641 such samples the kernel was
 * inside p9_client_rpc, i.e. waiting for the WINDOWS HOST to answer a call on a /mnt/<drive> mount (9p). When Windows
 * is slow (virus scan, a busy disk) each such call takes seconds, and the whole dashboard stands still -- the 14 to
 * 30 second freezes whose stack top was always some trivial function (the stack is taken when the call returns).
 *
 * This watch times every synchronous fs call whose path lives under a watched prefix (default /mnt/) and keeps, per
 * operation and directory, how often and how long the main thread waited, plus the caller of the slowest calls.
 * It never changes what a call does or returns; a call on any other path costs one string check.
 */
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { performance } from 'node:perf_hooks'
import { logger } from '../logger.js'

/** A single call this slow is kept with its caller. */
export const SLOW_FS_MS = 50
const KEEP_SLOW = 40
const KEEP_BUCKETS = 60

export type SlowFsCall = { at: number; op: string; path: string; ms: number; caller: string[] }
export type FsBucket = { op: string; dir: string; calls: number; totalMs: number; maxMs: number; slow: number }

const OPS = [
  'statSync', 'lstatSync', 'existsSync', 'accessSync', 'readdirSync', 'readFileSync', 'writeFileSync', 'appendFileSync',
  'realpathSync', 'readlinkSync', 'openSync', 'mkdirSync', 'renameSync', 'unlinkSync', 'rmSync', 'rmdirSync',
  'copyFileSync', 'utimesSync', 'opendirSync',
] as const

let prefixes: string[] = ['/mnt/']
let installed = false
let clock: () => number = () => performance.now()
const originals = new Map<string, (...a: unknown[]) => unknown>()
const buckets = new Map<string, FsBucket>()
let slowCalls: SlowFsCall[] = []
let sinceMs = 0

/** The directory a path sits in, shortened to its first few segments so the table stays readable. */
export function dirKey(p: string): string {
  const parts = p.split('/').filter(Boolean)
  const dir = parts.slice(0, Math.min(parts.length, 6))
  return '/' + dir.join('/')
}

function watched(p: unknown): p is string {
  if (typeof p !== 'string') return false
  for (const x of prefixes) if (p.startsWith(x)) return true
  return false
}

function callerFrames(): string[] {
  const lines = String(new Error().stack || '').split('\n').slice(1)
  const out: string[] = []
  for (const l of lines) {
    if (l.includes('/web/slow-fs-watch.')) continue
    out.push(l.trim().replace(/^at /, '').slice(0, 160))
    if (out.length >= 5) break
  }
  return out
}

/** Record one finished call; exported for the test. */
export function noteFsCall(op: string, path: string, ms: number, now = Date.now()): void {
  const dir = dirKey(path)
  const key = op + ' ' + dir
  let b = buckets.get(key)
  if (!b) {
    if (buckets.size >= KEEP_BUCKETS) {
      // Keep the table small: drop the bucket that has cost the least.
      let worst: string | null = null
      let least = Infinity
      for (const [k, v] of buckets) if (v.totalMs < least) { least = v.totalMs; worst = k }
      if (worst) buckets.delete(worst)
    }
    b = { op, dir, calls: 0, totalMs: 0, maxMs: 0, slow: 0 }
    buckets.set(key, b)
  }
  b.calls++
  b.totalMs += ms
  if (ms > b.maxMs) b.maxMs = ms
  if (ms >= SLOW_FS_MS) {
    b.slow++
    slowCalls.unshift({ at: now, op, path: path.slice(0, 300), ms: Math.round(ms), caller: callerFrames() })
    if (slowCalls.length > KEEP_SLOW) slowCalls.length = KEEP_SLOW
    if (ms >= 1000) logger.warn({ op, path: path.slice(0, 200), ms: Math.round(ms) }, 'slow synchronous file call on the main thread (#929)')
  }
}

/** Wrap one fs function; a call on an unwatched path goes straight through. */
export function wrapFsCall<T extends (...a: any[]) => any>(op: string, fn: T): T {
  const wrapped = function (this: unknown, ...args: unknown[]): unknown {
    const p = args[0]
    if (!watched(p)) return fn.apply(this, args)
    const t0 = clock()
    try {
      return fn.apply(this, args)
    } finally {
      try { noteFsCall(op, p, clock() - t0) } catch { /* evidence only */ }
    }
  }
  return wrapped as unknown as T
}

export function startSlowFsWatch(opts: { prefixes?: string[] } = {}): void {
  if (installed || process.env.MARVEEN_SLOW_FS_WATCH === '0') return
  if (opts.prefixes) prefixes = opts.prefixes
  installed = true
  sinceMs = Date.now()
  const target = fs as unknown as Record<string, unknown>
  for (const op of OPS) {
    const fn = target[op]
    if (typeof fn !== 'function') continue
    originals.set(op, fn as (...a: unknown[]) => unknown)
    const wrapped = wrapFsCall(op, fn as (...a: any[]) => any)
    // realpathSync carries a .native twin that callers use directly.
    const nat = (fn as unknown as { native?: unknown }).native
    if (typeof nat === 'function') (wrapped as unknown as { native: unknown }).native = wrapFsCall(op + '.native', nat as (...a: any[]) => any)
    target[op] = wrapped
  }
  // Modules that import { statSync } from 'node:fs' see the new functions only after this call.
  try { syncBuiltinESMExports() } catch { /* the plain object is patched either way */ }
}

export function slowFsReport(): { sinceMs: number; prefixes: string[]; threshold: number; worst: FsBucket[]; slow: SlowFsCall[] } {
  const worst = [...buckets.values()].sort((a, b) => b.totalMs - a.totalMs).slice(0, 25)
    .map((b) => ({ ...b, totalMs: Math.round(b.totalMs), maxMs: Math.round(b.maxMs) }))
  return { sinceMs, prefixes: prefixes.slice(), threshold: SLOW_FS_MS, worst, slow: slowCalls.slice() }
}

export function _resetSlowFsWatch(): void {
  const target = fs as unknown as Record<string, unknown>
  for (const [op, fn] of originals) target[op] = fn
  originals.clear()
  try { syncBuiltinESMExports() } catch { /* nothing */ }
  installed = false
  prefixes = ['/mnt/']
  buckets.clear()
  slowCalls = []
  sinceMs = 0
  clock = () => performance.now()
}

export function _setSlowFsClock(c: () => number): void { clock = c }
