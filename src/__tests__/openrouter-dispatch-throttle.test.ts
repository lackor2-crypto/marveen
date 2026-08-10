import { describe, it, expect, beforeEach } from 'vitest'
import {
  isFreeOpenRouterModel,
  tryConsumeFreeDispatchSlot,
  freeDispatchesInWindow,
  _resetFreeDispatchWindowForTest,
  MIN_DISPATCH_SPACING_MS,
  EFFECTIVE_FREE_MODEL_RPM,
  FREE_WINDOW_MS,
} from '../openrouter-dispatch-throttle.js'

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

describe('account-wide free-tier dispatch window', () => {
  const T0 = 1_000_000

  beforeEach(() => {
    _resetFreeDispatchWindowForTest()
  })

  it('keeps the effective rate under the real 20 RPM ceiling with its safety margin', () => {
    expect(EFFECTIVE_FREE_MODEL_RPM).toBeLessThan(20)
    const dispatchesPerMinute = Math.floor(FREE_WINDOW_MS / MIN_DISPATCH_SPACING_MS)
    expect(dispatchesPerMinute).toBeLessThanOrEqual(EFFECTIVE_FREE_MODEL_RPM)
  })

  it('grants the first dispatch immediately', () => {
    expect(tryConsumeFreeDispatchSlot(T0)).toBe(true)
    expect(freeDispatchesInWindow(T0)).toBe(1)
  })

  it('refuses a second dispatch inside the anti-burst spacing, then grants it', () => {
    expect(tryConsumeFreeDispatchSlot(T0)).toBe(true)
    expect(tryConsumeFreeDispatchSlot(T0 + MIN_DISPATCH_SPACING_MS - 1)).toBe(false)
    expect(tryConsumeFreeDispatchSlot(T0 + MIN_DISPATCH_SPACING_MS)).toBe(true)
  })

  it('spends ONE budget across separate callers -- the whole point of the fix', () => {
    // Two verification rounds fired a second apart. Before the shared window
    // each kept its own pace and together doubled the real request rate.
    expect(tryConsumeFreeDispatchSlot(T0)).toBe(true)          // round A, agent 1
    expect(tryConsumeFreeDispatchSlot(T0 + 1000)).toBe(false)  // round B, agent 1
    expect(freeDispatchesInWindow(T0 + 1000)).toBe(1)
  })

  it('never lets more than the effective RPM through in any rolling minute', () => {
    let granted = 0
    // Hammer it every 100ms for two full minutes from every direction.
    for (let t = T0; t < T0 + 2 * FREE_WINDOW_MS; t += 100) {
      if (tryConsumeFreeDispatchSlot(t)) {
        granted++
        expect(freeDispatchesInWindow(t)).toBeLessThanOrEqual(EFFECTIVE_FREE_MODEL_RPM)
      }
    }
    // Two minutes of continuous demand must not exceed two minutes of budget.
    expect(granted).toBeLessThanOrEqual(2 * EFFECTIVE_FREE_MODEL_RPM)
    expect(granted).toBeGreaterThan(0)
  })

  it('enforces the ceiling even when spacing alone would allow more', () => {
    // 'interactive' skips the spacing gap, so only the hard ceiling stops it.
    let granted = 0
    for (let i = 0; i < 100; i++) {
      if (tryConsumeFreeDispatchSlot(T0 + i, 'interactive')) granted++
    }
    expect(granted).toBe(EFFECTIVE_FREE_MODEL_RPM)
  })

  it('lets interactive traffic past the spacing gap a fan-out is holding', () => {
    expect(tryConsumeFreeDispatchSlot(T0)).toBe(true)
    expect(tryConsumeFreeDispatchSlot(T0 + 50)).toBe(false)                  // fan-out waits
    expect(tryConsumeFreeDispatchSlot(T0 + 50, 'interactive')).toBe(true)    // human does not
  })

  it('frees budget again once dispatches age out of the window', () => {
    for (let i = 0; i < EFFECTIVE_FREE_MODEL_RPM; i++) {
      expect(tryConsumeFreeDispatchSlot(T0 + i * MIN_DISPATCH_SPACING_MS)).toBe(true)
    }
    // Still inside the first dispatch's minute: the budget is spent, and even
    // interactive traffic (which ignores spacing) hits the ceiling.
    const beforeExpiry = T0 + FREE_WINDOW_MS - 1
    expect(freeDispatchesInWindow(beforeExpiry)).toBe(EFFECTIVE_FREE_MODEL_RPM)
    expect(tryConsumeFreeDispatchSlot(beforeExpiry, 'interactive')).toBe(false)
    // A full window after the first one, its slot is back.
    const afterExpiry = T0 + FREE_WINDOW_MS
    expect(freeDispatchesInWindow(afterExpiry)).toBe(EFFECTIVE_FREE_MODEL_RPM - 1)
    expect(tryConsumeFreeDispatchSlot(afterExpiry)).toBe(true)
  })
})
