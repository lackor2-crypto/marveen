import { describe, it, expect } from 'vitest'
import { sanityCheckFiveHour, FIVE_HOUR_WINDOW_MS } from '../web/routes/overview.js'

// A scraped usage row is only believable if the window it claims to describe
// still exists. Both directions matter, and only one of them was checked:
//
//   too far ahead -- the reading came from the WEEKLY banner, and pairing it
//     with a five-hour label produced "100% used, resets in 23 hours"
//     (Boss, 2026-08-10).
//   already past -- the window rolled over and the reading is spent. Nothing
//     rewrites the cache except a successful fresh scrape, so an expired row is
//     served forever: usalackor sat at a frozen percentage with a resetsAt
//     eleven hours old, and the number would not climb (Boss, 2026-08-14).
//
// The second case is what these tests were written for; the first is here so a
// future simplification cannot quietly drop it.

const NOW = 1_786_700_000_000
const MIN = 60_000

describe('sanityCheckFiveHour', () => {
  it('keeps a reading whose window resets within the next five hours', () => {
    const row = { usedPct: 48, resetsAt: NOW + 3 * 60 * MIN }
    expect(sanityCheckFiveHour(row, NOW)).toEqual(row)
  })

  it('discards a reading whose reset is too far out to be the five-hour window', () => {
    const row = { usedPct: 100, resetsAt: NOW + 23 * 60 * MIN }
    expect(sanityCheckFiveHour(row, NOW)).toEqual({ usedPct: null, resetsAt: null })
  })

  it('discards a reading whose window has already reset', () => {
    // The measured case: usedPct 100 with a reset eleven hours in the past.
    const row = { usedPct: 100, resetsAt: NOW - 11 * 60 * MIN }
    expect(sanityCheckFiveHour(row, NOW)).toEqual({ usedPct: null, resetsAt: null })
  })

  it('tolerates a reset a few minutes past, where clock skew and minute-rounding live', () => {
    const row = { usedPct: 70, resetsAt: NOW - 5 * MIN }
    expect(sanityCheckFiveHour(row, NOW)).toEqual(row)
  })

  it('leaves an incomplete row alone -- there is nothing to contradict', () => {
    expect(sanityCheckFiveHour({ usedPct: null, resetsAt: NOW - 99 * 60 * MIN }, NOW))
      .toEqual({ usedPct: null, resetsAt: NOW - 99 * 60 * MIN })
    expect(sanityCheckFiveHour({ usedPct: 100, resetsAt: null }, NOW))
      .toEqual({ usedPct: 100, resetsAt: null })
  })

  it('preserves the other fields on the row it passes through', () => {
    const row = { usedPct: 12, resetsAt: NOW + MIN, model: 'Sonnet 5', capturedAt: NOW }
    expect(sanityCheckFiveHour(row, NOW)).toEqual(row)
  })

  it('keeps the window length it is named after', () => {
    expect(FIVE_HOUR_WINDOW_MS).toBe(5 * 60 * 60 * 1000)
  })
})
