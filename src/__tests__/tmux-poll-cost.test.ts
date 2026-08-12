// Boss reported the dashboard as frozen (2026-08-12). The VM running out of
// memory was the headline cause, but a second, independent one survived it: the
// status endpoints do their tmux work synchronously, on the same event loop that
// answers HTTP. Measured on this install with a single agent running,
// /api/agents/activity cost 131 ms median per poll -- every 3 seconds -- and the
// trivial /api/schedules next to it spiked to 232 ms because the loop was busy.
//
// Two caches remove that cost. This file pins their contracts, because both can
// fail in a way that looks fine on screen: a stale session list would report a
// dead agent as running, and a background refresh that never lands would freeze
// the pane text at whatever it said an hour ago.
import { describe, it, expect } from 'vitest'
import { SessionListCache } from '../web/tmux-session-cache.js'
import { BackgroundCache } from '../web/remote-status-cache.js'

describe('SessionListCache', () => {
  it('asks tmux once per window however many agents ask', () => {
    const cache = new SessionListCache(1500)
    let calls = 0
    const fetch = () => { calls++; return 'agent-a\nagent-b' }
    // 14 agents resolving their run state inside one request.
    for (let i = 0; i < 14; i++) cache.get(1000, fetch)
    expect(calls).toBe(1)
  })

  it('refetches once the window has passed', () => {
    const cache = new SessionListCache(1500)
    let calls = 0
    const fetch = () => { calls++; return 'agent-a' }
    cache.get(1000, fetch)
    cache.get(2400, fetch)   // still inside the window
    expect(calls).toBe(1)
    cache.get(2600, fetch)   // 1600 ms later
    expect(calls).toBe(2)
  })

  it('serves the truth immediately after a start or stop, not the stale window', () => {
    const cache = new SessionListCache(1500)
    const before = () => 'agent-a\nagent-b'
    const after = () => 'agent-a'
    expect(cache.get(1000, before)).toContain('agent-b')
    // stopAgentProcess -> runTmux(kill-session) -> invalidate
    cache.invalidate()
    expect(cache.get(1001, after)).not.toContain('agent-b')
  })

  it('does not cache a failure -- "no server running" must not stick for a window', () => {
    const cache = new SessionListCache(1500)
    let calls = 0
    expect(() => cache.get(1000, () => { calls++; throw new Error('no server running') })).toThrow()
    // The fleet comes back 10 ms later; the very next call must see it.
    expect(cache.get(1010, () => { calls++; return 'agent-a' })).toBe('agent-a')
    expect(calls).toBe(2)
  })
})

describe('BackgroundCache', () => {
  const tick = () => new Promise((r) => setTimeout(r, 5))

  it('pays a synchronous fetch only for the very first call', async () => {
    const cache = new BackgroundCache<string>(50)
    let cold = 0, warm = 0
    const get = (now: number) => cache.get(
      'a', now,
      async () => { warm++; return 'fresh' },
      () => { cold++; return 'cold' },
    )
    expect(get(0)).toBe('cold')
    expect(get(10)).toBe('cold')     // inside TTL: no work at all
    expect(cold).toBe(1)
    expect(warm).toBe(0)
  })

  it('serves the previous value instantly and replaces it off the request path', async () => {
    const cache = new BackgroundCache<string>(50)
    const get = (now: number) => cache.get(
      'a', now,
      async () => 'fresh',
      () => 'cold',
    )
    expect(get(0)).toBe('cold')
    expect(get(100)).toBe('cold')    // stale: answered NOW, refresh kicked
    await tick()
    expect(get(200)).toBe('fresh')
  })

  it('keeps the last known value when a refresh fails', async () => {
    const cache = new BackgroundCache<string>(50)
    const get = (now: number) => cache.get(
      'a', now,
      async () => { throw new Error('tmux gone') },
      () => 'cold',
    )
    expect(get(0)).toBe('cold')
    expect(get(100)).toBe('cold')
    await tick()
    expect(get(200)).toBe('cold')
  })

  it('does not pile up refreshes while one is in flight', async () => {
    const cache = new BackgroundCache<string>(50)
    let started = 0
    const get = (now: number) => cache.get(
      'a', now,
      async () => { started++; await tick(); return 'fresh' },
      () => 'cold',
    )
    get(0)
    for (let i = 0; i < 10; i++) get(100 + i)
    expect(started).toBe(1)
    await tick(); await tick()
    expect(get(500)).toBe('fresh')
  })

  it('keeps keys apart', async () => {
    const cache = new BackgroundCache<string>(50)
    expect(cache.get('a', 0, async () => 'x', () => 'cold-a')).toBe('cold-a')
    expect(cache.get('b', 0, async () => 'x', () => 'cold-b')).toBe('cold-b')
  })
})
