import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Role-based automatic context nullification (kartya #275). The pure membership
// rules (who is cleared, who is spared) live in context-broker.test.ts against
// planRoleClear. This file covers the I/O orchestration in context-clear.ts:
// that the dispatcher is NEVER sent a /clear end-to-end, that a busy pane is
// left untouched (mid-turn protection), that unreachable / code-bridge holders
// are reported rather than blindly targeted, and that unprocessed inbox blocks
// the clear unless forced. Real temp dirs back the existence + inbox checks, so
// node:fs is never globally mocked (which would perturb module init).

const mockState = vi.hoisted(() => ({
  tmpRoot: '',
  roles: { planner: null, implementer: null, checker: null } as Record<string, string | null>,
  running: new Set<string>(),
  // Per-session sendPromptToSession result: 'sent' (idle -> cleared) or
  // 'aborted-busy' (pane never idled -> nothing sent).
  sendResult: {} as Record<string, 'sent' | 'aborted-busy'>,
  // Every send actually issued -- the proof of what was cleared and how it was guarded.
  sent: [] as Array<{ session: string; text: string; onBusyTimeout?: string; waitForIdle?: boolean }>,
}))

vi.mock('../web/context-broker-store.js', async (orig) => {
  const actual = await orig<typeof import('../web/context-broker-store.js')>()
  return { ...actual, readBrokerConfig: () => ({
    designated: null, updatedAt: null, cleanStart: false, handBackAfterSeconds: 0,
    roles: {
      planner: mockState.roles.planner ?? null,
      implementer: mockState.roles.implementer ?? null,
      checker: mockState.roles.checker ?? null,
    },
  }) }
})

vi.mock('../web/main-agent.js', async (orig) => {
  const actual = await orig<typeof import('../web/main-agent.js')>()
  // Every agent in these tests is a sub-agent; the main-channels branch is
  // exercised by the manual button's own route.
  return { ...actual, isMainChannelsAgent: () => false, MAIN_CHANNELS_SESSION: 'agent-main' }
})

vi.mock('../web/agent-config.js', async (orig) => {
  const actual = await orig<typeof import('../web/agent-config.js')>()
  return { ...actual, agentDir: (n: string) => join(mockState.tmpRoot, n), readAgentRemoteHost: () => null }
})

vi.mock('../web/agent-process.js', async (orig) => {
  const actual = await orig<typeof import('../web/agent-process.js')>()
  return {
    ...actual,
    isAgentRunning: (n: string) => mockState.running.has(n),
    sendPromptToSession: async (session: string, text: string, _host: string | null, opts: Record<string, unknown> = {}) => {
      mockState.sent.push({ session, text, onBusyTimeout: opts.onBusyTimeout as string, waitForIdle: opts.waitForIdle as boolean })
      return mockState.sendResult[session] ?? 'sent'
    },
  }
})

import { clearRoleParticipants } from '../web/context-clear.js'

/** Mark an agent as an existing, running sub-agent with an empty inbox. */
function ready(...names: string[]) {
  for (const n of names) {
    mkdirSync(join(mockState.tmpRoot, n), { recursive: true })
    mockState.running.add(n)
  }
}

describe('clearRoleParticipants (kartya #275)', () => {
  beforeEach(() => {
    mockState.tmpRoot = mkdtempSync(join(tmpdir(), 'ctxclear-'))
    mockState.roles = { planner: null, implementer: null, checker: null }
    mockState.running = new Set()
    mockState.sendResult = {}
    mockState.sent = []
  })
  afterEach(() => {
    try { rmSync(mockState.tmpRoot, { recursive: true, force: true }) } catch { /* best effort */ }
  })

  it('clears the idle role holders and NEVER the dispatcher', async () => {
    mockState.roles = { planner: 'lackor2', implementer: 'usalackor', checker: 'gypsy' }
    ready('usalackor', 'gypsy') // dispatcher lackor2 is not even marked ready
    const report = await clearRoleParticipants({ dispatcher: 'lackor2' })

    expect(report.assignedCount).toBe(3)
    expect(report.clearedCount).toBe(2)
    const sessions = mockState.sent.map((s) => s.session)
    expect(sessions).toEqual(['agent-usalackor', 'agent-gypsy'])
    expect(sessions).not.toContain('agent-lackor2')
    expect(mockState.sent.every((s) => s.text === '/clear')).toBe(true)
  })

  it('only writes to an idle pane -- a busy pane is aborted, nothing sent into it', async () => {
    mockState.roles = { planner: 'lackor2', implementer: 'usalackor', checker: 'gypsy' }
    ready('usalackor', 'gypsy')
    mockState.sendResult['agent-usalackor'] = 'aborted-busy'
    const report = await clearRoleParticipants({ dispatcher: 'lackor2' })

    expect(report.results.find((r) => r.agent === 'usalackor')!.outcome).toBe('busy')
    expect(report.results.find((r) => r.agent === 'gypsy')!.outcome).toBe('cleared')
    // The guard is expressed TO sendPromptToSession, not decided after the fact.
    expect(mockState.sent.every((s) => s.waitForIdle === true && s.onBusyTimeout === 'abort')).toBe(true)
  })

  it('reports an assigned-but-stopped holder as not-running, and sends nothing to it', async () => {
    mockState.roles = { planner: 'lackor2', implementer: 'usalackor', checker: null }
    // usalackor is assigned but NOT running -> "assigned but not reachable",
    // which the zero-means-two-things rule keeps distinct from "unassigned".
    const report = await clearRoleParticipants({ dispatcher: 'lackor2' })
    expect(report.assignedCount).toBe(2)
    expect(report.results).toEqual([{ agent: 'usalackor', roles: ['implementer'], outcome: 'not-running', pending: undefined }])
    expect(mockState.sent).toEqual([])
  })

  it('fresh install: no roles assigned clears nobody and is not an error', async () => {
    const report = await clearRoleParticipants({ dispatcher: 'lackor2' })
    expect(report.assignedCount).toBe(0)
    expect(report.results).toEqual([])
    expect(report.clearedCount).toBe(0)
    expect(mockState.sent).toEqual([])
  })

  it('a code-bridge role holder (vscode:<project>) has no panel -- reported, not targeted', async () => {
    mockState.roles = { planner: 'lackor2', implementer: 'vscode:marveen', checker: null }
    const report = await clearRoleParticipants({ dispatcher: 'lackor2' })
    expect(report.results).toEqual([{ agent: 'vscode:marveen', roles: ['implementer'], outcome: 'no-panel-code-bridge' }])
    expect(mockState.sent).toEqual([])
  })

  it('unprocessed inbox blocks the clear (needs-confirm) unless force is set', async () => {
    mockState.roles = { planner: 'lackor2', implementer: 'usalackor', checker: null }
    ready('usalackor')
    const chDir = join(mockState.tmpRoot, 'usalackor', '.claude', 'channels', 'telegram')
    mkdirSync(chDir, { recursive: true })
    writeFileSync(join(chDir, 'inbox-pending.jsonl'), '{"a":1}\n')

    const guarded = await clearRoleParticipants({ dispatcher: 'lackor2' })
    const usa = guarded.results.find((r) => r.agent === 'usalackor')!
    expect(usa.outcome).toBe('needs-confirm')
    expect(usa.pending).toBe(1)
    expect(mockState.sent).toEqual([])

    const forced = await clearRoleParticipants({ dispatcher: 'lackor2', force: true })
    expect(forced.results.find((r) => r.agent === 'usalackor')!.outcome).toBe('cleared')
    expect(mockState.sent.map((s) => s.session)).toEqual(['agent-usalackor'])
  })
})
