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
  /** Start a verify of the newest local backup (a child process). */
  verify?: (name: string) => void
  /** Start the monthly off-site verify (a child process). */
  offsite?: () => void
  log?: (msg: string, extra?: Record<string, unknown>) => void
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000
const MONTH_MS = 30 * 24 * 60 * 60 * 1000

/** Weekly verify of the newest backup, monthly off-site verify (Phase 6). */
export function verifyTick(d: SchedulerDeps, now = Date.now()): { verify: boolean; offsite: boolean } {
  const st = readState(d.storeDir)
  const out = { verify: false, offsite: false }
  if (d.verify && st.lastSuccessName) {
    const last = Math.max(st.lastVerify?.at ?? 0, st.lastVerifyStartedAt ?? 0)
    if (now - last > WEEK_MS) {
      updateState(d.storeDir, (s) => { s.lastVerifyStartedAt = now })
      d.verify(st.lastSuccessName)
      out.verify = true
    }
  }
  if (d.offsite && st.replicas?.cloud?.ok) {
    const last = Math.max(st.lastOffsiteVerify?.at ?? 0, st.lastOffsiteStartedAt ?? 0)
    if (now - last > MONTH_MS) {
      updateState(d.storeDir, (s) => { s.lastOffsiteStartedAt = now })
      d.offsite()
      out.offsite = true
    }
  }
  return out
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
    schedulerTick(d)
      .then(() => { try { verifyTick(d) } catch (err) { d.log?.('verify tick failed', { err: String(err) }) } })
      .catch(() => { /* logged inside */ })
      .finally(() => { busy = false })
  }
  const first = setTimeout(tick, 60_000)
  const iv = setInterval(tick, TICK_MS)
  first.unref?.()
  iv.unref?.()
  return () => { clearTimeout(first); clearInterval(iv) }
}
