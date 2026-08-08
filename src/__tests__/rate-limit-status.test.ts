import { describe, it, expect } from 'vitest'
import {
  tierForPct,
  worseTier,
  tierForSnapshot,
  isStale,
  CAUTION_THRESHOLD_PCT,
  CRITICAL_THRESHOLD_PCT,
  STALE_AFTER_MS,
} from '../rate-limit-status.js'

describe('tierForPct', () => {
  it('is normal below the caution threshold', () => {
    expect(tierForPct(0)).toBe('normal')
    expect(tierForPct(89)).toBe('normal')
  })

  it('is caution at and above the caution threshold, below critical', () => {
    expect(tierForPct(CAUTION_THRESHOLD_PCT)).toBe('caution')
    expect(tierForPct(94)).toBe('caution')
  })

  it('is critical at and above the critical threshold', () => {
    expect(tierForPct(CRITICAL_THRESHOLD_PCT)).toBe('critical')
    expect(tierForPct(100)).toBe('critical')
  })

  it('treats null/NaN as normal (unmeasurable, not full)', () => {
    expect(tierForPct(null)).toBe('normal')
    expect(tierForPct(NaN)).toBe('normal')
  })
})

describe('worseTier', () => {
  it('picks the higher-severity tier regardless of argument order', () => {
    expect(worseTier('normal', 'caution')).toBe('caution')
    expect(worseTier('caution', 'normal')).toBe('caution')
    expect(worseTier('caution', 'critical')).toBe('critical')
    expect(worseTier('critical', 'normal')).toBe('critical')
    expect(worseTier('normal', 'normal')).toBe('normal')
  })
})

describe('tierForSnapshot', () => {
  it('is the worse of the 5h and 7d windows', () => {
    expect(tierForSnapshot({
      fiveHour: { usedPct: 96, resetsAt: null },
      sevenDay: { usedPct: 10, resetsAt: null },
    })).toBe('critical')
    expect(tierForSnapshot({
      fiveHour: { usedPct: 10, resetsAt: null },
      sevenDay: { usedPct: 92, resetsAt: null },
    })).toBe('caution')
  })

  it('ignores missing windows', () => {
    expect(tierForSnapshot({ fiveHour: null, sevenDay: null })).toBe('normal')
    expect(tierForSnapshot({ fiveHour: { usedPct: null, resetsAt: null }, sevenDay: null })).toBe('normal')
  })
})

describe('isStale', () => {
  it('is not stale right after capture', () => {
    expect(isStale(1000, 1000)).toBe(false)
    expect(isStale(1000, 1000 + STALE_AFTER_MS - 1)).toBe(false)
  })

  it('is stale once the threshold has elapsed', () => {
    expect(isStale(1000, 1000 + STALE_AFTER_MS)).toBe(true)
    expect(isStale(0, 60 * 60_000)).toBe(true)
  })
})
