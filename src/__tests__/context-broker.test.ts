import { describe, it, expect } from 'vitest'
import {
  DEFAULT_BROKER_CONFIG,
  normalizeBrokerConfig,
  resolveBroker,
  type BrokerCandidate,
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
    expect(normalizeBrokerConfig({ designated: '  worker  ', updatedAt: NOW + 0.7 })).toEqual({
      designated: 'worker',
      updatedAt: NOW,
    })
  })

  it('drops a timestamp that is not a positive finite number', () => {
    for (const updatedAt of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '2026']) {
      expect(normalizeBrokerConfig({ designated: 'worker', updatedAt })).toEqual({
        designated: 'worker',
        updatedAt: null,
      })
    }
  })
})

describe('resolveBroker', () => {
  it('reports "unset" when nobody was designated, so callers prepare their own context', () => {
    const res = resolveBroker(DEFAULT_BROKER_CONFIG, [candidate('a'), candidate('b')], NOW)
    expect(res).toEqual({ designated: null, effective: null, reason: 'unset', steppedOver: null })
  })

  it('uses the designated agent while it is running and has allowance left', () => {
    const cfg = { designated: 'broker', updatedAt: NOW }
    const res = resolveBroker(cfg, [candidate('broker', { usedPct: CAUTION_THRESHOLD_PCT }), candidate('other')], NOW)
    expect(res.effective).toBe('broker')
    expect(res.reason).toBe('designated')
    expect(res.steppedOver).toBeNull()
  })

  it('hands over while the designated agent is stopped, naming who stepped in', () => {
    const cfg = { designated: 'broker', updatedAt: NOW }
    const res = resolveBroker(cfg, [candidate('broker', { running: false }), candidate('other')], NOW)
    expect(res).toEqual({
      designated: 'broker',
      effective: 'other',
      reason: 'fallback-stopped',
      steppedOver: 'broker',
    })
  })

  it('treats an agent the fleet has never heard of as stopped', () => {
    const cfg = { designated: 'ghost', updatedAt: NOW }
    const res = resolveBroker(cfg, [candidate('other')], NOW)
    expect(res.effective).toBe('other')
    expect(res.reason).toBe('fallback-stopped')
  })

  it('hands over when the designated agent is out of allowance', () => {
    const cfg = { designated: 'broker', updatedAt: NOW }
    const res = resolveBroker(cfg, [candidate('broker', { usedPct: CRITICAL_THRESHOLD_PCT }), candidate('other')], NOW)
    expect(res).toEqual({
      designated: 'broker',
      effective: 'other',
      reason: 'fallback-quota',
      steppedOver: 'broker',
    })
  })

  it('ignores a stale usage reading rather than benching an agent on old numbers', () => {
    const cfg = { designated: 'broker', updatedAt: NOW }
    const stale = candidate('broker', { usedPct: 99, usageAt: NOW - STALE_AFTER_MS - 1 })
    expect(resolveBroker(cfg, [stale, candidate('other')], NOW).effective).toBe('broker')
  })

  it('picks the stand-in with the most allowance left, ties broken by name', () => {
    const cfg = { designated: 'broker', updatedAt: NOW }
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
    const cfg = { designated: 'broker', updatedAt: NOW }
    const res = resolveBroker(
      cfg,
      [candidate('broker', { running: false }), candidate('quiet', { usedPct: null, usageAt: null }), candidate('busy', { usedPct: 40 })],
      NOW,
    )
    expect(res.effective).toBe('quiet')
  })

  it('never hands the job to a stopped or critical stand-in', () => {
    const cfg = { designated: 'broker', updatedAt: NOW }
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
    const cfg = { designated: 'broker', updatedAt: NOW }
    const res = resolveBroker(cfg, [candidate('broker', { running: false }), candidate('down', { running: false })], NOW)
    expect(res).toEqual({
      designated: 'broker',
      effective: null,
      reason: 'unavailable',
      steppedOver: 'broker',
    })
  })

  it('takes the job back on its own once the designated agent is usable again', () => {
    const cfg = { designated: 'broker', updatedAt: NOW }
    const away = resolveBroker(cfg, [candidate('broker', { running: false }), candidate('other')], NOW)
    const back = resolveBroker(cfg, [candidate('broker'), candidate('other')], NOW)
    expect(away.effective).toBe('other')
    expect(back.effective).toBe('broker')
    expect(back.reason).toBe('designated')
  })
})
