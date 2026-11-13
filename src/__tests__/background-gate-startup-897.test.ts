// #897: the first pass of a maintenance sweep runs a few seconds after start-up, i.e. right after a deploy restart
// while the build and the other services load the machine. It was a plain setTimeout, so the busy-machine gate never
// saw it (measured 2026-11-13: 0.9-1.1 s main-thread holds from exactly these start-up passes). It goes through
// gatedTimeout now, like the interval runs after it.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gatedTimeout, gateStats, _resetGateStats } from '../background-gate.js'

beforeEach(() => { _resetGateStats(); vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('gatedTimeout', () => {
  it('runs the job at its time when the machine is calm', () => {
    const fn = vi.fn()
    gatedTimeout('j', fn, 1000, { busy: () => ({ busy: false, reasons: [] }) })
    vi.advanceTimersByTime(999)
    expect(fn).not.toHaveBeenCalled()
    vi.advanceTimersByTime(2)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('puts the job off while the machine is busy and runs it once it has calmed down', () => {
    const fn = vi.fn()
    let busy = true
    gatedTimeout('j', fn, 1000, { busy: () => ({ busy, reasons: ['cpu'] }) })
    vi.advanceTimersByTime(1001)
    expect(fn).not.toHaveBeenCalled() // the bug: a plain setTimeout would have run it here
    expect(gateStats().find((s) => s.name === 'j:start')?.deferrals).toBe(1)
    busy = false
    vi.advanceTimersByTime(20_001)
    expect(fn).toHaveBeenCalledTimes(1)
  })
})

describe('the start-up passes of the sweeps use it', () => {
  const root = join(__dirname, '..')
  for (const [file, name] of [['workbench-item-context.ts', 'workbench-item-context'], ['workbench-relocate.ts', 'workbench-relocate'], ['life-folder-ids.ts', 'life-folder-ids']] as const) {
    it(`${file}: the first run goes through the gate`, () => {
      const src = readFileSync(join(root, file), 'utf8')
      expect(src).toContain(`gatedTimeout('${name}'`)
    })
  }
})
