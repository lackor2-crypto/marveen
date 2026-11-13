// background-gate: background work waits while the machine is busy (kanban #897).
//
// The owner's rule (2026-11-13): "if the dashboard would load my machine, it should not even start, or put it off."
// A periodic MAINTENANCE job (a sweep, a sync, a backup tick, an update check) registers with `gatedInterval` instead
// of `setInterval`. When its turn comes and the machine is busy (machine-pressure.ts), the run is PUT OFF: it is
// looked at again every 20 s and runs as soon as the machine has calmed down.
//
// WHAT IT MUST NOT DO
//  * Lose work. A job is never dropped: after MAX_DEFER_MS of waiting it runs anyway, so a machine that is busy all
//    day still gets its backup and its sweeps (late, and logged as such).
//  * Touch anything that answers the owner. Message delivery, wake-ups, scheduled tasks and the watchers that keep
//    the agents alive stay on plain `setInterval`: putting THOSE off would look like a dead assistant.
//  * Pile up. While a run is waiting, the next ticks of the same job do not queue a second one.
//
// With nothing measured (the pressure watch is not running: tests, a platform without figures) the gate is open and
// this is exactly `setInterval`.

import { logger } from './logger.js'
import { machineBusy } from './machine-pressure.js'

export const RECHECK_MS = 20_000
export const MAX_DEFER_MS = 15 * 60_000

export interface GateStat { name: string; runs: number; deferrals: number; forced: number; waitingSince: number | null; lastReasons: string[] }
const stats = new Map<string, GateStat>()

/** What the gate did since start, for GET /api/perf/stalls. */
export function gateStats(): GateStat[] {
  return [...stats.values()].map((s) => ({ ...s, lastReasons: s.lastReasons.slice() }))
}

export function _resetGateStats(): void { stats.clear() }

export interface Seams {
  busy?: () => { busy: boolean; reasons: string[] }
  now?: () => number
  setTimeoutFn?: (fn: () => void, ms: number) => { unref?: () => unknown }
}

/**
 * One gated tick. Exported for the test: `run` is called now when the machine is calm, otherwise once it calms down
 * or after MAX_DEFER_MS. Returns 'ran' | 'deferred' | 'already-waiting'.
 */
export function gatedRun(name: string, run: () => void, alive: () => boolean, seams: Seams = {}): 'ran' | 'deferred' | 'already-waiting' {
  const busy = seams.busy ?? machineBusy
  const now = seams.now ?? Date.now
  const later = seams.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms))
  let st = stats.get(name)
  if (!st) { st = { name, runs: 0, deferrals: 0, forced: 0, waitingSince: null, lastReasons: [] }; stats.set(name, st) }
  const s = st
  if (s.waitingSince != null) return 'already-waiting'
  const go = (): void => { s.runs++; run() }
  const first = busy()
  if (!first.busy) { go(); return 'ran' }
  s.waitingSince = now()
  s.deferrals++
  s.lastReasons = first.reasons
  logger.info({ job: name, reasons: first.reasons }, 'background gate: the machine is busy, this job waits (#897)')
  const again = (): void => {
    if (!alive()) { s.waitingSince = null; return }
    const b = busy()
    const waited = now() - (s.waitingSince ?? now())
    if (b.busy && waited < MAX_DEFER_MS) { later(again, RECHECK_MS).unref?.(); return }
    if (b.busy) {
      s.forced++
      logger.warn({ job: name, waitedMs: waited, reasons: b.reasons }, 'background gate: still busy after the longest wait, the job runs now so it is not lost (#897)')
    }
    s.waitingSince = null
    go()
  }
  later(again, RECHECK_MS).unref?.()
  return 'deferred'
}

/** `setInterval` for maintenance work: the same handle, the same period, but a busy machine puts the run off. */
export function gatedInterval(name: string, fn: () => void, ms: number, seams: Seams = {}): NodeJS.Timeout {
  const timer: NodeJS.Timeout = setInterval(() => {
    // A cleared interval must not get a late run from a waiting retry.
    gatedRun(name, fn, () => (timer as unknown as { _destroyed?: boolean })._destroyed !== true, seams)
  }, ms)
  return timer
}
