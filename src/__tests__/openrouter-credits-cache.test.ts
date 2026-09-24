import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fetchOpenRouterCredits, resetOpenRouterCreditsCacheForTest } from '../web/routes/openrouter-overview.js'

// #377: the Overview used to hit OpenRouter live on every load.
describe('fetchOpenRouterCredits cache', () => {
  const body = { data: { total_credits: 10, total_usage: 4 } }
  let calls = 0
  beforeEach(() => {
    calls = 0
    resetOpenRouterCreditsCacheForTest()
    vi.stubGlobal('fetch', vi.fn(async () => { calls++; return new Response(JSON.stringify(body), { status: 200 }) }))
  })
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

  it('answers repeat calls from the cache inside the TTL', async () => {
    expect(await fetchOpenRouterCredits('k')).toEqual({ totalCredits: 10, totalUsage: 4 })
    expect(await fetchOpenRouterCredits('k')).toEqual({ totalCredits: 10, totalUsage: 4 })
    expect(calls).toBe(1)
  })

  it('serves the stale value immediately and refreshes in the background', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    await fetchOpenRouterCredits('k')
    vi.setSystemTime(Date.now() + 61_000)
    body.data.total_credits = 20
    expect((await fetchOpenRouterCredits('k'))?.totalCredits).toBe(10)
    await new Promise(r => setImmediate(r))
    await new Promise(r => setImmediate(r))
    expect(calls).toBe(2)
    expect((await fetchOpenRouterCredits('k'))?.totalCredits).toBe(20)
  })

  it('passes a timeout signal to fetch', async () => {
    await fetchOpenRouterCredits('k2')
    const init = (fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0][1]
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })
})
