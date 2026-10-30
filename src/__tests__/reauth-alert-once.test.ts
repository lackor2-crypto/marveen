import { describe, it, expect } from 'vitest'
import { nextAlerted, ALERT_CLEAR_AFTER_MS, decideReauthAction, NO_REAUTH_STATE } from '../web/reauth-healer.js'

// Owner 2026-10-30: one alert per dead agent, nothing more until the login really happened.
describe('alert-once memory', () => {
  const t0 = 1_000_000
  const base = { a: { alertedAtMs: t0, lastDeadAtMs: t0 } }

  it('a single clean probe (flapping pane) does not clear the mark', () => {
    expect(nextAlerted(base, 'a', false, t0 + 3 * 60_000)).toBe(base)
  })
  it('a dead probe extends the quiet-spell clock', () => {
    const m = nextAlerted(base, 'a', true, t0 + 10 * 60_000)
    expect(m.a.lastDeadAtMs).toBe(t0 + 10 * 60_000)
    expect(nextAlerted(m, 'a', false, t0 + 10 * 60_000 + ALERT_CLEAR_AFTER_MS - 1)).toBe(m)
  })
  it('only a long uninterrupted healthy spell clears it', () => {
    expect(nextAlerted(base, 'a', false, t0 + ALERT_CLEAR_AFTER_MS)).toEqual({})
  })
  it('an infinite cooldown never escalates again', () => {
    const d = decideReauthAction(
      { isDeadToken: true, sessionAlive: true, isMain: false, canInteractiveLogin: false, prev: { consecutiveDead: 5, lastActionAtMs: t0 }, nowMs: t0 + 99 * 3_600_000 },
      { threshold: 3, cooldownMs: Number.POSITIVE_INFINITY },
    )
    expect(d.escalate).toBe(false)
    expect(decideReauthAction({ isDeadToken: true, sessionAlive: true, isMain: false, canInteractiveLogin: false, prev: NO_REAUTH_STATE, nowMs: t0 }, { threshold: 1, cooldownMs: 1 }).escalate).toBe(true)
  })
})
