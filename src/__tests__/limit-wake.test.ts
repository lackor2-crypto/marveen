// Tests for the limit-reset wake decision (kanban 7951be7d).
//
// The failure this guards against has two halves, and both are exercised here:
// NOT waking an agent whose window has reset (the bug Boss reported -- the
// account sat silent with a reset window), and waking one too often (an idle
// account's data is permanently stale, so a state-based rule would ping it
// forever, and every ping is a paid turn).

import { describe, it, expect } from 'vitest'
import {
  crossedWindow,
  decideWake,
  decideWakes,
  recordWakeAttempt,
  recordWakeSuccess,
  INITIAL_WAKE_STATE,
  MIN_WAKE_GAP_MS,
  STARTUP_STALE_AFTER_MS,
  WAKE_MIN_USED_PCT,
  type WakeCandidate,
} from '../limit-wake.js'

const NOW = 1_786_460_000_000

function candidate(over: Partial<WakeCandidate> = {}): WakeCandidate {
  return {
    agent: 'someaccount',
    // Last turn was well before the boundary below -- the "agent stopped and
    // never came back" shape.
    lastDataAt: NOW - 3 * 3_600_000,
    windows: [{ usedPct: 100, resetsAt: NOW - 60_000 }],
    ...over,
  }
}

describe('crossedWindow', () => {
  it('returns null while every boundary is still ahead', () => {
    expect(crossedWindow([{ usedPct: 90, resetsAt: NOW + 60_000 }], NOW)).toBeNull()
  })

  it('ignores a window with no usage figure behind it', () => {
    expect(crossedWindow([{ usedPct: null, resetsAt: NOW - 60_000 }], NOW)).toBeNull()
    expect(crossedWindow([{ usedPct: 80, resetsAt: null }], NOW)).toBeNull()
  })

  it('picks the most recently crossed boundary, not the first', () => {
    const got = crossedWindow([
      { usedPct: 40, resetsAt: NOW - 7 * 24 * 3_600_000 }, // weekly, long past
      { usedPct: 100, resetsAt: NOW - 60_000 },            // five-hour, just now
    ], NOW)
    expect(got).toEqual({ resetsAt: NOW - 60_000, usedPct: 100 })
  })
})

describe('decideWake', () => {
  it('wakes an agent whose window reset with no data since (the reported bug)', () => {
    const d = decideWake(candidate(), INITIAL_WAKE_STATE, NOW, false)
    expect(d).toEqual({ agent: 'someaccount', reason: 'limit-reset', resetAt: NOW - 60_000 })
  })

  it('leaves an agent alone when it has already worked in the new window', () => {
    const d = decideWake(candidate({ lastDataAt: NOW - 30_000 }), INITIAL_WAKE_STATE, NOW, false)
    expect(d).toBeNull()
  })

  it('does not spend a turn on a reset that freed nothing', () => {
    const low = candidate({ windows: [{ usedPct: WAKE_MIN_USED_PCT - 1, resetsAt: NOW - 60_000 }] })
    expect(decideWake(low, INITIAL_WAKE_STATE, NOW, false)).toBeNull()
  })

  it('fires at most once per boundary', () => {
    const c = candidate()
    const first = decideWake(c, INITIAL_WAKE_STATE, NOW, false)!
    const after = recordWakeSuccess(recordWakeAttempt(INITIAL_WAKE_STATE, NOW), first)
    // Same boundary, a day later: the gap has long elapsed, the edge has not
    // moved -- still nothing to do.
    expect(decideWake(c, after, NOW + 24 * 3_600_000, false)).toBeNull()
    // A NEW boundary is a new edge.
    const nextWindow = candidate({ windows: [{ usedPct: 100, resetsAt: NOW + 5 * 3_600_000 }] })
    expect(decideWake(nextWindow, after, NOW + 6 * 3_600_000, false)?.reason).toBe('limit-reset')
  })

  it('a calm weekly window cannot suppress an exhausted five-hour reset', () => {
    // lackor3's review: ranking by recency alone picked the weekly row, whose
    // 20% failed the threshold, and the dead agent stayed dead.
    const both = candidate({
      windows: [
        { usedPct: 100, resetsAt: NOW - 2 * 3_600_000 }, // five-hour, exhausted
        { usedPct: 20, resetsAt: NOW - 3_600_000 },      // weekly, calm, more recent
      ],
    })
    expect(decideWake(both, INITIAL_WAKE_STATE, NOW, false)).toEqual({
      agent: 'someaccount', reason: 'limit-reset', resetAt: NOW - 2 * 3_600_000,
    })
  })

  it('survives a clock that jumped backwards', () => {
    // A lastWakeAt in the future would otherwise block every wake until real
    // time caught up -- days, after a suspend-resume drift.
    const future = { lastWakeAt: NOW + 7 * 24 * 3_600_000, lastResetAt: null }
    expect(decideWake(candidate(), future, NOW, false)?.reason).toBe('limit-reset')
  })

  it('honours the per-agent gap whatever the reason', () => {
    const recent = { lastWakeAt: NOW - MIN_WAKE_GAP_MS + 1_000, lastResetAt: null }
    expect(decideWake(candidate(), recent, NOW, false)).toBeNull()
    expect(decideWake(candidate(), recent, NOW, true)).toBeNull()
  })

  it('wakes stale agents on the startup pass only', () => {
    // No crossed boundary at all: the only reason available is startup.
    const idle = candidate({
      windows: [{ usedPct: 100, resetsAt: NOW + 3_600_000 }],
      lastDataAt: NOW - STARTUP_STALE_AFTER_MS - 1,
    })
    expect(decideWake(idle, INITIAL_WAKE_STATE, NOW, true)).toEqual({ agent: 'someaccount', reason: 'startup', resetAt: null })
    expect(decideWake(idle, INITIAL_WAKE_STATE, NOW, false)).toBeNull()
  })

  it('does not wake a working agent on startup', () => {
    const busy = candidate({
      windows: [{ usedPct: 100, resetsAt: NOW + 3_600_000 }],
      lastDataAt: NOW - 60_000,
    })
    expect(decideWake(busy, INITIAL_WAKE_STATE, NOW, true)).toBeNull()
  })

  it('wakes an agent that has never reported anything, on startup', () => {
    const unknown = candidate({ windows: [], lastDataAt: null })
    expect(decideWake(unknown, INITIAL_WAKE_STATE, NOW, true)?.reason).toBe('startup')
  })
})

describe('recordWakeAttempt / recordWakeSuccess', () => {
  const resetDecision = { agent: 'a', reason: 'limit-reset' as const, resetAt: NOW - 60_000 }

  it('the attempt takes the gap but not the boundary', () => {
    expect(recordWakeAttempt(INITIAL_WAKE_STATE, NOW)).toEqual({ lastWakeAt: NOW, lastResetAt: null })
  })

  it('only success consumes the boundary', () => {
    const attempted = recordWakeAttempt(INITIAL_WAKE_STATE, NOW)
    expect(recordWakeSuccess(attempted, resetDecision)).toEqual({ lastWakeAt: NOW, lastResetAt: NOW - 60_000 })
  })

  it('a failed send leaves the boundary for the next attempt (the swallowed-wake bug)', () => {
    const c = candidate()
    const attempted = recordWakeAttempt(INITIAL_WAKE_STATE, NOW) // send then fails: no success call
    // Within the gap: throttled, as intended.
    expect(decideWake(c, attempted, NOW + 60_000, false)).toBeNull()
    // After the gap: the same boundary is retried rather than lost forever.
    expect(decideWake(c, attempted, NOW + MIN_WAKE_GAP_MS + 1, false)?.resetAt).toBe(NOW - 60_000)
  })

  it('leaves a pending boundary unconsumed for a startup wake', () => {
    const prev = { lastWakeAt: 0, lastResetAt: 1234 }
    const s = recordWakeSuccess(recordWakeAttempt(prev, NOW), { agent: 'a', reason: 'startup', resetAt: null })
    expect(s).toEqual({ lastWakeAt: NOW, lastResetAt: 1234 })
  })
})

describe('decideWakes', () => {
  it('decides per agent and skips the ones with nothing to do', () => {
    const out = decideWakes(
      [
        candidate({ agent: 'reset-account' }),
        candidate({ agent: 'working-account', lastDataAt: NOW - 10_000 }),
      ],
      { 'reset-account': INITIAL_WAKE_STATE },
      NOW,
      false,
    )
    expect(out.map(d => d.agent)).toEqual(['reset-account'])
  })
})
