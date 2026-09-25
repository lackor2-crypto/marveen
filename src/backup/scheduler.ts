/**
 * The in-dashboard daily backup (#396 Phase 2): once a day at the configured
 * local time (default 03:30, in the install's timezone). The 6-hourly systemd
 * unit calls the same pipeline through the CLI, so either trigger works while
 * the other is down; the "a backup succeeded < 60 min ago" rule and the lock
 * keep them from doubling up.
 *
 * Status-driven, not a fixed timeout: a tick every few minutes asks "is today's
 * run due and not yet attempted?", so a dashboard that was down at 03:30 makes
 * the backup as soon as it is back up.
 */
import { readConfig } from './destinations.js'
import { readState, updateState } from './state.js'
import { sweepStaleStaging } from './create.js'

const TICK_MS = 5 * 60 * 1000

/** Wall-clock date and minutes-of-day of `now` in `tz`. */
export function wallClock(now: Date, tz: string): { day: string; minutes: number } {
  let parts: Intl.DateTimeFormatPart[]
  try {
    parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now)
  } catch {
    parts = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now)
  }
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? '00'
  return { day: `${g('year')}-${g('month')}-${g('day')}`, minutes: Number(g('hour')) * 60 + Number(g('minute')) }
}

export function isDue(now: Date, tz: string, time: string, lastScheduledDay: string | undefined): { due: boolean; day: string } {
  const w = wallClock(now, tz)
  const [h, m] = time.split(':').map(Number)
  return { due: w.minutes >= h * 60 + m && lastScheduledDay !== w.day, day: w.day }
}

export interface SchedulerDeps {
  storeDir: string
  tz: string
  run: () => Promise<unknown>
  log?: (msg: string, extra?: Record<string, unknown>) => void
}

/** One tick; exported for tests. Returns true when it started a run. */
export async function schedulerTick(d: SchedulerDeps, now = new Date()): Promise<boolean> {
  const cfg = readConfig(d.storeDir)
  if (!cfg.schedule.enabled) return false
  const st = readState(d.storeDir)
  const { due, day } = isDue(now, d.tz, cfg.schedule.time, st.lastScheduledDay)
  if (!due) return false
  // Mark the day BEFORE running: a run that crashes the process must not
  // restart itself in a loop every five minutes.
  updateState(d.storeDir, (s) => { s.lastScheduledDay = day })
  try { await d.run() } catch (err) { d.log?.('scheduled backup threw', { err: String(err) }) }
  return true
}

export function startBackupScheduler(d: SchedulerDeps): () => void {
  try { sweepStaleStaging(d.storeDir) } catch { /* nothing to sweep */ }
  let busy = false
  const tick = () => {
    if (busy) return
    busy = true
    schedulerTick(d).catch(() => { /* logged inside */ }).finally(() => { busy = false })
  }
  const first = setTimeout(tick, 60_000)
  const iv = setInterval(tick, TICK_MS)
  first.unref?.()
  iv.unref?.()
  return () => { clearTimeout(first); clearInterval(iv) }
}
