// #897: stopping / restarting an agent slept a FIXED 2-3 s on the main thread (measured: 2164 ms freeze). The wait
// now ends as soon as the old session's processes are gone, and is still capped at the old figure.
import { describe, it, expect } from 'vitest'
import { waitForTeardown } from '../web/agent-process.js'

function clock() {
  let t = 0
  const pauses: number[] = []
  return { now: () => t, pause: (ms: number) => { pauses.push(ms); t += ms }, pauses }
}

describe('#897 waitForTeardown', () => {
  it('returns at once when the processes are already gone', () => {
    const c = clock()
    expect(waitForTeardown([11, 12], 3000, { alive: () => false, pause: c.pause, now: c.now })).toBe(0)
    expect(c.pauses).toEqual([])
  })
  it('waits in short steps only until the last process has exited', () => {
    const c = clock()
    const waited = waitForTeardown([11], 3000, { alive: () => c.now() < 200, pause: c.pause, now: c.now })
    expect(waited).toBe(200)
    expect(c.pauses.every((p) => p === 50)).toBe(true)
  })
  it('never waits longer than the cap, even if a process will not die', () => {
    const c = clock()
    expect(waitForTeardown([11], 2000, { alive: () => true, pause: c.pause, now: c.now })).toBe(2000)
  })
  it('with no known process it keeps the old full wait (nothing to watch, so nothing is assumed)', () => {
    const c = clock()
    expect(waitForTeardown([], 2000, { alive: () => false, pause: c.pause, now: c.now })).toBe(2000)
    expect(c.pauses).toEqual([2000])
  })
})
