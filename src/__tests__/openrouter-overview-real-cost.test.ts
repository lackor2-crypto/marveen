import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchRealDailyCostUSD } from '../web/routes/openrouter-overview.js'

// Regression guard (2026-08-08): the OpenRouter overview page used to derive
// its headline "today's cost" from local token_usage counts times catalog
// pricing. Boss caught that understating real spend by ~10x ($0.84 shown vs
// $7.81 actual OpenRouter account usage) after a round of Gypsy usage in
// "high effort"/reasoning mode -- OpenRouter's Anthropic-compatible endpoint
// does not surface reasoning/thinking tokens in the translated usage object
// Claude Code logs, so any price-per-token estimate built from that count
// silently misses what OpenRouter actually bills. fetchRealDailyCostUSD()
// reads GET /v1/key's own usage_daily field instead -- OpenRouter's own
// account ledger, not derivable from anything local.
describe('fetchRealDailyCostUSD (OpenRouter account is the cost source of truth)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns usage_daily from a successful /v1/key response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: { usage_daily: 7.8062299 } }),
    })))
    const cost = await fetchRealDailyCostUSD('sk-or-v1-test')
    expect(cost).toBe(7.8062299)
  })

  it('returns null (not 0, not a stale estimate) when the API call fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({}) })))
    const cost = await fetchRealDailyCostUSD('sk-or-v1-test')
    expect(cost).toBeNull()
  })

  it('returns null when fetch itself throws (network error)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down') }))
    const cost = await fetchRealDailyCostUSD('sk-or-v1-test')
    expect(cost).toBeNull()
  })

  it('returns null when usage_daily is missing or not a number', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ data: {} }) })))
    expect(await fetchRealDailyCostUSD('sk-or-v1-test')).toBeNull()

    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ data: { usage_daily: 'oops' } }) })))
    expect(await fetchRealDailyCostUSD('sk-or-v1-test')).toBeNull()
  })

  it('calls the real OpenRouter key endpoint with the bearer token', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ data: { usage_daily: 1 } }) }))
    vi.stubGlobal('fetch', fetchMock)
    await fetchRealDailyCostUSD('sk-or-v1-abc123')
    expect(fetchMock).toHaveBeenCalledWith(
      'https://openrouter.ai/api/v1/key',
      { headers: { Authorization: 'Bearer sk-or-v1-abc123' } },
    )
  })
})
