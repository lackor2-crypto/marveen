import { describe, it, expect } from 'vitest'
import { deriveOpenRouterCreditsView } from '../openrouter-credits.js'

describe('deriveOpenRouterCreditsView', () => {
  it('computes remaining balance and usage % (real account snapshot, 2026-08-09)', () => {
    const v = deriveOpenRouterCreditsView({ totalCredits: 10, totalUsage: 9.3683917 })
    expect(v.remaining).toBeCloseTo(0.6316083, 5)
    expect(v.usedPct).toBeCloseTo(93.683917, 5)
    expect(v.tier).toBe('caution')
  })

  it('is normal well below the caution threshold', () => {
    const v = deriveOpenRouterCreditsView({ totalCredits: 100, totalUsage: 10 })
    expect(v.tier).toBe('normal')
  })

  it('is critical at/above the critical threshold', () => {
    const v = deriveOpenRouterCreditsView({ totalCredits: 10, totalUsage: 9.6 })
    expect(v.tier).toBe('critical')
  })

  it('does not divide by zero when no credits were ever purchased', () => {
    const v = deriveOpenRouterCreditsView({ totalCredits: 0, totalUsage: 0 })
    expect(v.usedPct).toBeNull()
    expect(v.tier).toBe('normal')
    expect(v.remaining).toBe(0)
  })
})
