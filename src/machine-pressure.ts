// machine-pressure: is the MACHINE busy right now? (kanban #897)
//
// WHY IT EXISTS
// The owner (2026-11-13): "find a general solution so the dashboard does not load my machine. If it would, it should
// not even start, or put it off." For a month every freeze was fixed at the one line the sampler pointed at, and the
// next one came from somewhere else. Many of the measured freezes sat on trivial code (a Map lookup, a string compare)
// in clusters: there the thread was not held by our code, the machine had no time to give it. So the dashboard has to
// KNOW when the machine is short of CPU, disk or memory, and keep its own background work out of those moments.
//
// THE MEASURE is the kernel's own pressure-stall information (/proc/pressure/{cpu,io,memory}, "some avg10" = the
// share of the last 10 s in which at least one task was waiting for that resource). Unlike the load average it tells
// waiting from working, and it is one tiny read. Where the kernel has no PSI (macOS, an old kernel) the 1-minute load
// per core stands in for the CPU; io and memory are then "not measured" (null), never a made-up zero.
//
// It is read by a timer into a snapshot; askers get the snapshot, so nobody reads a file on a hot path.

import { readFile } from 'node:fs/promises'
import { cpus, loadavg } from 'node:os'

export interface PressureSnapshot {
  /** When it was measured (ms). */
  at: number
  /** "some avg10" in percent; null = this machine does not tell. */
  cpu: number | null
  io: number | null
  memory: number | null
  /** 1-minute load average and the number of cores. */
  load1: number
  cores: number
}

export interface PressureLimits { cpu: number; io: number; memory: number; loadPerCore: number }

function envNum(name: string, dflt: number): number {
  const v = Number(process.env[name])
  return Number.isFinite(v) && v > 0 ? v : dflt
}

/** Above these the machine counts as busy. Each can be moved from .env (see .env.example). */
export function pressureLimits(): PressureLimits {
  return {
    cpu: envNum('MARVEEN_BUSY_CPU_PCT', 25),
    io: envNum('MARVEEN_BUSY_IO_PCT', 15),
    memory: envNum('MARVEEN_BUSY_MEMORY_PCT', 5),
    loadPerCore: envNum('MARVEEN_BUSY_LOAD_PER_CORE', 1.5),
  }
}

/** The "some avg10" of one /proc/pressure file, or null when the text is not one. */
export function parsePressure(text: string): number | null {
  const m = /^some\s+avg10=([0-9.]+)/m.exec(text)
  if (!m) return null
  const n = Number(m[1])
  return Number.isFinite(n) ? n : null
}

async function readOne(dir: string, what: string): Promise<number | null> {
  try { return parsePressure(await readFile(`${dir}/${what}`, 'utf8')) } catch { return null }
}

export async function measurePressure(dir = '/proc/pressure', now = Date.now()): Promise<PressureSnapshot> {
  const [cpu, io, memory] = await Promise.all([readOne(dir, 'cpu'), readOne(dir, 'io'), readOne(dir, 'memory')])
  return { at: now, cpu, io, memory, load1: loadavg()[0] ?? 0, cores: Math.max(1, cpus().length) }
}

/** Why the machine counts as busy, in the order checked; empty = it does not. Pure. */
export function busyReasons(s: PressureSnapshot | null, limits: PressureLimits = pressureLimits()): string[] {
  if (!s) return []
  const out: string[] = []
  if (s.cpu != null && s.cpu >= limits.cpu) out.push('cpu')
  if (s.io != null && s.io >= limits.io) out.push('io')
  if (s.memory != null && s.memory >= limits.memory) out.push('memory')
  // The load average only speaks where the kernel gave no CPU pressure figure.
  if (s.cpu == null && s.load1 / s.cores >= limits.loadPerCore) out.push('load')
  return out
}

const SAMPLE_MS = 5_000
/** A snapshot older than this says nothing about "now". */
const STALE_MS = 30_000
let latest: PressureSnapshot | null = null
let timer: NodeJS.Timeout | null = null
let lastStallAt = 0

/** The newest measurement, or null when none was taken (the watch is not running) or it is too old. */
export function currentPressure(now = Date.now()): PressureSnapshot | null {
  return latest && now - latest.at <= STALE_MS ? latest : null
}

/** The event loop watch reports a long stall here: for a short while after one the machine counts as busy. */
export function noteStallForPressure(lagMs: number, now = Date.now()): void {
  if (lagMs >= 1000) lastStallAt = now
}

/**
 * Should background work stay out of this moment? False when nothing was measured: "could not look" never blocks
 * work, it only means the gate is open.
 */
export function machineBusy(now = Date.now()): { busy: boolean; reasons: string[] } {
  const reasons = busyReasons(currentPressure(now))
  if (lastStallAt !== 0 && now - lastStallAt < 20_000) reasons.push('stall')
  return { busy: reasons.length > 0, reasons }
}

export function startPressureWatch(): void {
  if (timer) return
  const tick = (): void => { void measurePressure().then((s) => { latest = s }).catch(() => { /* next round */ }) }
  tick()
  timer = setInterval(tick, SAMPLE_MS)
  timer.unref()
}

/** Test seam. */
export function _setPressureForTest(s: PressureSnapshot | null): void {
  latest = s
  lastStallAt = 0
}

export function _resetPressureWatch(): void {
  if (timer) clearInterval(timer)
  timer = null
  latest = null
  lastStallAt = 0
}

/** One line a person can read, for the freeze warning and the log. */
export function describePressure(s: PressureSnapshot | null, lang: 'hu' | 'en'): string {
  if (!s) return lang === 'hu' ? 'a gép terhelését ekkor nem mértük' : 'the machine load was not measured then'
  const pct = (v: number | null): string => (v == null ? (lang === 'hu' ? 'nincs adat' : 'no data') : `${Math.round(v)}%`)
  return lang === 'hu'
    ? `processzorra várakozás ${pct(s.cpu)}, lemezre ${pct(s.io)}, memóriára ${pct(s.memory)}, terhelés ${s.load1.toFixed(1)} / ${s.cores} mag`
    : `waiting for CPU ${pct(s.cpu)}, for disk ${pct(s.io)}, for memory ${pct(s.memory)}, load ${s.load1.toFixed(1)} / ${s.cores} cores`
}
