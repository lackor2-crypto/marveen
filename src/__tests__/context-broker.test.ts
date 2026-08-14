import { describe, it, expect } from 'vitest'
import {
  DEFAULT_BROKER_CONFIG,
  normalizeBrokerConfig,
  resolveBroker,
  type BrokerCandidate,
  assignRole,
  rolesOf,
  EMPTY_ROLES,
} from '../context-broker.js'
import { CAUTION_THRESHOLD_PCT, CRITICAL_THRESHOLD_PCT, STALE_AFTER_MS } from '../rate-limit-status.js'

const NOW = 1_700_000_000_000

function candidate(agent: string, over: Partial<BrokerCandidate> = {}): BrokerCandidate {
  return { agent, running: true, usedPct: 10, usageAt: NOW, ...over }
}

describe('normalizeBrokerConfig', () => {
  it('turns anything unusable into "nobody designated"', () => {
    for (const raw of [null, undefined, 42, 'agent', [], { designated: 7 }, { designated: '   ' }]) {
      expect(normalizeBrokerConfig(raw)).toEqual(DEFAULT_BROKER_CONFIG)
    }
  })

  it('keeps a trimmed name and a plausible timestamp', () => {
    expect(normalizeBrokerConfig({ ...DEFAULT_BROKER_CONFIG, designated: '  worker  ', updatedAt: NOW + 0.7 })).toEqual({
      ...DEFAULT_BROKER_CONFIG,
      designated: 'worker',
      updatedAt: NOW,
    })
  })

  it('drops a timestamp that is not a positive finite number', () => {
    for (const updatedAt of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '2026']) {
      expect(normalizeBrokerConfig({ designated: 'worker', updatedAt })).toEqual({
        ...DEFAULT_BROKER_CONFIG,
        designated: 'worker',
        updatedAt: null,
      })
    }
  })
})

describe('roles on the cards', () => {
  // Boss, 2026-08-14: "a kartyan van jelolonegyzet amin ki lehet jelolni hogy
  // ki legyen kicsoda. az hogy a kartya alatt milyen model van az ne
  // szamitson." These tests exist to keep that true -- nothing below consults a
  // model name, and nothing may start to.
  it('starts with nobody holding a role, which is a working state', () => {
    expect(DEFAULT_BROKER_CONFIG.roles).toEqual({ planner: null, implementer: null, checker: null })
    expect(rolesOf(DEFAULT_BROKER_CONFIG.roles, 'anyone')).toEqual([])
  })

  it('gives a role to an agent', () => {
    const roles = assignRole(EMPTY_ROLES, 'planner', 'gemma')
    expect(roles.planner).toBe('gemma')
    expect(rolesOf(roles, 'gemma')).toEqual(['planner'])
  })

  it('moves a role rather than duplicating it: ticking it elsewhere unticks it here', () => {
    // Exclusivity has to hold in the DATA, not in the UI clearing checkboxes --
    // a second browser tab would not know to clear anything.
    const first = assignRole(EMPTY_ROLES, 'planner', 'gemma')
    const second = assignRole(first, 'planner', 'ling')
    expect(second.planner).toBe('ling')
    expect(rolesOf(second, 'gemma')).toEqual([])
  })

  it('lets one agent hold several roles', () => {
    let roles = assignRole(EMPTY_ROLES, 'planner', 'solo')
    roles = assignRole(roles, 'checker', 'solo')
    expect(rolesOf(roles, 'solo')).toEqual(['planner', 'checker'])
  })

  it('clears a role with null, back to "the generator decides per task"', () => {
    const roles = assignRole(assignRole(EMPTY_ROLES, 'checker', 'ling'), 'checker', null)
    expect(roles.checker).toBeNull()
  })

  it('accepts any agent id, whatever model is behind the card', () => {
    // The point of the checkbox: a free Gemma card can be the planner and a
    // Claude card the checker. A rule that ranked models would break this, and
    // would need editing every time a provider is added.
    for (const agent of ['gemma', 'gypsy', 'nemotronultra', 'lackor2-bot']) {
      expect(assignRole(EMPTY_ROLES, 'planner', agent).planner).toBe(agent)
    }
  })

  it('survives a config file written before roles existed', () => {
    const cfg = normalizeBrokerConfig({ designated: 'worker', updatedAt: NOW })
    expect(cfg.roles).toEqual(EMPTY_ROLES)
  })

  it('ignores junk in the roles map instead of storing it', () => {
    const cfg = normalizeBrokerConfig({ roles: { planner: 42, implementer: '  ', checker: 'ok', bogus: 'x' } })
    expect(cfg.roles).toEqual({ planner: null, implementer: null, checker: 'ok' })
    expect('bogus' in cfg.roles).toBe(false)
  })
})

describe('resolveBroker', () => {
  it('reports "unset" when nobody was designated, so callers prepare their own context', () => {
    const res = resolveBroker(DEFAULT_BROKER_CONFIG, [candidate('a'), candidate('b')], NOW)
    expect(res).toEqual({ designated: null, effective: null, reason: 'unset', steppedOver: null })
  })

  it('uses the designated agent while it is running and has allowance left', () => {
    const cfg = { ...DEFAULT_BROKER_CONFIG, designated: 'broker', updatedAt: NOW }
    const res = resolveBroker(cfg, [candidate('broker', { usedPct: CAUTION_THRESHOLD_PCT }), candidate('other')], NOW)
    expect(res.effective).toBe('broker')
    expect(res.reason).toBe('designated')
    expect(res.steppedOver).toBeNull()
  })

  it('hands over while the designated agent is stopped, naming who stepped in', () => {
    const cfg = { ...DEFAULT_BROKER_CONFIG, designated: 'broker', updatedAt: NOW }
    const res = resolveBroker(cfg, [candidate('broker', { running: false }), candidate('other')], NOW)
    expect(res).toEqual({
      designated: 'broker',
      effective: 'other',
      reason: 'fallback-stopped',
      steppedOver: 'broker',
    })
  })

  it('treats an agent the fleet has never heard of as stopped', () => {
    const cfg = { ...DEFAULT_BROKER_CONFIG, designated: 'ghost', updatedAt: NOW }
    const res = resolveBroker(cfg, [candidate('other')], NOW)
    expect(res.effective).toBe('other')
    expect(res.reason).toBe('fallback-stopped')
  })

  it('hands over when the designated agent is out of allowance', () => {
    const cfg = { ...DEFAULT_BROKER_CONFIG, designated: 'broker', updatedAt: NOW }
    const res = resolveBroker(cfg, [candidate('broker', { usedPct: CRITICAL_THRESHOLD_PCT }), candidate('other')], NOW)
    expect(res).toEqual({
      designated: 'broker',
      effective: 'other',
      reason: 'fallback-quota',
      steppedOver: 'broker',
    })
  })

  it('ignores a stale usage reading rather than benching an agent on old numbers', () => {
    const cfg = { ...DEFAULT_BROKER_CONFIG, designated: 'broker', updatedAt: NOW }
    const stale = candidate('broker', { usedPct: 99, usageAt: NOW - STALE_AFTER_MS - 1 })
    expect(resolveBroker(cfg, [stale, candidate('other')], NOW).effective).toBe('broker')
  })

  it('picks the stand-in with the most allowance left, ties broken by name', () => {
    const cfg = { ...DEFAULT_BROKER_CONFIG, designated: 'broker', updatedAt: NOW }
    const res = resolveBroker(
      cfg,
      [
        candidate('broker', { running: false }),
        candidate('busy', { usedPct: 80 }),
        candidate('zeta', { usedPct: 5 }),
        candidate('alpha', { usedPct: 5 }),
      ],
      NOW,
    )
    expect(res.effective).toBe('alpha')
  })

  it('prefers a candidate with no usage reading over a heavily used one', () => {
    const cfg = { ...DEFAULT_BROKER_CONFIG, designated: 'broker', updatedAt: NOW }
    const res = resolveBroker(
      cfg,
      [candidate('broker', { running: false }), candidate('quiet', { usedPct: null, usageAt: null }), candidate('busy', { usedPct: 40 })],
      NOW,
    )
    expect(res.effective).toBe('quiet')
  })

  it('never hands the job to a stopped or critical stand-in', () => {
    const cfg = { ...DEFAULT_BROKER_CONFIG, designated: 'broker', updatedAt: NOW }
    const res = resolveBroker(
      cfg,
      [
        candidate('broker', { running: false }),
        candidate('down', { running: false, usedPct: 0 }),
        candidate('spent', { usedPct: 100 }),
        candidate('ok', { usedPct: 70 }),
      ],
      NOW,
    )
    expect(res.effective).toBe('ok')
  })

  it('reports "unavailable" when nobody can take over, so the fleet falls back to self-service', () => {
    const cfg = { ...DEFAULT_BROKER_CONFIG, designated: 'broker', updatedAt: NOW }
    const res = resolveBroker(cfg, [candidate('broker', { running: false }), candidate('down', { running: false })], NOW)
    expect(res).toEqual({
      designated: 'broker',
      effective: null,
      reason: 'unavailable',
      steppedOver: 'broker',
    })
  })

  it('takes the job back on its own once the designated agent is usable again', () => {
    const cfg = { ...DEFAULT_BROKER_CONFIG, designated: 'broker', updatedAt: NOW }
    const away = resolveBroker(cfg, [candidate('broker', { running: false }), candidate('other')], NOW)
    const back = resolveBroker(cfg, [candidate('broker'), candidate('other')], NOW)
    expect(away.effective).toBe('other')
    expect(back.effective).toBe('broker')
    expect(back.reason).toBe('designated')
  })
})
