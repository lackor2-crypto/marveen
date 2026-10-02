// #463: the availability watchdog's pure decisions -- edges, no duplicate
// notification, baseline on first measurement.
import { describe, expect, it } from 'vitest'
import {
  MIN_NOTIFY_GAP_MS,
  availableMessage,
  blockingResetsAt,
  mayNotify,
  measureAvailability,
  planPendingText,
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

describe('stale snapshot with a future reset', () => {
  it('an old 100% whose window has not rolled over is still blocked (lackor3 case)', () => {
    const resetsAt = NOW + 3 * 86_400_000
    const m = measureAvailability(cand({ usedPct: 100, usageAt: NOW - 3 * 3600_000 }), [{ usedPct: 100, resetsAt }], NOW)
    expect(m).toMatchObject({ available: false, reason: 'quota', resetsAt })
  })
})

// The bug this guards: an exhausted agent stops writing snapshots, so its
// reading goes stale -- and a stale reading used to count as "unknown, so
// usable". The live log showed it: an agent with a weekly window at 100% that
// resets three days later was listed as available until it happened to render.
describe('measureAvailability with a spent window whose reset is still ahead', () => {
  const STALE = NOW - 3 * 3600_000
  it('stays blocked however old the snapshot is', () => {
    const resetsAt = NOW + 3 * 24 * 3600_000
    const m = measureAvailability(cand({ usedPct: 100, usageAt: STALE }), [{ usedPct: 0, resetsAt: NOW + 3600_000 }, { usedPct: 100, resetsAt }], NOW)
    expect(m).toMatchObject({ available: false, reason: 'quota', resetsAt })
  })
  it('so no "you are back" edge fires while the window is still spent', () => {
    const resetsAt = NOW + 3 * 24 * 3600_000
    const fresh = measureAvailability(cand({ usedPct: 100, usageAt: NOW - 60_000 }), [{ usedPct: 100, resetsAt }], NOW - 60_000)
    const stale = measureAvailability(cand({ usedPct: 100, usageAt: NOW - 60_000 }), [{ usedPct: 100, resetsAt }], NOW + 2 * 3600_000, fresh)
    expect(planTransitions({ a1: fresh }, [stale])).toEqual([])
    expect(stale.since).toBe(fresh.since)
  })
  it('the edge fires at the reset time itself, snapshot stale or not', () => {
    const resetsAt = NOW + 1000
    const before = measureAvailability(cand({ usedPct: 100, usageAt: STALE }), [{ usedPct: 100, resetsAt }], NOW)
    const after = measureAvailability(cand({ usedPct: 100, usageAt: STALE }), [{ usedPct: 100, resetsAt }], NOW + 1000, before)
    expect(before.available).toBe(false)
    expect(planTransitions({ a1: before }, [after])).toEqual([
      { agent: 'a1', to: 'available', fromReason: 'quota', reason: 'ok', at: NOW + 1000 },
    ])
  })
  it('a stale critical reading with NO known reset time is still treated as unknown', () => {
    const m = measureAvailability(cand({ usedPct: 100, usageAt: STALE }), [{ usedPct: 100, resetsAt: null }], NOW)
    expect(m.available).toBe(true)
  })
  it('a stopped agent with a spent window says when the window rolls over', () => {
    const resetsAt = NOW + 5000
    const m = measureAvailability(cand({ running: false, usedPct: 100 }), [{ usedPct: 100, resetsAt }], NOW)
    expect(m).toMatchObject({ available: false, reason: 'stopped', resetsAt })
  })
  it('without windows it trusts the candidate (the broker store already measured it)', () => {
    const m = measureAvailability(cand({ usedPct: null, usageAt: STALE, blockedUntil: NOW + 5000 }), [], NOW)
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
  it('is a statement of fact, not an order (it arrives framed as untrusted)', () => {
    const m = availableMessage('a1', 'quota', 'x')
    expect(m).toContain('nem utasitas')
    expect(m).not.toMatch(/Folytasd/)
  })
})

describe('planPendingText', () => {
  const none = { cards: [], memories: [], waitingMessages: 0, unreadable: false }
  it('stays silent when nothing is waiting', () => {
    expect(planPendingText(none)).toEqual({ send: false, text: '', note: 'no message (no pending work)' })
  })
  it('zero because the store was unreadable is NOT silence', () => {
    const p = planPendingText({ ...none, unreadable: true })
    expect(p.send).toBe(true)
    expect(p.text).toContain('nem sikerult kiolvasni')
    expect(p.note).toContain('unreadable')
  })
  it('lists the cards by their number, the memories and the waiting messages', () => {
    const p = planPendingText({
      cards: [{ seq: 463, title: 'Figyelo' }, { title: 'Sorszam nelkul' }],
      memories: [{ id: 7, content: 'legutobbi munka' }],
      waitingMessages: 2,
      unreadable: false,
    })
    expect(p.send).toBe(true)
    expect(p.text).toContain('  - #463 Figyelo')
    expect(p.text).toContain('  - Sorszam nelkul')
    expect(p.text).toContain('[emlek 7] legutobbi munka')
    expect(p.text).toContain('Feldolgozatlan uzeneted: 2 db.')
    expect(p.note).toBe('message sent (2 card(s), 2 message(s))')
  })
  it('waiting messages alone are enough to send', () => {
    expect(planPendingText({ ...none, waitingMessages: 1 }).send).toBe(true)
  })
  it('never carries the session-restart wording: this session ran all along', () => {
    const p = planPendingText({ ...none, cards: [{ seq: 1, title: 't' }] })
    expect(p.text).not.toMatch(/ures jaratban|ujrainditas|koszon/i)
  })
})
