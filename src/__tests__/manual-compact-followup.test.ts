// Boss, 2026-08-12: "tomoritesnel kezi gomb megnyomasanal a beallitott ertek
// alatt legyen mindenfelekeppen a tomorites nagysaga. ha veletlenul nagyobb
// lenne akkor meg tomoritsen rjata."
//
// Fair request: the number sits right next to the button, so pressing the button
// should honour it. One /compact does not, by itself -- the model summarizes what
// it can, and a context dominated by one enormous turn survives a round almost
// untouched.
//
// The danger is the obvious implementation: "compact until it fits" is a loop
// that burns an agent's entire quota on a context that cannot shrink. Every test
// below is about that boundary.
import { describe, it, expect } from 'vitest'
import { decideFollowUp, MAX_ROUNDS, MIN_REDUCTION } from '../web/manual-compact-followup.js'

const base = { tokens: 120_000, thresholdTokens: 80_000, round: 0, previousTokens: null }

describe('decideFollowUp', () => {
  it('stops once the context is under the threshold', () => {
    const d = decideFollowUp({ ...base, tokens: 59_000 })
    expect(d.again).toBe(false)
    expect(d.reason).toContain('59000 < 80000')
  })

  it('goes again while the context is still over it', () => {
    expect(decideFollowUp(base).again).toBe(true)
  })

  it('treats exactly-at-threshold as still over (the gate does too)', () => {
    expect(decideFollowUp({ ...base, tokens: 80_000 }).again).toBe(true)
  })

  it('gives up after the round budget instead of looping', () => {
    expect(decideFollowUp({ ...base, round: MAX_ROUNDS }).again).toBe(false)
    expect(decideFollowUp({ ...base, round: MAX_ROUNDS }).reason).toContain('already spent')
  })

  // The failure this guards against: a context whose size is one huge tool
  // result. Compaction cannot summarize it away, so every extra round costs a
  // full model call and changes nothing.
  it('stops when the previous round barely moved the number', () => {
    const d = decideFollowUp({ ...base, tokens: 119_000, previousTokens: 120_000, round: 1 })
    expect(d.again).toBe(false)
    expect(d.reason).toContain('120000 -> 119000')
  })

  it('keeps going when the previous round clearly worked', () => {
    // 300000 -> 120000 is a 60% cut, far past the evidence bar.
    expect(decideFollowUp({ ...base, tokens: 120_000, previousTokens: 300_000, round: 1 }).again).toBe(true)
  })

  it('uses the same evidence bar as the gate', () => {
    const previousTokens = 100_000
    const justUnder = Math.round(previousTokens * (1 - MIN_REDUCTION)) + 1   // shrank by <10%
    const justOver = Math.round(previousTokens * (1 - MIN_REDUCTION)) - 1    // shrank by >10%
    expect(decideFollowUp({ ...base, tokens: justUnder, previousTokens, round: 1 }).again).toBe(false)
    expect(decideFollowUp({ ...base, tokens: justOver, previousTokens, round: 1 }).again).toBe(true)
  })

  // A quota-limited agent reports no numbers at all. Sending it more compactions
  // would not produce one, and it is exactly the agent that can least afford it.
  it('does nothing when the context cannot be measured', () => {
    const d = decideFollowUp({ ...base, tokens: null })
    expect(d.again).toBe(false)
    expect(d.reason).toContain('unmeasurable')
  })
})
