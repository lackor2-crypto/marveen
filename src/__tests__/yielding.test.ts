// #835: long sweeps must hand the event loop back between items instead of freezing the dashboard for seconds.
import { describe, it, expect } from 'vitest'
import { drainSteps, drainStepsYielding } from '../yielding.js'

function* steps(n: number, busyMs: number): Generator<void, number, void> {
  for (let i = 0; i < n; i++) { yield; const t = Date.now(); while (Date.now() - t < busyMs) { /* spin */ } }
  return n
}

describe('yielding sweeps (#835)', () => {
  it('drainSteps returns the generator result synchronously', () => {
    expect(drainSteps(steps(5, 0))).toBe(5)
  })
  it('drainStepsYielding lets timers run during a long pass and returns the same result', async () => {
    let ticks = 0
    const t = setInterval(() => { ticks++ }, 1)
    const r = await drainStepsYielding(steps(20, 5), 8)
    clearInterval(t)
    expect(r).toBe(20)
    expect(ticks).toBeGreaterThan(3)
  })
  it('the sweeps use the stepping helpers', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const snap = readFileSync(join(__dirname, '..', 'workbench-snapshot.ts'), 'utf8')
    expect(snap).toMatch(/setInterval\(\(\) => \{\s*sweepSnapshotsAsync\(\)/)
    const web = readFileSync(join(__dirname, '..', 'web.ts'), 'utf8')
    expect(web).toContain('ensureAllAttachmentsFoldersAsync()')
  })
})
