// #994 (Boss TG 7837, "what is this?"): a */2 minute, skipIfBusy self-check of one agent was queued after a
// quota-blocked fire, moved to another (busy) agent and alerted "waiting for 60 minutes" -- about nothing.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import type { ScheduledTask } from '../web/scheduled-tasks-io.js'

const mocks = vi.hoisted(() => ({
  blocked: new Set<string>(),
  rows: [] as Array<Record<string, unknown>>,
  del: vi.fn(), ins: vi.fn(), run: vi.fn(), upd: vi.fn(() => true),
  send: vi.fn(() => 'sent'), tasks: [] as unknown[],
}))

vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }))
vi.mock('../web/atomic-write.js', () => ({ atomicWriteFileSync: vi.fn() }))
vi.mock('../db.js', () => ({
  appendTaskRun: (...a: unknown[]) => mocks.run(...a),
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
  SCHEDULED_TASKS_DIR: '/tmp/marveen-994-no-tasks-dir',
}))
vi.mock('../web/agent-config.js', async (orig) => {
  const actual = await orig<typeof import('../web/agent-config.js')>()
  return { ...actual, listAgentNames: () => ['owneragent', 'liveagent'] }
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
  sessionExistsOnHostAsync: async () => true,
  capturePane: () => null,
  capturePaneStrippedAsync: async () => null,
  sendEnterToSession: vi.fn(),
  clearStaleParkedInput: vi.fn(() => false),
  resolveAgentProvider: () => 'telegram',
}))

import { MAIN_AGENT_ID as MAIN } from '../config.js'

const CHECK: ScheduledTask = {
  name: 'self-check', description: 'x', prompt: 'Check.', agent: 'owneragent',
  schedule: '*/2 * * * *', enabled: true, createdAt: 0, type: 'heartbeat', skipIfBusy: true,
} as ScheduledTask
const SPARSE = { ...CHECK, name: 'daily-job', schedule: '0 8 * * *', type: 'task' } as ScheduledTask

async function run(ms: number, onMinute?: () => void) {
  vi.resetModules()
  const { startScheduleRunner } = await import('../web/schedule-runner.js')
  const stop = startScheduleRunner()
  for (let t = 0; t < ms; t += 60_000) { await vi.advanceTimersByTimeAsync(61_000); onMinute?.() }
  clearInterval(stop)
}

describe('#994: a short-cadence skipIfBusy check is dropped, not queued or moved', () => {
  beforeEach(() => {
    // SCHEDULER_TZ comes from the settings files, not process.env; without one the zone is the host's.
    vi.stubEnv('TZ', 'Europe/Budapest')
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-31T10:30:00.000Z'))
    mocks.tasks = [CHECK]
    mocks.blocked = new Set()
    mocks.rows = []
  })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs() })

  it('fired into an agent that then hits its usage wall and never starts: no retry row', async () => {
    // the first tick fires, then the agent is at its wall for the rest of the run
    await run(9 * 60_000, () => { if (mocks.send.mock.calls.length) mocks.blocked = new Set(['owneragent', MAIN]) })
    expect(mocks.send).toHaveBeenCalled()
    expect(mocks.ins).not.toHaveBeenCalled()
    expect(mocks.run).toHaveBeenCalledWith('self-check', 'owneragent', 'skipped')
  })

  it('a daily task in the same situation is still queued (nothing is lost)', async () => {
    mocks.tasks = [SPARSE]
    vi.setSystemTime(new Date('2026-07-31T05:59:30.000Z')) // 07:59:30 Budapest
    await run(9 * 60_000, () => { if (mocks.send.mock.calls.length) mocks.blocked = new Set(['owneragent', MAIN]) })
    expect(mocks.ins).toHaveBeenCalledWith('daily-job', 'owneragent', expect.any(Number), 'did-not-start')
  })

  it('a queued row of the check is never moved to another agent', async () => {
    mocks.blocked = new Set(['owneragent', MAIN])
    mocks.rows = [{ task_name: 'self-check', agent_name: 'owneragent', first_attempt: Date.now() - 600000, last_attempt: Date.now() - 60000, attempt_count: 9, last_reason: 'agent-quota', alert_sent_at: null }]
    await run(60_000)
    expect(mocks.ins).not.toHaveBeenCalledWith('self-check', 'liveagent', expect.any(Number), expect.anything())
    for (const c of mocks.send.mock.calls as unknown[][]) expect(String(c[0])).not.toContain('liveagent')
  })
})

describe('#994: the stuck-task alert speaks plainly, in the install language', () => {
  const view = { taskName: 'daily-job', agentName: 'owneragent', ageMs: 61 * 60_000, firstAttempt: Date.UTC(2026, 6, 31, 6), lastReason: 'quota-blocked' }

  it('says why it waits and that nothing is urgent -- Hungarian and English', async () => {
    const { pendingRetryAlertText } = await import('../web/schedule-runner.js')
    const hu = pendingRetryAlertText(view, 'Bot', 'hu')
    expect(hu).toContain('61 perce várakozik, mert az ágensnek elfogyott a használati kerete')
    expect(hu).toContain('Nincs sürgős teendőd')
    const en = pendingRetryAlertText(view, 'Bot', 'en')
    expect(en).toContain('waiting for 61 minutes because the agent has used up its usage limit')
    expect(en).not.toMatch(/perce|ágens/)
  })

  it('a dead MCP and a first-run screen still name what to do', async () => {
    const { pendingRetryAlertText } = await import('../web/schedule-runner.js')
    expect(pendingRetryAlertText({ ...view, lastReason: 'mcp-missing:gmail' }, 'Bot', 'en')).toMatch(/gmail[\s\S]*To do: restart/)
    expect(pendingRetryAlertText({ ...view, lastReason: 'first-run' }, 'Bot', 'hu')).toMatch(/első indítás[\s\S]*Teendő/)
  })
})

describe('#994: the Schedules page says why a task waits in words, not as an internal code', () => {
  const web = (p: string) => readFileSync(new URL('../../web/' + p, import.meta.url), 'utf8')
  const app = web('app.js')
  const start = app.indexOf('function pendingReasonText(')

  it('maps every stored reason to a translated sentence', () => {
    expect(start).toBeGreaterThan(-1)
    const src = app.slice(start, app.indexOf('\n}\n', start) + 2)
    const text = new Function('t', src + '\nreturn pendingReasonText')((k: string) => k) as (r: string) => string
    const codes = ['quota-blocked', 'agent-quota', 'starting', 'missing', 'busy', 'did-not-start', 'first-run', 'mcp-missing:gmail', 'error']
    for (const code of codes) {
      const key = text(code)
      for (const lang of ['hu.js', 'en.js']) expect(web('lang/' + lang)).toContain(`'${key}':`)
    }
    expect(app).not.toContain('<span>ok: ${')
  })

  it('on a phone the task name keeps the row width; badges and buttons wrap under it', () => {
    const css = web('style.css')
    expect(css).toContain('.schedule-row > .schedule-info { flex: 1 1 calc(100% - 60px); }')
    expect(css).toContain('.schedule-row { flex-wrap: wrap; }')
  })
})
