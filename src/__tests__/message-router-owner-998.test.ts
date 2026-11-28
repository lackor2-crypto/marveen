// #998: a message the owner typed into an agent chat goes into a running turn instead of waiting for its end.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'

const pending: Array<Record<string, unknown>> = []
const listeners: Array<() => void> = []
const mockMarkDelivered = vi.fn((..._a: unknown[]) => true)
const mockSend = vi.fn(async (..._a: unknown[]) => 'sent')
let pane = ''
const mockGetPendingMessages = () => pending
const mockMarkFailed = vi.fn((..._a: unknown[]) => true)
const mockSessionExistsOnHost = (..._a: unknown[]) => true

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  MAIN_AGENT_ID: 'orin',
  currentOwnerName: () => 'Owner Person',
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
  getMessageStatus: () => 'pending',
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
  isSessionReadyForPrompt: vi.fn(async () => false),
  clearStaleParkedInput: vi.fn(async () => false),
  sendPromptToSession: (...a: unknown[]) => mockSend(...a),
  sessionExistsOnHost: () => true,
  sessionExistsOnHostAsync: async () => true,
  capturePane: () => pane,
  capturePaneStrippedAsync: async () => pane,
}))

vi.mock('../web/voice-modality.js', () => ({
  setLastInboundModality: vi.fn(),
}))

vi.mock('../web/main-agent.js', () => ({
  MAIN_CHANNELS_SESSION: 'orin-channels',
}))

vi.mock('../web/agent-message-wrap.js', () => ({
  classifyAgentMessage: (from: string) => ({ category: 'untrusted', safeFrom: from }),
  wrapAgentMessageForDelivery: () => ({ prefix: '', wrapped: '' }),
}))

import { runMessageRouterTick } from '../web/message-router.js'

const msg = (id: number, from: string) => ({ id, from_agent: from, to_agent: 'worker', content: 'x', created_at: Math.floor(Date.now() / 1000), trace_id: 't', span_id: 's' })

describe('#998: the owner\'s chat message does not wait for a long turn', () => {
  beforeEach(() => { pending.length = 0; mockSend.mockClear(); mockMarkDelivered.mockClear() })

  it('types it into a running turn at once; an agent message keeps waiting', async () => {
    pane = '✻ Working… (12s · esc to interrupt)\n  esc to interrupt'
    pending.push(msg(1, 'colleague'), msg(2, 'Owner Person'))
    await runMessageRouterTick()
    expect(mockSend).toHaveBeenCalledTimes(1)
    expect(mockSend.mock.calls[0]![3]).toEqual({ waitForIdle: false, noInterrupt: true })
    expect(mockMarkDelivered).toHaveBeenCalledWith(2)
  })

  it('never types into a pane it cannot read as a running turn', async () => {
    pane = 'Do you want to proceed?\n 1. Yes\n 2. No'
    pending.push(msg(3, 'Owner Person'))
    await runMessageRouterTick()
    expect(mockSend).not.toHaveBeenCalled()
  })

  it('typing into a running turn never presses Ctrl-C', () => {
    const src = readFileSync(new URL('../web/agent-process.ts', import.meta.url), 'utf-8')
    expect(src).toContain('!opts.noInterrupt && preCapture != null && shouldClearTruncatedPreamble(preCapture)')
    expect(src).toContain("if (action === 'clear-and-resend' && opts.noInterrupt) {")
  })
})
