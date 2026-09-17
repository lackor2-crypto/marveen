import { describe, it, expect } from 'vitest'
import { skipIfBusyMayDrop, SKIP_IF_BUSY_MAX_GAP_MS } from '../web/schedule-runner.js'

// A skipIfBusy drop is only harmless when the next tick is close behind. The
// weekly dream-engine (skipIfBusy=true) lost a whole week to one busy Monday.
describe('skipIfBusyMayDrop', () => {
  const now = Date.UTC(2026, 8, 14, 9, 0, 0)

  it('drops a busy tick of a short-cadence heartbeat', () => {
    expect(skipIfBusyMayDrop({ schedule: '*/30 * * * *', skipIfBusy: true }, now)).toBe(true)
  })

  it('does NOT drop a weekly task -- it queues the retry instead', () => {
    expect(skipIfBusyMayDrop({ schedule: '7 2 * * 1', skipIfBusy: true }, now)).toBe(false)
  })

  it('does NOT drop a daily task', () => {
    expect(skipIfBusyMayDrop({ schedule: '0 8 * * *', skipIfBusy: true }, now)).toBe(false)
  })

  it('never drops without skipIfBusy, or with forceSend', () => {
    expect(skipIfBusyMayDrop({ schedule: '*/30 * * * *', skipIfBusy: false }, now)).toBe(false)
    expect(skipIfBusyMayDrop({ schedule: '*/30 * * * *', skipIfBusy: true, forceSend: true }, now)).toBe(false)
  })

  it('the gap threshold is a few hours, not a day', () => {
    expect(SKIP_IF_BUSY_MAX_GAP_MS).toBeLessThan(24 * 60 * 60 * 1000)
  })
})
