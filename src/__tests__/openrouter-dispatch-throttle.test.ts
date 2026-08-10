import { describe, it, expect } from 'vitest'
import {
  throttleDelayMs,
  isFreeOpenRouterModel,
  MIN_DISPATCH_SPACING_MS,
  EFFECTIVE_FREE_MODEL_RPM,
} from '../openrouter-dispatch-throttle.js'

describe('throttleDelayMs', () => {
  it('is zero for the first dispatch in a batch (no previous)', () => {
    expect(throttleDelayMs(null, 1_000_000)).toBe(0)
  })

  it('is zero once enough time has already elapsed since the previous dispatch', () => {
    expect(throttleDelayMs(1_000_000, 1_000_000 + MIN_DISPATCH_SPACING_MS)).toBe(0)
    expect(throttleDelayMs(1_000_000, 1_000_000 + MIN_DISPATCH_SPACING_MS + 500)).toBe(0)
  })

  it('waits out the remaining spacing when dispatched too soon after the previous one', () => {
    const elapsed = 200
    expect(throttleDelayMs(1_000_000, 1_000_000 + elapsed)).toBe(MIN_DISPATCH_SPACING_MS - elapsed)
  })

  it('never returns a negative delay, even if "now" is somehow before the previous dispatch (clamps to a conservative, bounded wait instead)', () => {
    const delay = throttleDelayMs(1_000_000, 999_000)
    expect(delay).toBeGreaterThanOrEqual(0)
    expect(delay).toBe(MIN_DISPATCH_SPACING_MS + 1000)
  })

  it('keeps the effective rate under the real 20 RPM ceiling with its safety margin', () => {
    expect(EFFECTIVE_FREE_MODEL_RPM).toBeLessThan(20)
    // Spacing agents out at MIN_DISPATCH_SPACING_MS apart for a full minute
    // must not schedule more than EFFECTIVE_FREE_MODEL_RPM dispatches.
    const dispatchesPerMinute = Math.floor(60_000 / MIN_DISPATCH_SPACING_MS)
    expect(dispatchesPerMinute).toBeLessThanOrEqual(EFFECTIVE_FREE_MODEL_RPM)
  })
})

describe('isFreeOpenRouterModel', () => {
  it('recognizes a real fleet free model id', () => {
    expect(isFreeOpenRouterModel('nvidia/nemotron-3-super-120b-a12b:free')).toBe(true)
    expect(isFreeOpenRouterModel('google/gemma-4-31b-it:free')).toBe(true)
  })

  it('is case-insensitive on the :free suffix', () => {
    expect(isFreeOpenRouterModel('some/model:FREE')).toBe(true)
  })

  it('does not flag a paid model', () => {
    expect(isFreeOpenRouterModel('~openai/gpt-latest')).toBe(false)
    expect(isFreeOpenRouterModel('claude-sonnet-5')).toBe(false)
  })

  it('handles missing/malformed input gracefully', () => {
    expect(isFreeOpenRouterModel(null)).toBe(false)
    expect(isFreeOpenRouterModel(undefined)).toBe(false)
    expect(isFreeOpenRouterModel('')).toBe(false)
  })
})
