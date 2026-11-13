// #799: the wake phase of the 5h quota window. Measured 2026-10-25: the window that opened at 11:10 stood at 75%
// by 11:27. New AUTOMATIC work may use at most WAKE_PHASE_CEILING_PCT of the frame in the first WAKE_PHASE_MINUTES;
// Boss's own messages are never held, and unknown data never freezes work.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { initDatabase } from '../db.js'
import {
  resetCodeBridgeTablesForTests, upsertCodeSession, recordCodeWorkerSeen, recordCodeCandidates,
  _resetCodeCandidates, enqueueCodeTask, claimNextCodeTask,
} from '../web/code-bridge-store.js'
import {
  wakePhaseState, wakePhaseHoldsOrigin, setWakePhaseProviderForTest, FIVE_HOUR_MS, WAKE_PHASE_STALE_MS,
  type WakePhaseState,
} from '../web/wake-phase.js'
import type { UsageHistorySample } from '../web/usage-history.js'

const MIN = 60_000
const OPENED = 1_000_000_000_000
const RESETS = OPENED + FIVE_HOUR_MS
const cfg = { ceilingPct: 10, phaseMinutes: 30 }
const sample = (t: number, pct: number | null, resetsAt: number | null = RESETS): UsageHistorySample =>
  ({ t, fiveHourPct: pct, fiveHourResetsAt: resetsAt, sevenDayPct: 10 })

describe('wakePhaseState (pure)', () => {
  it('holds new automatic work once the ceiling is reached inside the phase (the 2026-10-25 shape: 23% after 16 minutes)', () => {
    const now = OPENED + 16 * MIN
    const st = wakePhaseState([sample(now - 1000, 23)], now, cfg)
    expect(st).toMatchObject({ blocked: true, reason: 'ceiling-reached', usedPct: 23, openedAt: OPENED })
    expect(st.phaseEndsAt).toBe(OPENED + 30 * MIN)
  })
  it('lets work start while the phase is still under the ceiling', () => {
    const now = OPENED + 5 * MIN
    expect(wakePhaseState([sample(now - 1000, 9)], now, cfg)).toMatchObject({ blocked: false, reason: 'under-ceiling' })
  })
  it('releases the hold when the phase is over, however high the percentage stands', () => {
    const now = OPENED + 31 * MIN
    expect(wakePhaseState([sample(now - 1000, 60)], now, cfg)).toMatchObject({ blocked: false, reason: 'phase-over' })
  })
  it('tolerates the millisecond wobble of resetsAt (same window)', () => {
    const now = OPENED + 10 * MIN
    const h = [sample(now - 2000, 4, RESETS + 470), sample(now - 1000, 12, RESETS + 232)]
    expect(wakePhaseState(h, now, cfg).blocked).toBe(true)
  })
  it('fails open: no data, a stale reading, no window yet, or the guard switched off never block', () => {
    const now = OPENED + 10 * MIN
    expect(wakePhaseState([], now, cfg)).toMatchObject({ blocked: false, reason: 'no-data' })
    expect(wakePhaseState([sample(now - WAKE_PHASE_STALE_MS - 1, 50)], now, cfg)).toMatchObject({ blocked: false, reason: 'stale' })
    expect(wakePhaseState([sample(now - 1000, 0, null)], now, cfg)).toMatchObject({ blocked: false, reason: 'no-window' })
    expect(wakePhaseState([sample(now - 1000, 50)], now, { ...cfg, ceilingPct: 0 })).toMatchObject({ blocked: false, reason: 'off' })
    expect(wakePhaseState([sample(now - 1000, 50)], now, { ...cfg, phaseMinutes: 0 })).toMatchObject({ blocked: false, reason: 'off' })
  })
  it('never holds the owner own messages, holds every other origin', () => {
    const blocked: WakePhaseState = { blocked: true, reason: 'ceiling-reached', openedAt: 1, usedPct: 50, phaseEndsAt: 2 }
    expect(wakePhaseHoldsOrigin('telegram', blocked)).toBe(false)
    expect(wakePhaseHoldsOrigin('workbench', blocked)).toBe(false)
    for (const o of ['dashboard', 'api', 'agent']) expect(wakePhaseHoldsOrigin(o, blocked)).toBe(true)
    expect(wakePhaseHoldsOrigin('dashboard', { ...blocked, blocked: false })).toBe(false)
  })
})

describe('code-bridge claim under the wake-phase ceiling', () => {
  const WSL = { project: 'marveen', workspacePath: '\\\\wsl.localhost\\Ubuntu\\home\\boss\\marveen', sessionId: 'aaaaaaaa-0000-4000-8000-000000000001' }
  const WIN = { project: 'tozsde', workspacePath: 'C:\\Users\\boss\\tozsde', sessionId: 'bbbbbbbb-0000-4000-8000-000000000002' }
  const spent: WakePhaseState = { blocked: true, reason: 'ceiling-reached', openedAt: OPENED, usedPct: 23, phaseEndsAt: OPENED + 30 * MIN }
  const free: WakePhaseState = { blocked: false, reason: 'phase-over', openedAt: OPENED, usedPct: 60, phaseEndsAt: OPENED + 30 * MIN }

  beforeEach(() => {
    initDatabase(':memory:')
    resetCodeBridgeTablesForTests()
    _resetCodeCandidates()
    upsertCodeSession(WSL)
    upsertCodeSession(WIN)
    recordCodeWorkerSeen('windows', 'discovery', 1)
    recordCodeCandidates('windows', [])
  })
  afterEach(() => setWakePhaseProviderForTest(null))

  it('keeps a card-issued task waiting while the budget is spent, then releases it when the phase ends', () => {
    enqueueCodeTask({ project: 'marveen', prompt: 'kartya-munka', origin: 'dashboard' })
    setWakePhaseProviderForTest(() => spent)
    expect(claimNextCodeTask('windows')).toBeNull()
    setWakePhaseProviderForTest(() => free)
    expect(claimNextCodeTask('windows')?.prompt).toContain('kartya-munka')
  })
  it('does not hold the owner own Telegram message or Workbench chat', () => {
    setWakePhaseProviderForTest(() => spent)
    enqueueCodeTask({ project: 'marveen', prompt: 'Boss uzenete', origin: 'telegram' })
    expect(claimNextCodeTask('windows')?.prompt).toContain('Boss uzenete')
  })
  it('does not hold a session of the other (Windows) side: the reading is the main account only', () => {
    setWakePhaseProviderForTest(() => spent)
    enqueueCodeTask({ project: 'tozsde', prompt: 'windows-oldal', origin: 'api' })
    expect(claimNextCodeTask('windows')?.prompt).toContain('windows-oldal')
  })
  it('a held task does not block a different one that may go out', () => {
    setWakePhaseProviderForTest(() => spent)
    enqueueCodeTask({ project: 'marveen', prompt: 'automata', origin: 'api' })
    enqueueCodeTask({ project: 'tozsde', prompt: 'windows-oldal', origin: 'api' })
    expect(claimNextCodeTask('windows')?.prompt).toContain('windows-oldal')
  })
})
