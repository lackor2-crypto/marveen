// Contract test for the account-wide OpenRouter free-tier rate limit
// (kanban 45c3cfad) as it is enforced in the message router.
//
// Every :free agent in the fleet draws on ONE 20 req/min budget. The router's
// delivery loop is the single choke point every dispatch path funnels through,
// so the gate lives there: a free-tier message that cannot get a slot stays
// pending and is retried next tick, while paid-model traffic is untouched.
//
// The earlier attempt paced each fan-out with a local variable inside
// POST /api/approvals/:id/verify, which is why two overlapping rounds still
// doubled the real request rate. These tests pin the property that broke:
// the budget is shared, so it does not matter who is dispatching.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockGetPendingMessages = vi.fn()
const mockSendPromptToSession = vi.fn(async (..._a: unknown[]) => undefined)

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  MAIN_AGENT_ID: 'orin',
  SUBAGENT_TELEGRAM_WAKE_ENABLED: false,
}))

vi.mock('../db.js', () => ({
  getPendingMessages: (toAgent?: string) => (toAgent ? [] : mockGetPendingMessages()),
  markMessageDelivered: (..._a: unknown[]) => true,
  markMessageFailed: (..._a: unknown[]) => true,
  markMessageDone: (..._a: unknown[]) => true,
  markPendingFederatedFailed: (..._a: unknown[]) => true,
  setMessageResult: (..._a: unknown[]) => true,
  createAgentMessage: (..._a: unknown[]) => ({ id: 999 }),
  stampMessageTrace: (..._a: unknown[]) => false,
  upsertOtelSpan: (..._a: unknown[]) => undefined,
  closeOtelSpan: (..._a: unknown[]) => false,
}))

vi.mock('../web/voice-directive.js', () => ({
  resolveAgentChannelStateDir: () => '/tmp/none',
}))

// gemma/ling are free-tier; sonny is a paid Claude agent.
vi.mock('../web/agent-config.js', () => ({
  readAgentRemoteHost: () => null,
  readAgentVoiceConfig: () => ({ responseMode: 'text' }),
  readAgentModel: (name: string) =>
    name === 'sonny' ? 'claude-sonnet-5' : `vendor/${name}-tiny:free`,
}))

vi.mock('../web/agent-process.js', () => ({
  agentSessionName: (name: string) => `agent-${name}`,
  isSessionReadyForPrompt: vi.fn(async () => true),
  clearStaleParkedInput: vi.fn(async () => false),
  sendPromptToSession: (...a: unknown[]) => mockSendPromptToSession(...a),
  sessionExistsOnHost: () => true,
}))

vi.mock('../web/voice-modality.js', () => ({ setLastInboundModality: vi.fn() }))
vi.mock('../web/main-agent.js', () => ({ MAIN_CHANNELS_SESSION: 'orin-channels' }))
vi.mock('../web/agent-message-wrap.js', () => ({
  classifyAgentMessage: (from: string) => ({
    category: from === 'channel' ? 'channel-inbound' : 'trusted-peer',
    safeFrom: from,
  }),
  wrapAgentMessageForDelivery: () => ({ prefix: '', wrapped: 'x' }),
}))

import { runMessageRouterTick } from '../web/message-router.js'
import {
  _resetFreeDispatchWindowForTest,
  EFFECTIVE_FREE_MODEL_RPM,
} from '../openrouter-dispatch-throttle.js'

let nextId = 1
function msg(to: string, from = 'orin') {
  return {
    id: nextId++,
    from_agent: from,
    to_agent: to,
    content: 'ping',
    created_at: Math.floor(Date.now() / 1000),
  }
}

/** Receivers the router actually injected into during the last tick. */
function deliveredSessions(): string[] {
  return mockSendPromptToSession.mock.calls.map((c) => String(c[0]))
}

describe('router free-tier pacing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    _resetFreeDispatchWindowForTest()
    nextId = 1
  })

  it('lets only one free-tier message out per tick, leaving the rest pending', async () => {
    const pending = [msg('gemma'), msg('ling'), msg('north')]
    mockGetPendingMessages.mockReturnValue(pending)

    await runMessageRouterTick()

    // Anti-burst spacing: the whole fan-out cannot leave in one pass.
    expect(deliveredSessions()).toEqual(['agent-gemma'])
  })

  it('never blocks a paid-model agent behind the free-tier queue', async () => {
    mockGetPendingMessages.mockReturnValue([msg('gemma'), msg('ling'), msg('sonny')])

    await runMessageRouterTick()

    const delivered = deliveredSessions()
    expect(delivered).toContain('agent-sonny')
    expect(delivered).toHaveLength(2) // one free + the paid one
  })

  it('holds the shared ceiling across many ticks, however many rounds overlap', async () => {
    // Two fan-outs' worth of free-tier traffic, hammered for a simulated
    // minute of ticks. The window is real wall-clock, so within one test run
    // nothing ages out: the ceiling is the hard stop.
    mockGetPendingMessages.mockReturnValue(
      Array.from({ length: 24 }, (_, i) => msg(`free${i}`)),
    )

    for (let tick = 0; tick < 24; tick++) await runMessageRouterTick()

    expect(mockSendPromptToSession.mock.calls.length).toBeLessThanOrEqual(EFFECTIVE_FREE_MODEL_RPM)
  })

  it('does not make a human wait out the fan-out spacing', async () => {
    // A channel-inbound message (someone typing in Telegram) is interactive:
    // it spends from the same budget but skips the anti-burst gap.
    mockGetPendingMessages.mockReturnValue([msg('gemma'), msg('ling', 'channel')])

    await runMessageRouterTick()

    expect(deliveredSessions()).toEqual(['agent-gemma', 'agent-ling'])
  })
})
