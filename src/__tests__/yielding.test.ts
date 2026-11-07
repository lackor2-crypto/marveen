// #835: long sweeps must hand the event loop back between items instead of freezing the dashboard for seconds.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { drainSteps, drainStepsYielding, type Steps } from '../yielding.js'

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

// #872 (Boss TG 5301, 5.2 s freeze): one slow folder read must not hold the loop; the generator asks for it with `yield { readdir }`.
describe('folder reads inside a sweep (#872)', () => {
  const dirRead = function* (dir: string): Steps<number> {
    const got = yield { readdir: dir }
    return got ? got.length : -1
  }
  it('the sync drain answers the request with readdirSync (same result as before)', () => {
    expect(drainSteps(dirRead(__dirname))).toBeGreaterThan(10)
    expect(drainSteps(dirRead('/definitely/not/here'))).toBe(-1)
  })
  it('the async drain reads the folder asynchronously: a timer fires while it is read', async () => {
    let ticks = 0
    const t = setInterval(() => { ticks++ }, 1)
    const n = await drainStepsYielding(dirRead(__dirname))
    await new Promise((r) => setTimeout(r, 5))
    clearInterval(t)
    expect(n).toBeGreaterThan(10)
    expect(ticks).toBeGreaterThan(0)
    expect(await drainStepsYielding(dirRead('/definitely/not/here'))).toBe(-1)
  })
  it('the item-context inventory walk no longer calls readdirSync itself', () => {
    const src = readFileSync(join(__dirname, '..', 'workbench-item-context.ts'), 'utf8')
    expect(src).not.toMatch(/readdirSync\(/)
    expect(src).toContain('yield { readdir: abs }')
  })
})
