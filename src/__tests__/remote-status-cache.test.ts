import { describe, it, expect, vi } from 'vitest'
import { RemoteStatusCache, BackgroundCache } from '../web/remote-status-cache.js'

describe('RemoteStatusCache', () => {
  it('calls the fetcher on a cold miss and caches the value', () => {
    const cache = new RemoteStatusCache<string>(3000)
    const fetch = vi.fn(() => 'running')
    expect(cache.getOrRefresh('a', 1000, fetch)).toBe('running')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('returns the cached value WITHOUT calling the fetcher again within the TTL', () => {
    const cache = new RemoteStatusCache<string>(3000)
    const fetch = vi.fn(() => 'running')
    cache.getOrRefresh('a', 1000, fetch)
    // 2.9s later -> still fresh -> no second ssh call (dashboard never blocks)
    expect(cache.getOrRefresh('a', 3900, fetch)).toBe('running')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('refreshes once the TTL has elapsed', () => {
    const cache = new RemoteStatusCache<string>(3000)
    let n = 0
    const fetch = vi.fn(() => `v${++n}`)
    expect(cache.getOrRefresh('a', 1000, fetch)).toBe('v1')
    expect(cache.getOrRefresh('a', 4001, fetch)).toBe('v2') // 3.001s later -> stale
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('keys are independent', () => {
    const cache = new RemoteStatusCache<string>(3000)
    const fetch = vi.fn((k: string) => k)
    expect(cache.getOrRefresh('a', 1000, () => fetch('a'))).toBe('a')
    expect(cache.getOrRefresh('b', 1000, () => fetch('b'))).toBe('b')
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('does not let a fetcher throw escape -- returns last-known on error, or the fallback when cold', () => {
    const cache = new RemoteStatusCache<string>(3000)
    // cold + throwing fetch -> fallback
    const boom = () => { throw new Error('ssh down') }
    expect(cache.getOrRefresh('a', 1000, boom, 'unreachable')).toBe('unreachable')
    // warm it, then a later throwing refresh returns the last-known value
    cache.getOrRefresh('a', 5000, () => 'running')
    expect(cache.getOrRefresh('a', 9001, boom, 'unreachable')).toBe('running')
  })
})

// #377: /api/agents reuses the activity poll's pane capture, but only while it
// is fresh -- a hidden dashboard stops that poll, and an hours-old pane must
// not decide the reauth badge.
describe('BackgroundCache.getWithin', () => {
  it('reuses a young entry and re-fetches an old one synchronously', () => {
    const c = new BackgroundCache<string>(2500)
    let n = 0
    const fetchNow = () => `v${++n}`
    expect(c.getWithin('a', 1000, 5000, fetchNow)).toBe('v1')
    expect(c.getWithin('a', 5999, 5000, fetchNow)).toBe('v1')
    expect(c.getWithin('a', 6000, 5000, fetchNow)).toBe('v2')
    expect(n).toBe(2)
  })

  it('a throwing fetch stores undefined instead of propagating', () => {
    const c = new BackgroundCache<string | null>(2500)
    expect(c.getWithin('b', 0, 5000, () => { throw new Error('tmux gone') })).toBeUndefined()
  })
})
