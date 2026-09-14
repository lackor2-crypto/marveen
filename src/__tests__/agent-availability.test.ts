import { describe, expect, it } from 'vitest'
import {
  snapshotSaysBlocked,
  firstWorkingAgent,
  pickAnyTarget,
  decideVerifyStarted,
  QUOTA_SNAPSHOT_MAX_AGE_MS,
  VERIFY_STARTED_WINDOW_MS,
} from '../web/agent-availability.js'

const NOW = 1_789_400_000_000

// A window that is not at the wall.
const ok = (usedPct: number) => ({ usedPct, resetsAt: NOW + 3_600_000 })

describe('snapshotSaysBlocked', () => {
  it('null snapshot is not blocked (fresh install, no reading yet)', () => {
    expect(snapshotSaysBlocked(null, NOW)).toBe(false)
  })

  it('a fresh 7-day wall blocks (the gold-analysis loss: weekly exhausted, not 5h)', () => {
    const snap = { fiveHour: ok(20), sevenDay: { usedPct: 100, resetsAt: NOW + 86_400_000 }, measuredAt: NOW - 60_000 }
    expect(snapshotSaysBlocked(snap, NOW)).toBe(true)
  })

  it('a fresh 5-hour wall blocks', () => {
    const snap = { fiveHour: { usedPct: 100, resetsAt: NOW + 600_000 }, sevenDay: ok(40), measuredAt: NOW - 10_000 }
    expect(snapshotSaysBlocked(snap, NOW)).toBe(true)
  })

  it('below the ceiling is not blocked', () => {
    const snap = { fiveHour: ok(99), sevenDay: ok(88), measuredAt: NOW - 10_000 }
    expect(snapshotSaysBlocked(snap, NOW)).toBe(false)
  })

  it('a window whose reset is already in the past does NOT block (wall is down)', () => {
    const snap = { fiveHour: { usedPct: 100, resetsAt: NOW - 1 }, sevenDay: ok(10), measuredAt: NOW - 10_000 }
    expect(snapshotSaysBlocked(snap, NOW)).toBe(false)
  })

  it('a stale reading is not trusted to prove a block (fail-open)', () => {
    const snap = { fiveHour: { usedPct: 100, resetsAt: NOW + 600_000 }, sevenDay: ok(10), measuredAt: NOW - QUOTA_SNAPSHOT_MAX_AGE_MS - 1 }
    expect(snapshotSaysBlocked(snap, NOW)).toBe(false)
  })

  it('a null usedPct never blocks', () => {
    const snap = { fiveHour: { usedPct: null, resetsAt: NOW + 600_000 }, sevenDay: null, measuredAt: NOW - 10_000 }
    expect(snapshotSaysBlocked(snap, NOW)).toBe(false)
  })
})

describe('firstWorkingAgent', () => {
  const running = (set: string[]) => (a: string) => set.includes(a)
  const blocked = (set: string[]) => (a: string) => set.includes(a)

  it('returns the first agent that is running AND not blocked', () => {
    expect(firstWorkingAgent(['m', 'a', 'b'], running(['m', 'a', 'b']), blocked(['m']))).toBe('a')
  })

  it('returns undefined when every running agent is blocked', () => {
    expect(firstWorkingAgent(['a', 'b'], running(['a', 'b']), blocked(['a', 'b']))).toBeUndefined()
  })

  it('skips agents that are not running', () => {
    expect(firstWorkingAgent(['a', 'b'], running(['b']), blocked([]))).toBe('b')
  })
})

describe('pickAnyTarget', () => {
  const running = (set: string[]) => (a: string) => set.includes(a)
  const blocked = (set: string[]) => (a: string) => set.includes(a)

  it('prefers a working agent over an awake-but-blocked one', () => {
    expect(pickAnyTarget(['main', 'a', 'b'], running(['main', 'a']), blocked(['main']), 'main')).toBe('a')
  })

  it('falls back to the first awake agent when all are blocked', () => {
    expect(pickAnyTarget(['a', 'b'], running(['a', 'b']), blocked(['a', 'b']), 'main')).toBe('a')
  })

  it('falls back to the main agent when nobody is awake (cold-start)', () => {
    expect(pickAnyTarget(['a', 'b'], running([]), blocked([]), 'main')).toBe('main')
  })
})

describe('decideVerifyStarted', () => {
  it('holds inside the verify window', () => {
    expect(decideVerifyStarted({ injectedAt: NOW, sawBusy: false, blockedNow: true }, NOW + VERIFY_STARTED_WINDOW_MS - 1)).toBe('hold')
  })

  it('holds after the window if the agent actually started (sawBusy)', () => {
    expect(decideVerifyStarted({ injectedAt: NOW, sawBusy: true, blockedNow: true }, NOW + VERIFY_STARTED_WINDOW_MS + 1)).toBe('hold')
  })

  it('holds when we cannot prove a non-start (agent not blocked -- may have finished fast)', () => {
    expect(decideVerifyStarted({ injectedAt: NOW, sawBusy: false, blockedNow: false }, NOW + VERIFY_STARTED_WINDOW_MS + 1)).toBe('hold')
  })

  it('re-fires only on a PROVABLE non-start: window elapsed, never busy, agent at its wall', () => {
    expect(decideVerifyStarted({ injectedAt: NOW, sawBusy: false, blockedNow: true }, NOW + VERIFY_STARTED_WINDOW_MS + 1)).toBe('refire')
  })
})
