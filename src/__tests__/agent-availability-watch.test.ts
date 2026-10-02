// #463: the watcher's tick against a throwaway store -- what it writes, whom it
// tells, and that a message it could not send is tried again.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = mkdtempSync(join(tmpdir(), 'marveen-availability-'))
const NOW = 1_800_000_000_000
const RESET = NOW + 3 * 24 * 3600_000

const h = vi.hoisted(() => ({
  sent: [] as { from: string; to: string; content: string }[],
  sendFails: false,
  waiting: 0,
  running: true,
  usageAt: 0,
  cards: [] as { seq: number; id: string; title: string; status: string }[],
  unreadable: false,
  taskStateAsked: null as boolean | null,
}))

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return { ...actual, STORE_DIR: store }
})
vi.mock('../db.js', () => ({
  createAgentMessage: (from: string, to: string, content: string) => {
    if (h.sendFails) throw new Error('database is locked')
    h.sent.push({ from, to, content })
    return { id: h.sent.length }
  },
  getPendingMessages: () => Array.from({ length: h.waiting }, (_, i) => ({ id: i })),
}))
vi.mock('../web/context-broker-store.js', () => ({
  listBrokerCandidateNames: () => ['worker'],
  readBrokerCandidate: (agent: string) => ({ agent, running: h.running, usedPct: 100, usageAt: h.usageAt }),
}))
vi.mock('../web/rate-limit-status-io.js', () => ({
  readRateLimitSnapshot: () => ({
    fiveHour: { usedPct: 3, resetsAt: NOW + 3600_000 },
    sevenDay: { usedPct: 100, resetsAt: RESET },
    updatedAt: h.usageAt,
  }),
}))
vi.mock('../web/pending-work.js', () => ({
  defaultPendingWorkDeps: { hasActiveTaskState: () => true },
  getPendingWork: (_agent: string, deps: { hasActiveTaskState: (a: string) => boolean }) => {
    h.taskStateAsked = deps.hasActiveTaskState('worker')
    return { additionalContext: 'Ez a session ures jaratban indult', cards: h.cards, memories: [], olvashatatlan: h.unreadable }
  },
}))

const { availabilityTick, currentAvailability, readAvailabilityState, MAX_NOTIFY_ATTEMPTS } = await import('../web/agent-availability-watch.js')

const STATE = join(store, 'agent-availability.json')
const LOG = join(store, 'agent-availability.log')
const logLines = () => readFileSync(LOG, 'utf-8').trim().split('\n')

beforeEach(() => {
  writeFileSync(STATE, JSON.stringify({ agents: {}, notifiedAt: {} }))
  writeFileSync(LOG, '')
  Object.assign(h, { sent: [], sendFails: false, waiting: 0, running: true, usageAt: NOW, cards: [{ seq: 463, id: '068041e3', title: 'Figyelo', status: 'in_progress' }], unreadable: false, taskStateAsked: null })
})

describe('availabilityTick', () => {
  it('the first measurement is a baseline: state written, nobody told', () => {
    availabilityTick(NOW)
    expect(readAvailabilityState().agents.worker).toMatchObject({ available: false, reason: 'quota', resetsAt: RESET })
    expect(h.sent).toEqual([])
    expect(readFileSync(LOG, 'utf-8')).toBe('')
  })

  it('a spent window stays blocked for hours of silence, then the reset tells the agent itself', () => {
    availabilityTick(NOW)
    // The snapshot never refreshes (an exhausted agent renders nothing).
    availabilityTick(RESET - 1)
    expect(readAvailabilityState().agents.worker.available).toBe(false)
    expect(h.sent).toEqual([])

    availabilityTick(RESET)
    expect(readAvailabilityState().agents.worker).toMatchObject({ available: true, reason: 'ok', resetsAt: null, since: RESET })
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]).toMatchObject({ from: 'system', to: 'worker' })
    expect(h.sent[0]!.content).toContain('[ELERHETO] worker')
    expect(h.sent[0]!.content).toContain('#463 Figyelo')
    // Not the SessionStart text: this session was never restarted.
    expect(h.sent[0]!.content).not.toContain('ures jaratban')
    expect(logLines()).toHaveLength(1)
    expect(logLines()[0]).toContain('worker -> available (quota -> ok) message sent (1 card(s), 0 message(s))')
  })

  it('reads the cards even when a saved task state exists (no SessionStart here)', () => {
    availabilityTick(NOW)
    availabilityTick(RESET)
    expect(h.taskStateAsked).toBe(false)
  })

  it('nothing waiting: the edge is logged, no message', () => {
    h.cards = []
    availabilityTick(NOW)
    availabilityTick(RESET)
    expect(h.sent).toEqual([])
    expect(logLines()[0]).toContain('no message (no pending work)')
  })

  it('an unreadable store is not "nothing waiting": the agent is still told', () => {
    h.cards = []
    h.unreadable = true
    availabilityTick(NOW)
    availabilityTick(RESET)
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]!.content).toContain('nem sikerult kiolvasni')
  })

  it('a message that could not be sent is retried on the next tick, then sent once', () => {
    availabilityTick(NOW)
    h.sendFails = true
    availabilityTick(RESET)
    expect(h.sent).toEqual([])
    // The edge is NOT consumed: the stored entry is still the blocked one.
    expect(readAvailabilityState().agents.worker.available).toBe(false)
    expect(logLines()[0]).toContain('notify failed, will retry: database is locked')

    h.sendFails = false
    availabilityTick(RESET + 60_000)
    expect(h.sent).toHaveLength(1)
    expect(readAvailabilityState().agents.worker.available).toBe(true)

    availabilityTick(RESET + 120_000)
    expect(h.sent).toHaveLength(1)
  })

  it('a store that stays broken does not retry forever: the edge is given up, loudly', () => {
    availabilityTick(NOW)
    h.sendFails = true
    for (let i = 0; i < MAX_NOTIFY_ATTEMPTS; i++) availabilityTick(RESET + i * 60_000)
    expect(logLines()).toHaveLength(MAX_NOTIFY_ATTEMPTS)
    expect(logLines().at(-1)).toContain(`notify failed ${MAX_NOTIFY_ATTEMPTS} times, giving up`)
    expect(readAvailabilityState().agents.worker.available).toBe(true)
    // Consumed: later ticks are quiet.
    availabilityTick(RESET + 600_000)
    expect(logLines()).toHaveLength(MAX_NOTIFY_ATTEMPTS)
    expect(h.sent).toEqual([])
  })

  it('a session that just started gets no second message (SessionStart replays its work)', () => {
    h.running = false
    availabilityTick(RESET)
    expect(readAvailabilityState().agents.worker).toMatchObject({ available: false, reason: 'stopped' })
    h.running = true
    availabilityTick(RESET + 60_000)
    expect(h.sent).toEqual([])
    expect(logLines()[0]).toContain('worker -> available (stopped -> ok) no message (session start replays pending work)')
  })
})

describe('currentAvailability', () => {
  it('serves the stored state while fresh, and measures live once it is stale', () => {
    availabilityTick(NOW)
    expect(currentAvailability(NOW + 60_000)[0]).toMatchObject({ agent: 'worker', available: false, measuredAt: NOW })
    // Watcher stopped ticking: the answer must not be the frozen blocked entry.
    expect(currentAvailability(RESET + 600_000)[0]).toMatchObject({ agent: 'worker', available: true, measuredAt: RESET + 600_000 })
  })
  it('answers on a fresh install, before any tick wrote a state file', () => {
    writeFileSync(STATE, 'not json')
    expect(currentAvailability(NOW)).toHaveLength(1)
  })
})
