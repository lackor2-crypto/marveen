// A legokosabb ELO, token-nel biro agens kivalasztasa.
//
// Boss szabalya (2026-09-18): "ne a haikut valaszsza, hanem inkabb az opus
// 5-ost ha van, meg akarmelyik modellnel is mindig a legmagasabb verzioju
// modellt". Ezt a rangsort es a "van-e tokenje" dontest rogzitjuk itt.
import { describe, it, expect } from 'vitest'
import { rankModelTier, workerHasToken, pickSmartestWorker, type WorkerCandidate } from '../web/smartest-worker.js'
import { CRITICAL_THRESHOLD_PCT, STALE_AFTER_MS } from '../rate-limit-status.js'

describe('rankModelTier', () => {
  it('Opus > Sonnet > Haiku, es a magasabb verzio nyer', () => {
    expect(rankModelTier('claude-opus-5')).toBeGreaterThan(rankModelTier('claude-opus-4-8'))
    expect(rankModelTier('claude-opus-4-8')).toBeGreaterThan(rankModelTier('claude-sonnet-5'))
    expect(rankModelTier('claude-sonnet-5')).toBeGreaterThan(rankModelTier('claude-haiku-4-5-20251001'))
  })

  it('minden Claude-szint a nem-Claude (ingyenes/egyeb) modellek fole kerul', () => {
    const freeMax = Math.max(
      rankModelTier('poolside/laguna-s-2.1:free'),
      rankModelTier('nvidia/nemotron-3-ultra-550b-a55b:free'),
      rankModelTier('z-ai/glm-5v-turbo'),
    )
    expect(rankModelTier('claude-haiku-4-5-20251001')).toBeGreaterThan(freeMax)
  })

  it('a nem-Claude modellek kozt is a magasabb verzio nyer', () => {
    expect(rankModelTier('z-ai/glm-5v-turbo')).toBeGreaterThan(rankModelTier('nvidia/nemotron-3-super-120b-a12b:free'))
  })

  it('az ismeretlen/ures modell nem szall el, csak a legkisebb szint', () => {
    expect(rankModelTier('')).toBe(100)
    expect(Number.isFinite(rankModelTier('valami-ismeretlen'))).toBe(true)
  })
})

const NOW = 1_000_000_000_000

function cand(over: Partial<WorkerCandidate>): WorkerCandidate {
  return { agent: 'x', model: 'claude-opus-5', running: true, fiveHourPct: 10, usageAt: NOW, ...over }
}

describe('workerHasToken', () => {
  it('nem futo agens sose vallalhat munkat', () => {
    expect(workerHasToken(cand({ running: false }), NOW)).toBe(false)
  })

  it('ismeretlen keret (null) eseten bizalom -> vallalhat', () => {
    expect(workerHasToken(cand({ fiveHourPct: null, usageAt: null }), NOW)).toBe(true)
  })

  it('kritikus 5 oras keretnel NEM vallalhat', () => {
    expect(workerHasToken(cand({ fiveHourPct: CRITICAL_THRESHOLD_PCT + 1 }), NOW)).toBe(false)
  })

  it('elavult (regi) meres eseten a szazalek nem szamit -> vallalhat', () => {
    expect(workerHasToken(cand({ fiveHourPct: 99, usageAt: NOW - STALE_AFTER_MS - 1 }), NOW)).toBe(true)
  })
})

describe('pickSmartestWorker', () => {
  it('a legokosabb ELO agenst valasztja (Opus 5 a Haiku helyett)', () => {
    const pick = pickSmartestWorker([
      cand({ agent: 'main', model: 'claude-haiku-4-5-20251001', fiveHourPct: 1 }),
      cand({ agent: 'usalackor', model: 'claude-opus-5', fiveHourPct: 55 }),
    ], NOW)
    expect(pick?.agent).toBe('usalackor')
  })

  it('a kritikus/leallt agenseket kihagyja, meg ha okosabbak is', () => {
    const pick = pickSmartestWorker([
      cand({ agent: 'usalackor', model: 'claude-opus-5', running: false }),
      cand({ agent: 'lackor3', model: 'claude-opus-4-8', fiveHourPct: 99, usageAt: NOW }),
      cand({ agent: 'lagunas', model: 'poolside/laguna-s-2.1:free', fiveHourPct: 5 }),
    ], NOW)
    // usalackor leallt, lackor3 kritikus keretu -> a laguna marad, brmilyen gyenge is.
    expect(pick?.agent).toBe('lagunas')
  })

  it('azonos okossagnal a tobb szabad kerettel biro nyer', () => {
    const pick = pickSmartestWorker([
      cand({ agent: 'a', model: 'claude-opus-5', fiveHourPct: 70 }),
      cand({ agent: 'b', model: 'claude-opus-5', fiveHourPct: 20 }),
    ], NOW)
    expect(pick?.agent).toBe('b')
  })

  it('null, ha egy agens sem tud most dolgozni', () => {
    expect(pickSmartestWorker([cand({ running: false })], NOW)).toBeNull()
    expect(pickSmartestWorker([], NOW)).toBeNull()
  })
})
