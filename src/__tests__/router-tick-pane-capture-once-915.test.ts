// #915: several pending messages for ONE busy agent must cost ONE pane readiness check (and one
// stale-input janitor look) per tick, not one per message. Each check is 2-5 synchronous tmux
// spawns (0.6-0.8 s apiece on a loaded machine), which froze the dashboard on every 5 s tick.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockGetPendingMessages = vi.fn()
const mockReady = vi.fn(async (..._a: unknown[]) => false)
const mockJanitor = vi.fn(async (..._a: unknown[]) => false)
const mockSend = vi.fn(async (..._a: unknown[]) => undefined)

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
  getMessageStatus: (_id: number) => 'pending',
  markMessageFailed: (..._a: unknown[]) => true,
  markMessageDone: (..._a: unknown[]) => true,
  markPendingFederatedFailed: (..._a: unknown[]) => true,
  setMessageResult: (..._a: unknown[]) => true,
  createAgentMessage: (..._a: unknown[]) => ({ id: 999 }),
  stampMessageTrace: (..._a: unknown[]) => false,
  upsertOtelSpan: (..._a: unknown[]) => undefined,
  closeOtelSpan: (..._a: unknown[]) => false,
}))

vi.mock('../web/voice-directive.js', () => ({ resolveAgentChannelStateDir: () => '/tmp/none' }))

vi.mock('../web/agent-config.js', () => ({
  readAgentRemoteHost: () => null,
  readAgentVoiceConfig: () => ({ responseMode: 'text' }),
  readAgentModel: (_name: string) => 'claude-sonnet-5',
}))

vi.mock('../web/agent-process.js', () => ({
  agentSessionName: (name: string) => `agent-${name}`,
  isSessionReadyForPrompt: (...a: unknown[]) => mockReady(...a),
  clearStaleParkedInput: (...a: unknown[]) => mockJanitor(...a),
  sendPromptToSession: (...a: unknown[]) => mockSend(...a),
  sessionExistsOnHost: () => true,
}))

vi.mock('../web/voice-modality.js', () => ({ setLastInboundModality: vi.fn() }))
vi.mock('../web/main-agent.js', () => ({ MAIN_CHANNELS_SESSION: 'orin-channels' }))
vi.mock('../web/agent-message-wrap.js', () => ({
  classifyAgentMessage: (from: string) => ({ category: 'trusted-peer', safeFrom: from }),
  wrapAgentMessageForDelivery: () => ({ prefix: '', wrapped: 'x' }),
}))

import { runMessageRouterTick } from '../web/message-router.js'

let nextId = 1
// Old enough for the janitor path (age above JANITOR_PARKED_MIN_AGE_MS).
const msg = (to: string) => ({ id: nextId++, from_agent: 'orin', to_agent: to, content: 'ping', created_at: Math.floor(Date.now() / 1000) - 3600 })

describe('router tick checks a busy pane once (#915)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockReady.mockImplementation(async () => false)
    mockJanitor.mockImplementation(async () => false)
    nextId = 1
  })

  it('five messages to one busy agent: ONE readiness check, ONE janitor look, nothing sent', async () => {
    mockGetPendingMessages.mockReturnValue([msg('sonny'), msg('sonny'), msg('sonny'), msg('sonny'), msg('sonny')])
    await runMessageRouterTick()
    expect(mockReady).toHaveBeenCalledTimes(1)
    expect(mockJanitor.mock.calls.length).toBeLessThanOrEqual(1)
    expect(mockSend).not.toHaveBeenCalled()
  })

  it('different agents are still each checked once', async () => {
    mockGetPendingMessages.mockReturnValue([msg('a'), msg('b'), msg('a'), msg('b')])
    await runMessageRouterTick()
    expect(mockReady).toHaveBeenCalledTimes(2)
  })

  it('a READY pane is not remembered: every message to it looks again', async () => {
    mockReady.mockImplementation(async () => true)
    mockGetPendingMessages.mockReturnValue([msg('sonny'), msg('sonny')])
    await runMessageRouterTick()
    expect(mockReady).toHaveBeenCalledTimes(2)
  })
})
