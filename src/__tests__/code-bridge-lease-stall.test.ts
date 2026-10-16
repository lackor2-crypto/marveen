// #550 (5) and (6): a lease that runs out because the SERVER stood still must not re-queue work that is still
// going on, and the answer of a worker whose lease WAS reaped closes the task instead of being dropped while the
// same work starts a second time. Measured case (2026-10-10 16:49): an 8-minute server stall re-queued a running
// task ('lease expired, task re-queued') while the worker was still on the original run.

import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase } from '../db.js'
import {
  resetCodeBridgeTablesForTests, upsertCodeSession, enqueueCodeTask, claimNextCodeTask,
  completeCodeTaskDetailed, getCodeTask, LEASE_MS,
} from '../web/code-bridge-store.js'
import { codeBridgeTick, resetCodeBridgeTickForTests, STALL_GAP_MS } from '../web/code-bridge-runner.js'

const WS = { project: 'marvin', workspacePath: 'C:\\ws\\marvin', sessionId: 'aaaaaaaa-0000-4000-8000-000000000001' }

beforeEach(() => {
  initDatabase(':memory:')
  resetCodeBridgeTablesForTests()
  resetCodeBridgeTickForTests()
  upsertCodeSession(WS)
})

function runningTask(host: string, now: number): string {
  const out = enqueueCodeTask({ project: 'marvin', prompt: 'long one ' + Math.random(), origin: 'telegram' })
  if ('error' in out) throw new Error(out.error)
  const t = claimNextCodeTask(host, now)
  expect(t?.id).toBe(out.task.id)
  return out.task.id
}

describe('#550 (5) a server stall is not the workers\' fault', () => {
  it('a tick after a long gap extends the leases instead of re-queueing the running task', () => {
    const t0 = 1_000_000
    const id = runningTask('w', t0)
    codeBridgeTick(t0 + 1) // first tick of the process: also a "stall" (downtime unknown), nothing expired yet
    // The server then stands still for 8 minutes: no heartbeat could land, the lease (5 min) is over.
    const after = t0 + 8 * 60_000
    codeBridgeTick(after)
    const task = getCodeTask(id)!
    expect(task.status).toBe('running')
    expect(task.leaseExpiresAt).toBe(after + LEASE_MS)
  })

  it('a worker that really died is still re-queued, one lease window later', () => {
    const t0 = 1_000_000
    const id = runningTask('w', t0)
    codeBridgeTick(t0 + 1)
    const after = t0 + 8 * 60_000
    codeBridgeTick(after) // stall tick: extended
    codeBridgeTick(after + 60_000) // regular ticks, no heartbeat
    expect(getCodeTask(id)!.status).toBe('running')
    let t = after + 60_000
    while (t < after + LEASE_MS + 120_000) { t += 60_000; codeBridgeTick(t) }
    expect(getCodeTask(id)!.status).toBe('queued')
  })

  it('regular one-minute ticks reap an expired lease as before', () => {
    const t0 = 1_000_000
    const id = runningTask('w', t0)
    let t = t0
    codeBridgeTick(t)
    while (t < t0 + LEASE_MS + 120_000) { t += 60_000; codeBridgeTick(t) }
    expect(getCodeTask(id)!.status).toBe('queued')
    expect(STALL_GAP_MS).toBeGreaterThan(60_000)
  })
})

describe('#550 (6) the answer of the original run closes a re-queued task', () => {
  it('accepted while the task is queued again, and it does not start a second time', () => {
    const t0 = 1_000_000
    const id = runningTask('w', t0)
    codeBridgeTick(t0 + LEASE_MS + 1) // first tick (stall): extended
    let t = t0 + LEASE_MS + 1
    while (t < t0 + 2 * LEASE_MS + 120_000) { t += 60_000; codeBridgeTick(t) }
    expect(getCodeTask(id)!.status).toBe('queued')
    const r = completeCodeTaskDetailed(id, { ok: true, result: 'kesz' }, t + 1, 'w')
    expect(r.outcome).toBe('accepted')
    expect(getCodeTask(id)!.status).toBe('done')
    expect(claimNextCodeTask('w', t + 2)).toBeNull()
  })

  it('accepted when ANOTHER host already took the task over, and the second run lands as already-final', () => {
    const t0 = 1_000_000
    const id = runningTask('w1', t0)
    codeBridgeTick(t0 + LEASE_MS + 1)
    let t = t0 + LEASE_MS + 1
    while (t < t0 + 2 * LEASE_MS + 120_000) { t += 60_000; codeBridgeTick(t) }
    expect(claimNextCodeTask('w2', t + 1)?.id).toBe(id)
    const late = completeCodeTaskDetailed(id, { ok: true, result: 'az eredeti futas' }, t + 2, 'w1')
    expect(late.outcome).toBe('accepted')
    expect(getCodeTask(id)!.status).toBe('done')
    expect(getCodeTask(id)!.result).toBe('az eredeti futas')
    const second = completeCodeTaskDetailed(id, { ok: true, result: 'masodik' }, t + 3, 'w2')
    expect(second.outcome).toBe('already-final')
    expect(getCodeTask(id)!.result).toBe('az eredeti futas')
  })

  it('a host that never held the task is still refused as foreign', () => {
    const t0 = 1_000_000
    const id = runningTask('w1', t0)
    const r = completeCodeTaskDetailed(id, { ok: true, result: 'x' }, t0 + 5, 'stranger')
    expect(r.outcome).toBe('foreign-host')
    expect(getCodeTask(id)!.status).toBe('running')
  })
})
