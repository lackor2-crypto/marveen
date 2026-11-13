// #897: background work waits while the machine is busy; it is put off, never lost, never piled up.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { gatedRun, gatedInterval, gateStats, _resetGateStats, RECHECK_MS, MAX_DEFER_MS } from '../background-gate.js'
import { _setPressureForTest, _resetPressureWatch } from '../machine-pressure.js'

function harness() {
  let busy = false
  let now = 0
  const pending: Array<() => void> = []
  return {
    seams: {
      busy: () => ({ busy, reasons: busy ? ['cpu'] : [] }),
      now: () => now,
      setTimeoutFn: (fn: () => void, ms: number) => { expect(ms).toBe(RECHECK_MS); pending.push(fn); return {} },
    },
    setBusy: (b: boolean) => { busy = b },
    /** One re-check round, RECHECK_MS later. */
    round: () => { now += RECHECK_MS; const f = pending.shift(); if (f) f() },
    pending: () => pending.length,
  }
}

describe('#897 background gate', () => {
  beforeEach(() => _resetGateStats())
  afterEach(() => { _resetPressureWatch(); vi.useRealTimers() })

  it('a calm machine runs the job at once', () => {
    const h = harness(); let runs = 0
    expect(gatedRun('a', () => { runs++ }, () => true, h.seams)).toBe('ran')
    expect(runs).toBe(1)
    expect(h.pending()).toBe(0)
  })

  it('a busy machine puts the job off, and it runs as soon as the machine has calmed down', () => {
    const h = harness(); let runs = 0
    h.setBusy(true)
    expect(gatedRun('b', () => { runs++ }, () => true, h.seams)).toBe('deferred')
    expect(runs).toBe(0)
    h.round(); h.round()
    expect(runs).toBe(0)
    h.setBusy(false)
    h.round()
    expect(runs).toBe(1)
    expect(gateStats().find((s) => s.name === 'b')).toMatchObject({ runs: 1, deferrals: 1, forced: 0, waitingSince: null, lastReasons: ['cpu'] })
  })

  it('does not pile up: while one run waits, later ticks of the same job queue nothing', () => {
    const h = harness(); let runs = 0
    h.setBusy(true)
    expect(gatedRun('c', () => { runs++ }, () => true, h.seams)).toBe('deferred')
    expect(gatedRun('c', () => { runs++ }, () => true, h.seams)).toBe('already-waiting')
    expect(gatedRun('c', () => { runs++ }, () => true, h.seams)).toBe('already-waiting')
    expect(h.pending()).toBe(1)
    h.setBusy(false); h.round()
    expect(runs).toBe(1)
  })

  it('is never lost: on a machine that stays busy the job runs after the longest wait', () => {
    const h = harness(); let runs = 0
    h.setBusy(true)
    gatedRun('d', () => { runs++ }, () => true, h.seams)
    const rounds = Math.ceil(MAX_DEFER_MS / RECHECK_MS)
    for (let i = 0; i < rounds - 1; i++) h.round()
    expect(runs).toBe(0)
    h.round()
    expect(runs).toBe(1)
    expect(gateStats().find((s) => s.name === 'd')?.forced).toBe(1)
  })

  it('a cleared timer gets no late run', () => {
    const h = harness(); let runs = 0; let alive = true
    h.setBusy(true)
    gatedRun('e', () => { runs++ }, () => alive, h.seams)
    alive = false; h.setBusy(false); h.round()
    expect(runs).toBe(0)
    // and the job is free to be scheduled again
    expect(gatedRun('e', () => { runs++ }, () => true, h.seams)).toBe('ran')
  })

  it('gatedInterval: plain setInterval when nothing is measured; waits on a busy machine', () => {
    vi.useFakeTimers()
    let runs = 0
    const t = gatedInterval('f', () => { runs++ }, 1000)
    vi.advanceTimersByTime(3000)
    expect(runs).toBe(3)
    _setPressureForTest({ at: Date.now(), cpu: 90, io: 0, memory: 0, load1: 1, cores: 8 })
    vi.advanceTimersByTime(1000)
    expect(runs).toBe(3)
    _setPressureForTest({ at: Date.now(), cpu: 1, io: 0, memory: 0, load1: 1, cores: 8 })
    vi.advanceTimersByTime(RECHECK_MS)
    expect(runs).toBeGreaterThan(3)
    clearInterval(t)
  })

  it('gatedInterval: after clearInterval a waiting run does not fire (real timers)', async () => {
    let runs = 0; let busy = true
    const seams = { busy: () => ({ busy, reasons: ['cpu'] }), setTimeoutFn: (fn: () => void) => setTimeout(fn, 30) }
    const t = gatedInterval('g', () => { runs++ }, 10, seams)
    await new Promise((r) => setTimeout(r, 25))
    expect(gateStats().find((s) => s.name === 'g')?.waitingSince).not.toBeNull()
    clearInterval(t)
    busy = false
    await new Promise((r) => setTimeout(r, 120))
    expect(runs).toBe(0)
    // the same job with a live timer does run once the machine is calm
    busy = true
    const t2 = gatedInterval('h', () => { runs++ }, 10, seams)
    await new Promise((r) => setTimeout(r, 25))
    busy = false
    await new Promise((r) => setTimeout(r, 120))
    clearInterval(t2)
    expect(runs).toBeGreaterThan(0)
  })
})
