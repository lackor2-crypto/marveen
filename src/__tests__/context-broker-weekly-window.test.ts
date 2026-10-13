// #569 in the context broker: a weekly window that is not spent yet neither blocks nor raises the percentage.
import { describe, it, expect, vi } from 'vitest'

const h = vi.hoisted(() => ({ snap: null as unknown }))
vi.mock('../web/rate-limit-status-io.js', () => ({ readRateLimitSnapshot: () => h.snap }))
vi.mock('../web/agent-process.js', async (orig) => ({ ...(await orig<typeof import('../web/agent-process.js')>()), sessionExistsOnHost: () => true }))

import { readBrokerCandidate } from '../web/context-broker-store.js'

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
