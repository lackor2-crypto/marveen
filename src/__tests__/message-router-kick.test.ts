// #377: a newly queued inter-agent message kicks a router tick right away
// instead of waiting for the next 5 s poll.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockGetPendingMessages = vi.fn(() => [])
const listeners: Array<() => void> = []
const mockMarkDelivered = vi.fn((..._a: unknown[]) => true)
const mockMarkFailed = vi.fn((..._a: unknown[]) => true)
const mockSessionExistsOnHost = vi.fn((..._a: unknown[]) => false)

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  MAIN_AGENT_ID: 'orin',
  // message-router imports maybeWakeSubAgentsForTelegram, which reads this flag
  // from config; keep it OFF so the wake watcher early-returns and this test
  // stays isolated to the per-tick message cap.
  SUBAGENT_TELEGRAM_WAKE_ENABLED: false,
}))

vi.mock('../db.js', () => ({
  getPendingMessages: (toAgent?: string) => {
    if (toAgent) return [] // per-agent query for reconnect pre-pass
    return mockGetPendingMessages()
  },
  markMessageDelivered: (...a: unknown[]) => mockMarkDelivered(...a),
  markMessageFailed: (...a: unknown[]) => mockMarkFailed(...a),
  markMessageDone: (..._a: unknown[]) => true,
  createAgentMessage: (..._a: unknown[]) => ({ id: 999 }),
  onAgentMessageCreated: (cb: () => void) => { listeners.push(cb); return () => {} },
  // card def5a189: OTel trace stubs -- no-ops in this test
  stampMessageTrace: (..._a: unknown[]) => false,
  upsertOtelSpan: (..._a: unknown[]) => undefined,
  closeOtelSpan: (..._a: unknown[]) => false,
}))

vi.mock('../web/voice-directive.js', () => ({
  resolveAgentChannelStateDir: () => '/tmp/none',
}))

vi.mock('../web/agent-config.js', () => ({
  readAgentRemoteHost: () => null,
  readAgentVoiceConfig: () => ({ responseMode: 'text' }),
  // Paid model: keeps the free-tier rate-limit gate out of this test's way.
  readAgentModel: () => 'claude-sonnet-5',
}))

vi.mock('../web/agent-process.js', () => ({
  agentSessionName: (name: string) => `agent-${name}`,
  isSessionReadyForPrompt: vi.fn(() => false),
  clearStaleParkedInput: vi.fn(() => false),
  sendPromptToSession: vi.fn(),
  sessionExistsOnHost: (...a: unknown[]) => mockSessionExistsOnHost(...a),
}))

vi.mock('../web/voice-modality.js', () => ({
  setLastInboundModality: vi.fn(),
}))

vi.mock('../web/main-agent.js', () => ({
  MAIN_CHANNELS_SESSION: 'orin-channels',
}))

vi.mock('../web/agent-message-wrap.js', () => ({
  classifyAgentMessage: () => ({ category: 'trusted-peer', safeFrom: 'orin' }),
  wrapAgentMessageForDelivery: () => ({ prefix: '', wrapped: '' }),
}))

import { startMessageRouter } from '../web/message-router.js'

describe('message router kick on new message (#377)', () => {
  beforeEach(() => { mockGetPendingMessages.mockClear() })

  it('runs a tick ~150 ms after a message is queued, and spaces kicked ticks >= 1 s', async () => {
    vi.useFakeTimers()
    const interval = startMessageRouter()
    try {
      expect(listeners.length).toBe(1)
      listeners[0]()
      listeners[0]() // a burst shares one pass
      await vi.advanceTimersByTimeAsync(200)
      expect(mockGetPendingMessages).toHaveBeenCalledTimes(1)

      listeners[0]()
      await vi.advanceTimersByTimeAsync(300)
      expect(mockGetPendingMessages).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(800)
      expect(mockGetPendingMessages).toHaveBeenCalledTimes(2)
    } finally {
      clearInterval(interval)
      vi.useRealTimers()
    }
  })
})
