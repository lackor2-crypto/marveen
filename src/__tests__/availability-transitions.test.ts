// #463: the availability watchdog's pure decisions -- edges, no duplicate
// notification, baseline on first measurement.
import { describe, expect, it } from 'vitest'
import {
  MIN_NOTIFY_GAP_MS,
  availableMessage,
  blockingResetsAt,
  mayNotify,
  measureAvailability,
  planTransitions,
  type AgentAvailability,
} from '../availability-transitions.js'
import type { BrokerCandidate } from '../context-broker.js'

const NOW = 1_800_000_000_000
const cand = (over: Partial<BrokerCandidate> = {}): BrokerCandidate => ({
  agent: 'a1', running: true, usedPct: 10, usageAt: NOW, ...over,
})

describe('measureAvailability', () => {
  it('available when running and under the line', () => {
    expect(measureAvailability(cand(), [], NOW)).toMatchObject({ available: true, reason: 'ok', since: NOW, resetsAt: null })
  })
  it('quota when running but at the critical line, with the rollover time', () => {
    const resetsAt = NOW + 3600_000
    const m = measureAvailability(cand({ usedPct: 100 }), [{ usedPct: 100, resetsAt }], NOW)
    expect(m).toMatchObject({ available: false, reason: 'quota', resetsAt })
  })
  it('stopped when there is no session', () => {
    expect(measureAvailability(cand({ running: false }), [], NOW)).toMatchObject({ available: false, reason: 'stopped' })
  })
  it('keeps `since` while the state is unchanged, resets it on change', () => {
    const prev = measureAvailability(cand(), [], NOW - 5000)
    expect(measureAvailability(cand(), [], NOW, prev).since).toBe(NOW - 5000)
    expect(measureAvailability(cand({ running: false }), [], NOW, prev).since).toBe(NOW)
  })
  it('a stale 100% reading is not treated as exhausted (window long rolled over)', () => {
    const m = measureAvailability(cand({ usedPct: 100, usageAt: NOW - 3 * 3600_000 }), [{ usedPct: 100, resetsAt: NOW - 1000 }], NOW)
    expect(m.available).toBe(true)
  })
})

describe('measureAvailability at the window boundary', () => {
  it('a fresh 100% snapshot whose reset time has passed is available at once', () => {
    const m = measureAvailability(cand({ usedPct: 100, usageAt: NOW - 60_000 }), [{ usedPct: 100, resetsAt: NOW - 1 }], NOW)
    expect(m).toMatchObject({ available: true, reason: 'ok' })
  })
  it('an expired window does not hide a still-live exhausted one', () => {
    const m = measureAvailability(cand({ usedPct: 100 }), [{ usedPct: 100, resetsAt: NOW - 1 }, { usedPct: 99, resetsAt: NOW + 5000 }], NOW)
    expect(m).toMatchObject({ available: false, reason: 'quota', resetsAt: NOW + 5000 })
  })
})

describe('blockingResetsAt', () => {
  it('latest future reset among critical windows; ignores past and low ones', () => {
    expect(blockingResetsAt([
      { usedPct: 100, resetsAt: NOW + 1000 },
      { usedPct: 96, resetsAt: NOW + 9000 },
      { usedPct: 50, resetsAt: NOW + 99000 },
      { usedPct: 100, resetsAt: NOW - 5 },
    ], NOW)).toBe(NOW + 9000)
    expect(blockingResetsAt([], NOW)).toBeNull()
  })
})

describe('planTransitions', () => {
  const entry = (agent: string, available: boolean, reason: AgentAvailability['reason']): AgentAvailability => ({
    agent, available, reason, since: NOW - 1, resetsAt: null, measuredAt: NOW - 1,
  })
  const prev = { a1: entry('a1', false, 'quota'), a2: entry('a2', true, 'ok') }

  it('reports blocked -> available for the agent that woke, and only that', () => {
    const t = planTransitions(prev, [{ ...entry('a1', true, 'ok'), measuredAt: NOW }, { ...entry('a2', true, 'ok'), measuredAt: NOW }])
    expect(t).toEqual([{ agent: 'a1', to: 'available', fromReason: 'quota', reason: 'ok', at: NOW }])
  })
  it('reports available -> blocked too', () => {
    const t = planTransitions(prev, [entry('a1', false, 'quota'), { ...entry('a2', false, 'stopped'), measuredAt: NOW }])
    expect(t).toHaveLength(1)
    expect(t[0]).toMatchObject({ agent: 'a2', to: 'blocked', reason: 'stopped' })
  })
  it('no duplicate: an unchanged state yields nothing', () => {
    expect(planTransitions(prev, [entry('a1', false, 'quota'), entry('a2', true, 'ok')])).toEqual([])
  })
  it('first measurement (no previous entry) is a baseline, not news', () => {
    expect(planTransitions({}, [entry('a1', true, 'ok')])).toEqual([])
  })
})

describe('mayNotify', () => {
  it('allows the first message, blocks inside the gap, allows after it', () => {
    const s = { agents: {}, notifiedAt: { a1: NOW } }
    expect(mayNotify({ agents: {}, notifiedAt: {} }, 'a1', NOW)).toBe(true)
    expect(mayNotify(s, 'a1', NOW + MIN_NOTIFY_GAP_MS - 1)).toBe(false)
    expect(mayNotify(s, 'a1', NOW + MIN_NOTIFY_GAP_MS)).toBe(true)
  })
})

describe('availableMessage', () => {
  it('goes to the awakened agent and carries its pending work', () => {
    const m = availableMessage('a1', 'quota', '- #463 valami')
    expect(m).toContain('[ELERHETO] a1')
    expect(m).toContain('#463')
  })
})
