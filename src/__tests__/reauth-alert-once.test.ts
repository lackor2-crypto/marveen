import { describe, it, expect } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../config.js'
import {
  nextAlerted, ALERT_CLEAR_AFTER_MS, decideReauthAction, NO_REAUTH_STATE, ESCALATION_COOLDOWN_MS,
  isHealthyProbe, readAlertedFrom, writeAlertedTo,
} from '../web/reauth-healer.js'

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

// Follow-up findings on #815: alert-once must not switch the self-heal retries off.
describe('alert-once vs self-heal cadence', () => {
  const t0 = 5_000_000
  const dead = { isDeadToken: true, sessionAlive: true, isMain: true, canInteractiveLogin: false }
  it('a still-dead main agent re-fires its heal (restart + quarantine probe) after the normal cooldown', () => {
    const first = decideReauthAction({ ...dead, prev: { consecutiveDead: 2, lastActionAtMs: null }, nowMs: t0 }, { threshold: 3, cooldownMs: ESCALATION_COOLDOWN_MS })
    expect(first.restartMain).toBe(true)
    const early = decideReauthAction({ ...dead, prev: first.next, nowMs: t0 + ESCALATION_COOLDOWN_MS - 1 }, { threshold: 3, cooldownMs: ESCALATION_COOLDOWN_MS })
    expect(early.escalate).toBe(false)
    const later = decideReauthAction({ ...dead, prev: first.next, nowMs: t0 + ESCALATION_COOLDOWN_MS }, { threshold: 3, cooldownMs: ESCALATION_COOLDOWN_MS })
    expect(later.escalate).toBe(true)
    expect(later.restartMain).toBe(true)
  })
  it('checkSession never passes an infinite cooldown to the decision', () => {
    const src = readFileSync(join(PROJECT_ROOT, 'src/web/reauth-healer.ts'), 'utf-8')
    const check = src.slice(src.indexOf('function checkSession('), src.indexOf('async function restartFirstRunGatedAgent'))
    expect(check).not.toContain('POSITIVE_INFINITY')
  })
  it('a missing session is not a healthy probe (restart gap must not run the clear-clock)', () => {
    expect(isHealthyProbe(false, true)).toBe(true)
    expect(isHealthyProbe(false, false)).toBe(false)
    expect(isHealthyProbe(true, true)).toBe(false)
    const base = { a: { alertedAtMs: 5_000_000, lastDeadAtMs: 5_000_000 } }
    const gap = nextAlerted(base, 'a', !isHealthyProbe(false, false), 5_000_000 + ALERT_CLEAR_AFTER_MS + 1)
    expect(gap.a).toBeDefined()
  })
})

describe('alerted file persistence', () => {
  it('survives a round trip, leaves no temp file, and reads a corrupt file as empty', () => {
    const dir = mkdtempSync(join(tmpdir(), 'reauth-alerted-'))
    try {
      const f = join(dir, 'reauth-alerted.json')
      const m = { a: { alertedAtMs: 1, lastDeadAtMs: 2 } }
      expect(readAlertedFrom(f)).toEqual({})
      writeAlertedTo(f, m)
      expect(readAlertedFrom(f)).toEqual(m)
      expect(readdirSync(dir)).toEqual(['reauth-alerted.json'])
      writeFileSync(f, '{torn')
      expect(readAlertedFrom(f)).toEqual({})
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
