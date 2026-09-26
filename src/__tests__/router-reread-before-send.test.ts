// #413 (rebuilt from upstream 9fb22e5d): the router re-reads a row right before
// the send. Harness copied from router-free-tier-pacing.test.ts.
// ORIGINAL NOTE of that harness: account-wide OpenRouter free-tier rate limit
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
const mockStatus = vi.fn((_id: number): string | null => 'pending')

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
  // #413: the router re-reads the row right before the send; the rows here stay pending.
  getMessageStatus: (id: number) => mockStatus(id),
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
  readAgentModel: (_name: string) => 'claude-sonnet-5',
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
import { _resetFreeDispatchWindowForTest } from '../openrouter-dispatch-throttle.js'

let nextId = 1
function msg(to: string, from = 'orin') {
  return { id: nextId++, from_agent: from, to_agent: to, content: 'ping', created_at: Math.floor(Date.now() / 1000) }
}
const sent = () => mockSendPromptToSession.mock.calls.map((c) => String(c[0]))

describe('router re-reads the row before the send (#413)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    _resetFreeDispatchWindowForTest()
    mockStatus.mockImplementation(() => 'pending')
    nextId = 1
  })

  it('a row closed after the tick snapshot is NOT sent; the others are', async () => {
    const a = msg('sonny')
    const b = msg('sonny2')
    mockGetPendingMessages.mockReturnValue([a, b])
    mockStatus.mockImplementation((id) => (id === a.id ? 'done' : 'pending'))
    await runMessageRouterTick()
    expect(sent()).toEqual(['agent-sonny2'])
  })

  it('a deleted row (null status) is not sent either', async () => {
    const a = msg('sonny')
    mockGetPendingMessages.mockReturnValue([a])
    mockStatus.mockImplementation(() => null)
    await runMessageRouterTick()
    expect(sent()).toEqual([])
  })

  it('a still-pending row goes out as before', async () => {
    mockGetPendingMessages.mockReturnValue([msg('sonny')])
    await runMessageRouterTick()
    expect(sent()).toEqual(['agent-sonny'])
  })
})
