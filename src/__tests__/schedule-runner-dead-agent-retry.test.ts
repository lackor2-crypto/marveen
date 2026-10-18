import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScheduledTask } from '../web/scheduled-tasks-io.js'

// #702: a retry row sitting on a quota-blocked agent must never be injected
// into (the parked session never reads busy -> 1160 attempts in the real case),
// is reassigned to a working agent after a few attempts, and is only held when
// nobody can work.

const mocks = vi.hoisted(() => ({
  blocked: new Set<string>(),
  agents: ['deadagent', 'liveagent'] as string[],
  rows: [] as Array<Record<string, unknown>>,
  del: vi.fn(),
  ins: vi.fn(),
  upd: vi.fn(() => true),
  send: vi.fn(() => 'sent'),
  tasks: [] as unknown[],
}))

vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }))
vi.mock('../web/atomic-write.js', () => ({ atomicWriteFileSync: vi.fn() }))
vi.mock('../db.js', () => ({
  appendTaskRun: vi.fn(),
  listPendingTaskRetries: () => mocks.rows,
  deletePendingTaskRetry: (...a: unknown[]) => mocks.del(...a),
  updatePendingTaskRetry: (...a: unknown[]) => (mocks.upd as (...x: unknown[]) => boolean)(...a),
  insertPendingTaskRetryIfNew: (...a: unknown[]) => mocks.ins(...a),
  markPendingTaskRetryAlert: vi.fn(() => false),
  clearPendingTaskRetryAlert: vi.fn(),
  markScheduledTaskKanbanWaiting: vi.fn(),
}))
vi.mock('../channel-provider.js', async (orig) => {
  const real = await orig<typeof import('../channel-provider.js')>()
  return { ...real, getProvider: (t: Parameters<typeof real.getProvider>[0]) => ({ ...real.getProvider(t), sendMessage: vi.fn(async () => {}), sendPhoto: vi.fn(async () => {}) }) }
})
vi.mock('../web/scheduled-tasks-io.js', () => ({
  listScheduledTasks: () => mocks.tasks,
  claimScheduleOwnership: () => true,
  platformSatisfied: () => true,
  SCHEDULED_TASKS_DIR: '/tmp/marveen-dead-agent-no-tasks-dir',
}))
vi.mock('../web/agent-config.js', async (orig) => {
  const actual = await orig<typeof import('../web/agent-config.js')>()
  return { ...actual, listAgentNames: () => mocks.agents }
})
vi.mock('../web/agent-availability.js', async (orig) => {
  const actual = await orig<typeof import('../web/agent-availability.js')>()
  return { ...actual, isAgentQuotaBlocked: (n: string) => mocks.blocked.has(n) }
})
vi.mock('../web/agent-process.js', () => ({
  clearFeedbackModalAndRecheck: () => false,
  agentSessionName: (n: string) => `agent-${n}`,
  isAgentRunning: () => true,
  isSessionReadyForPrompt: () => true,
  sendPromptToSession: (...a: unknown[]) => mocks.send(...(a as [])),
  startAgentProcess: () => ({ ok: false, error: 'no' }),
  sessionExistsOnHost: () => true,
  capturePane: () => null,
  sendEnterToSession: vi.fn(),
  clearStaleParkedInput: vi.fn(() => false),
  resolveAgentProvider: () => 'telegram',
}))

import { MAIN_AGENT_ID as MAIN } from '../config.js'

const TASK: ScheduledTask = {
  name: 'dead-agent-daily', description: 'x', prompt: 'Do it.', agent: 'deadagent',
  schedule: '0 8 * * *', enabled: true, createdAt: 0, type: 'task',
} as ScheduledTask

const row = (o: Record<string, unknown> = {}) => ({
  task_name: TASK.name, agent_name: 'deadagent', first_attempt: Date.now() - 600000,
  last_attempt: Date.now() - 60000, attempt_count: 5, last_reason: 'busy', alert_sent_at: null, ...o,
})

async function tick() {
  vi.resetModules()
  const { startScheduleRunner } = await import('../web/schedule-runner.js')
  const stop = startScheduleRunner()
  await vi.advanceTimersByTimeAsync(61_000)
  clearInterval(stop)
}

describe('#702 retry on a quota-blocked agent', () => {
  beforeEach(() => {
    vi.stubEnv('SCHEDULER_TZ', 'Europe/Budapest')
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-31T10:30:00.000Z'))
    mocks.tasks = [TASK]
    mocks.blocked = new Set(['deadagent', MAIN])
    mocks.rows = []
  })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs() })

  it('reassigns a pinned row that burned its attempts to a working agent and fires there', async () => {
    mocks.rows = [row()]
    await tick()
    expect(mocks.del).toHaveBeenCalledWith(TASK.name, 'deadagent')
    expect(mocks.ins).toHaveBeenCalledWith(TASK.name, 'liveagent', expect.any(Number), 'busy')
    // (the mocked DB keeps the row, so several ticks may re-send; none may hit the dead agent)
    expect(mocks.send).toHaveBeenCalled()
    for (const c of mocks.send.mock.calls as unknown[][]) expect(String(c[0])).toContain('liveagent')
  })

  it('never injects into the dead agent when nobody else can work: holds the row', async () => {
    mocks.blocked = new Set(['deadagent', 'liveagent', MAIN])
    mocks.rows = [row({ attempt_count: 1160 })]
    await tick()
    expect(mocks.send).not.toHaveBeenCalled()
    expect(mocks.del).not.toHaveBeenCalled()
    expect(mocks.upd).toHaveBeenCalledWith(TASK.name, 'deadagent', expect.any(Number), 'quota-blocked')
  })

  it('a young row waits before reassigning, still without injecting into the dead agent', async () => {
    mocks.rows = [row({ attempt_count: 1 })]
    await tick()
    expect(mocks.send).not.toHaveBeenCalled()
    expect(mocks.upd).toHaveBeenCalledWith(TASK.name, 'deadagent', expect.any(Number), 'quota-blocked')
  })

  it('a mid-work reclaim row (agent-quota) moves at once', async () => {
    mocks.rows = [row({ attempt_count: 1, last_reason: 'agent-quota' })]
    await tick()
    expect(mocks.ins).toHaveBeenCalledWith(TASK.name, 'liveagent', expect.any(Number), 'agent-quota')
  })
})
