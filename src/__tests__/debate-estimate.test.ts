// The cost estimate of a debate round (#597, phase 4): pure arithmetic over list prices.
import { describe, it, expect } from 'vitest'
import { approxTokens, estimateCalls, DEFAULT_OUT_TOKENS, type ModelPrice } from '../debate-estimate.js'

const prices = new Map<string, ModelPrice>([
  ['openai/gpt-5.5', { promptPrice: 2, completionPrice: 10 }],
  ['deepseek/deepseek-v4', { promptPrice: 0, completionPrice: 0 }],
])

describe('koltsegbecsles', () => {
  it('a token a karakterszam ~3,5-ede, felfele kerekitve', () => {
    expect(approxTokens(0)).toBe(0)
    expect(approxTokens(7)).toBe(2)
    expect(approxTokens(8)).toBe(3)
  })

  it('bemenet a kuldott szovegbol, kimenet a lathatott atlagbol (vagy az alapbecslesbol), ar a katalogus szerint', () => {
    const e = estimateCalls([{ model: 'openai/gpt-5.5', chars: 35_000, seenOut: null }, { model: 'openai/gpt-5.5', chars: 7_000, seenOut: 500 }], prices)
    expect(e.calls[0]).toMatchObject({ tokensIn: 10_000, tokensOut: DEFAULT_OUT_TOKENS })
    expect(e.calls[1]).toMatchObject({ tokensIn: 2_000, tokensOut: 500 })
    // 10k*2 + 1.8k*10 = 38 000 ; 2k*2 + 0.5k*10 = 9 000 (USD / 1M)
    expect(e.calls[0].usd).toBeCloseTo(0.038, 6)
    expect(e.calls[1].usd).toBeCloseTo(0.009, 6)
    expect(e.usd).toBeCloseTo(0.047, 6)
    expect(e.free).toBe(false)
    expect(e.unpriced).toEqual([])
  })

  it('ingyenes modell nulla; ha minden ingyenes, az egesz ingyenes', () => {
    const e = estimateCalls([{ model: 'deepseek/deepseek-v4', chars: 10_000, seenOut: null }], prices)
    expect(e.usd).toBe(0)
    expect(e.free).toBe(true)
  })

  it('ismeretlen arat NEM szamit ingyenesnek: megnevezi, es az osszeg nem tartalmazza', () => {
    const e = estimateCalls([{ model: 'openai/gpt-5.5', chars: 3_500, seenOut: 100 }, { model: 'ismeretlen/x', chars: 3_500, seenOut: 100 }], prices)
    expect(e.unpriced).toEqual(['ismeretlen/x'])
    expect(e.calls[1].usd).toBeNull()
    expect(e.free).toBe(false)
    expect(e.usd).toBeCloseTo(0.003, 6)
  })

  it('a :online modell ara a bazismodellé, a keresés külön díjára figyelmeztet', () => {
    const e = estimateCalls([{ model: 'openai/gpt-5.5:online', chars: 3_500, seenOut: 100 }], prices)
    expect(e.calls[0].usd).not.toBeNull()
    expect(e.webSearch).toEqual(['openai/gpt-5.5:online'])
  })

  it('katalogus nelkul (ures terkep) minden modell ismeretlen ar, semmi nem hamis nulla', () => {
    const e = estimateCalls([{ model: 'openai/gpt-5.5', chars: 100, seenOut: null }], new Map())
    expect(e.unpriced).toEqual(['openai/gpt-5.5'])
    expect(e.free).toBe(false)
    expect(estimateCalls([], prices).free).toBe(false)
  })
})
