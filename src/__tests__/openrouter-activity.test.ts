import { describe, it, expect } from 'vitest'
import {
  aggregateActivityByModel,
  activityRowEpoch,
  totalSpend,
  type OpenRouterActivityRow,
} from '../openrouter-activity.js'

// Shape and numbers taken from a real GET /api/v1/activity response
// (2026-08-10). The three costed models are the ones Boss compared against
// OpenRouter's own dashboard, which showed $7.22 / $1.20 / $0.59 -- our
// token-derived estimate for the first one was $0.7772.
const ROWS: OpenRouterActivityRow[] = [
  { date: '2026-08-07 00:00:00', model: 'openai/gpt-5.6-sol', usage: 3.1, requests: 40, prompt_tokens: 900_000, completion_tokens: 20_000, reasoning_tokens: 15_000 },
  { date: '2026-08-08 00:00:00', model: 'openai/gpt-5.6-sol', usage: 4.1178, requests: 62, prompt_tokens: 1_100_000, completion_tokens: 5_854, reasoning_tokens: 4_000 },
  { date: '2026-08-09 00:00:00', model: 'openai/gpt-5.5', usage: 1.1995, requests: 12, prompt_tokens: 300_000, completion_tokens: 8_000, reasoning_tokens: 0 },
  { date: '2026-08-09 00:00:00', model: 'anthropic/claude-haiku-4.5', usage: 0.5884, requests: 36, prompt_tokens: 1_317, completion_tokens: 12_602, reasoning_tokens: 0 },
  // A free model: real rows exist, but they cost nothing.
  { date: '2026-08-09 00:00:00', model_permaslug: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning-20260428', model: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning', usage: 0, requests: 32, prompt_tokens: 2_133_455, completion_tokens: 17_103, reasoning_tokens: 13_894 },
]

const AUG7 = Date.UTC(2026, 7, 7) / 1000
const AUG9 = Date.UTC(2026, 7, 9) / 1000

describe('activityRowEpoch', () => {
  it('reads the UTC day, not the host-local one', () => {
    expect(activityRowEpoch('2026-08-09 00:00:00')).toBe(Date.UTC(2026, 7, 9) / 1000)
  })

  it('returns null for an unparseable date instead of guessing', () => {
    expect(activityRowEpoch('')).toBeNull()
    expect(activityRowEpoch('tegnap')).toBeNull()
  })
})

describe('aggregateActivityByModel', () => {
  it('sums a model across days into the real billed dollars', () => {
    const byModel = aggregateActivityByModel(ROWS, AUG7)
    // 3.1 + 4.1178, the figure OpenRouter's dashboard rounds to $7.22.
    expect(byModel.get('openai/gpt-5.6-sol')!.cost).toBeCloseTo(7.2178, 4)
    expect(byModel.get('openai/gpt-5.6-sol')!.requests).toBe(102)
  })

  it('keeps reasoning tokens, which the local token counters never saw', () => {
    const byModel = aggregateActivityByModel(ROWS, AUG7)
    expect(byModel.get('openai/gpt-5.6-sol')!.reasoningTokens).toBe(19_000)
  })

  it('excludes days before the period start', () => {
    const byModel = aggregateActivityByModel(ROWS, AUG9)
    expect(byModel.has('openai/gpt-5.6-sol')).toBe(false)
    expect(byModel.get('openai/gpt-5.5')!.cost).toBeCloseTo(1.1995, 4)
  })

  it('falls back to model_permaslug only when model is absent', () => {
    const rows: OpenRouterActivityRow[] = [{ date: '2026-08-09 00:00:00', model_permaslug: 'vendor/thing-20260428', usage: 0.5 }]
    const byModel = aggregateActivityByModel(rows, AUG7)
    expect([...byModel.keys()]).toEqual(['vendor/thing-20260428'])
  })

  it('skips rows with no model id at all rather than bucketing them together', () => {
    const byModel = aggregateActivityByModel([{ date: '2026-08-09 00:00:00', usage: 9 }], AUG7)
    expect(byModel.size).toBe(0)
  })

  it('keeps free models at zero cost instead of dropping them', () => {
    const byModel = aggregateActivityByModel(ROWS, AUG7)
    const free = byModel.get('nvidia/nemotron-3-nano-omni-30b-a3b-reasoning')!
    expect(free.cost).toBe(0)
    expect(free.requests).toBe(32)
  })
})

describe('totalSpend', () => {
  it('adds up to the account total for the period', () => {
    expect(totalSpend(aggregateActivityByModel(ROWS, AUG7))).toBeCloseTo(9.0057, 4)
  })

  it('is zero for an empty aggregate', () => {
    expect(totalSpend(new Map())).toBe(0)
  })
})
