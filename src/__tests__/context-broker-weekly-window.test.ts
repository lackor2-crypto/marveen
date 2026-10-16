// #569 in the context broker: a weekly window that is not spent yet neither blocks nor raises the percentage.
import { describe, it, expect, vi } from 'vitest'

const h = vi.hoisted(() => ({ snap: null as unknown, byAgent: {} as Record<string, unknown> }))
vi.mock('../web/rate-limit-status-io.js', () => ({ readRateLimitSnapshot: (a: string) => (a in h.byAgent ? h.byAgent[a] : h.snap) }))
vi.mock('../web/agent-process.js', async (orig) => ({ ...(await orig<typeof import('../web/agent-process.js')>()), sessionExistsOnHost: () => true }))

import { readBrokerCandidate } from '../web/context-broker-store.js'
import { resolveBroker, recipientAvailability, DEFAULT_BROKER_CONFIG } from '../context-broker.js'

const AHEAD = Date.now() + 3 * 24 * 3600_000
const win = (usedPct: number, resetsAt: number) => ({ usedPct, resetsAt })

describe('readBrokerCandidate weekly window', () => {
  it('a weekly 97% does not block and does not count', () => {
    h.snap = { updatedAt: Date.now(), fiveHour: win(20, Date.now() + 3600_000), sevenDay: win(97, AHEAD) }
    const c = readBrokerCandidate('x')
    expect(c.blockedUntil).toBeNull()
    expect(c.usedPct).toBe(20)
  })
  it('a spent weekly window blocks until its reset', () => {
    h.snap = { updatedAt: Date.now(), fiveHour: win(20, Date.now() + 3600_000), sevenDay: win(100, AHEAD) }
    const c = readBrokerCandidate('x')
    expect(c.blockedUntil).toBe(AHEAD)
    expect(c.usedPct).toBe(100)
  })
  it('the 5-hour window still blocks from 95%', () => {
    const r = Date.now() + 3600_000
    h.snap = { updatedAt: Date.now(), fiveHour: win(96, r), sevenDay: null }
    expect(readBrokerCandidate('x').blockedUntil).toBe(r)
  })
})

// The two readers of the same candidate that the first #569 fix did not measure: the role hand-over (resolveBroker)
// and the warning on a message to an unavailable recipient (recipientAvailability), from the snapshot file to the verdict.
describe('#569 end to end: role hand-over and message warning follow the weekly rule', () => {
  const soon = () => Date.now() + 3600_000
  const set = (main: unknown, other: unknown) => { h.byAgent = { main, other } }
  const candidates = () => [readBrokerCandidate('main'), readBrokerCandidate('other')]
  const cfg = { ...DEFAULT_BROKER_CONFIG, designated: 'main' }

  it('weekly 96% with a healthy 5-hour window: the designated agent keeps the role, a message to it carries no warning', () => {
    set(
      { updatedAt: Date.now(), fiveHour: win(29, soon()), sevenDay: win(96, AHEAD) },
      { updatedAt: Date.now(), fiveHour: win(5, soon()), sevenDay: win(5, AHEAD) },
    )
    expect(resolveBroker(cfg, candidates())).toMatchObject({ effective: 'main', reason: 'designated', steppedOver: null })
    expect(recipientAvailability('main', candidates())).toEqual({ ok: true })
  })
  it('weekly 100%: the role steps over to the stand-in and a message to it warns (quota) naming the stand-in', () => {
    set(
      { updatedAt: Date.now(), fiveHour: win(29, soon()), sevenDay: win(100, AHEAD) },
      { updatedAt: Date.now(), fiveHour: win(5, soon()), sevenDay: win(5, AHEAD) },
    )
    expect(resolveBroker(cfg, candidates())).toMatchObject({ effective: 'other', reason: 'fallback-quota', steppedOver: 'main' })
    expect(recipientAvailability('main', candidates())).toEqual({ ok: false, reason: 'quota', standIn: 'other' })
  })
  it('5-hour 96%: the role steps over as before (the 5-hour threshold is unchanged)', () => {
    set(
      { updatedAt: Date.now(), fiveHour: win(96, soon()), sevenDay: win(10, AHEAD) },
      { updatedAt: Date.now(), fiveHour: win(5, soon()), sevenDay: win(5, AHEAD) },
    )
    expect(resolveBroker(cfg, candidates())).toMatchObject({ effective: 'other', reason: 'fallback-quota' })
    expect(recipientAvailability('main', candidates())).toMatchObject({ ok: false, reason: 'quota' })
  })
  it('a stand-in with weekly 99% still counts as having headroom', () => {
    set(
      { updatedAt: Date.now(), fiveHour: win(96, soon()), sevenDay: win(10, AHEAD) },
      { updatedAt: Date.now(), fiveHour: win(5, soon()), sevenDay: win(99, AHEAD) },
    )
    expect(recipientAvailability('main', candidates())).toMatchObject({ ok: false, standIn: 'other' })
  })
})
