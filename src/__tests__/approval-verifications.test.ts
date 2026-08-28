import { describe, it, expect, beforeEach, vi } from 'vitest'
import { initDatabase, createApproval, createKanbanCard, getKanbanComments } from '../db.js'

vi.mock('../config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../config.js')>()
  return { ...real, MAIN_AGENT_ID: 'lackor2-bot' }
})

const runningAgents = new Set<string>()
// The main agent has no `agent-<name>` session: its own `<id>-channels` session
// is service-managed and only ever CHECKED here, never started.
const liveTmuxSessions = new Set<string>()
const startAgentProcessMock = vi.fn((name: string) => { runningAgents.add(name); return { ok: true, pid: 1 } })
vi.mock('../web/agent-process.js', () => ({
  isAgentRunning: (name: string) => runningAgents.has(name),
  startAgentProcess: (name: string) => startAgentProcessMock(name),
  sessionExistsOnHost: (_host: string | null, session: string) => liveTmuxSessions.has(session),
}))

const existingAgentDirs = new Set<string>()
vi.mock('../web/agent-config.js', () => ({
  agentDir: (name: string) => `/fake/agents/${name}`,
  // The free-tier rate limit no longer lives on this path at all -- it moved to
  // the message router's delivery loop (kanban 45c3cfad) -- so dispatch here is
  // unpaced regardless of model. Kept as a non-free default anyway: it is what
  // the fleet's Claude agents actually run, and it documents the expectation
  // that this endpoint never blocks on the model an agent happens to use.
  readAgentModel: () => 'claude-sonnet-5',
}))
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>()
  return {
    ...real,
    existsSync: (p: string) => {
      if (typeof p === 'string' && p.startsWith('/fake/agents/')) {
        return existingAgentDirs.has(p.replace('/fake/agents/', ''))
      }
      return real.existsSync(p)
    },
  }
})

import { tryHandleApprovals, verificationSender } from '../web/routes/approvals.js'
import { getPendingMessages, listApprovalVerifications } from '../db.js'
import { resetCodeBridgeTablesForTests, upsertCodeSession, listCodeTasks } from '../web/code-bridge-store.js'
import type { RouteContext } from '../web/routes/types.js'

function fakeReq(method: string, path: string, body?: unknown): { ctx: RouteContext; out: { status: number; body: any } } {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
  }
  const url = new URL(`http://localhost:3420${path}`)
  const bodyStr = JSON.stringify(body ?? {})
  const req: any = {
    on(event: string, cb: (chunk?: Buffer) => void) {
      if (event === 'data') cb(Buffer.from(bodyStr))
      if (event === 'end') cb()
    },
  }
  return { ctx: { req, res, path: url.pathname, method, url } as RouteContext, out }
}

describe('approval verifications', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    runningAgents.clear()
    startAgentProcessMock.mockClear()
    liveTmuxSessions.clear()
    liveTmuxSessions.add('lackor2-bot-channels')
    existingAgentDirs.clear()
    existingAgentDirs.add('gemma')
    existingAgentDirs.add('north')
    // The bridge tables are created lazily behind a module-level flag, so a new
    // in-memory database needs the flag cleared or the tables land in the DB of
    // whichever test ran first.
    resetCodeBridgeTablesForTests()
  })

  it('dispatches to a known, non-requester agent and creates a pending row', async () => {
    const approval = createApproval({ id: 'a1', agent_id: 'lackor2-bot', category: 'code_change', action_description: 'Fix X' })
    const { ctx, out } = fakeReq('POST', `/api/approvals/${approval.id}/verify`, { agents: ['gemma'] })
    const handled = await tryHandleApprovals(ctx)
    expect(handled).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body.dispatched).toEqual(['gemma'])
    expect(out.body.failed).toEqual([])

    const { ctx: getCtx, out: getOut } = fakeReq('GET', `/api/approvals/${approval.id}/verify`)
    await tryHandleApprovals(getCtx)
    expect(getOut.body).toHaveLength(1)
    expect(getOut.body[0]).toMatchObject({ approval_id: approval.id, agent: 'gemma', status: 'pending' })
  })

  it('auto-starts an agent that is not currently running', async () => {
    const approval = createApproval({ id: 'a2', agent_id: 'lackor2-bot', category: 'code_change', action_description: 'Fix Y' })
    expect(runningAgents.has('gemma')).toBe(false)
    const { ctx } = fakeReq('POST', `/api/approvals/${approval.id}/verify`, { agents: ['gemma'] })
    await tryHandleApprovals(ctx)
    expect(runningAgents.has('gemma')).toBe(true)
  })

  // Boss 2026-08-24: the main agent must be pickable as a verifier too. It is
  // NOT a sub-agent: no agents/<name> dir, no `agent-<name>` session -- taking
  // the sub-agent path would spawn a rogue duplicate session.
  it('dispatches to the main agent without touching the sub-agent start path', async () => {
    const approval = createApproval({ id: 'am1', agent_id: 'gemma', category: 'code_change', action_description: 'Fix M' })
    const { ctx, out } = fakeReq('POST', `/api/approvals/${approval.id}/verify`, { agents: ['lackor2-bot'] })
    await tryHandleApprovals(ctx)
    expect(out.body.dispatched).toEqual(['lackor2-bot'])
    expect(out.body.failed).toEqual([])
    expect(startAgentProcessMock).not.toHaveBeenCalled()

    // A from === to self-message would be framed as UNTRUSTED and would read to
    // the agent as a message from itself, so the sender is 'system' instead.
    const msgs = getPendingMessages('lackor2-bot')
    expect(msgs).toHaveLength(1)
    expect(msgs[0].from_agent).toBe('system')
    expect(verificationSender('lackor2-bot')).toBe('system')
    expect(verificationSender('gemma')).toBe('lackor2-bot')
  })

  it('says the main agent session is down instead of silently dispatching into the void', async () => {
    liveTmuxSessions.clear()
    const approval = createApproval({ id: 'am2', agent_id: 'gemma', category: 'code_change', action_description: 'Fix N' })
    const { ctx, out } = fakeReq('POST', `/api/approvals/${approval.id}/verify`, { agents: ['lackor2-bot'] })
    await tryHandleApprovals(ctx)
    expect(out.body.dispatched).toEqual([])
    expect(out.body.failed).toHaveLength(1)
    expect(out.body.failed[0].agent).toBe('lackor2-bot')
    expect(out.body.failed[0].error).toMatch(/lackor2-bot-channels/)
    expect(getPendingMessages('lackor2-bot')).toHaveLength(0)
  })

  it('rejects the requesting agent verifying its own approval', async () => {
    const approval = createApproval({ id: 'a3', agent_id: 'gemma', category: 'code_change', action_description: 'Fix Z' })
    const { ctx, out } = fakeReq('POST', `/api/approvals/${approval.id}/verify`, { agents: ['gemma', 'north'] })
    await tryHandleApprovals(ctx)
    expect(out.body.dispatched).toEqual(['north'])
    expect(out.body.failed).toEqual([{ agent: 'gemma', error: 'The requesting agent cannot verify its own request' }])
  })

  it('reports "agent not found" for an unknown agent name', async () => {
    const approval = createApproval({ id: 'a4', agent_id: 'lackor2-bot', category: 'code_change', action_description: 'Fix W' })
    const { ctx, out } = fakeReq('POST', `/api/approvals/${approval.id}/verify`, { agents: ['nosuchagent'] })
    await tryHandleApprovals(ctx)
    expect(out.body.failed).toEqual([{ agent: 'nosuchagent', error: 'Agent not found' }])
  })

  it('an agent reporting pass/fail resolves its own row, and GET /api/approvals embeds verifications', async () => {
    const approval = createApproval({ id: 'a5', agent_id: 'lackor2-bot', category: 'code_change', action_description: 'Fix V' })
    await tryHandleApprovals(fakeReq('POST', `/api/approvals/${approval.id}/verify`, { agents: ['gemma', 'north'] }).ctx)

    const { ctx: resultCtx, out: resultOut } = fakeReq('POST', `/api/approvals/${approval.id}/verify-result`, { agent: 'gemma', status: 'pass', report: 'looks fine' })
    await tryHandleApprovals(resultCtx)
    expect(resultOut.status).toBe(200)

    const { ctx: listCtx, out: listOut } = fakeReq('GET', '/api/approvals?limit=10')
    await tryHandleApprovals(listCtx)
    const found = listOut.body.find((a: any) => a.id === approval.id)
    expect(found.verifications).toHaveLength(2)
    const gemmaRow = found.verifications.find((v: any) => v.agent === 'gemma')
    const northRow = found.verifications.find((v: any) => v.agent === 'north')
    expect(gemmaRow).toMatchObject({ status: 'pass', report: 'looks fine' })
    expect(northRow).toMatchObject({ status: 'pending' })
  })

  it('rejects a verify-result for an agent that was never dispatched', async () => {
    const approval = createApproval({ id: 'a6', agent_id: 'lackor2-bot', category: 'code_change', action_description: 'Fix U' })
    const { ctx, out } = fakeReq('POST', `/api/approvals/${approval.id}/verify-result`, { agent: 'gemma', status: 'pass', report: '' })
    await tryHandleApprovals(ctx)
    expect(out.status).toBe(404)
  })

  it('posts the verification finding as a comment on a linked kanban card', async () => {
    createKanbanCard({ id: 'card1', title: 'Some feature' })
    const approval = createApproval({
      id: 'a8', agent_id: 'lackor2-bot', category: 'kanban_done', action_description: 'Ship it',
      action_payload: JSON.stringify({ kanban_card_id: 'card1' }),
    })
    await tryHandleApprovals(fakeReq('POST', `/api/approvals/${approval.id}/verify`, { agents: ['gemma'] }).ctx)
    await tryHandleApprovals(fakeReq('POST', `/api/approvals/${approval.id}/verify-result`, { agent: 'gemma', status: 'fail', report: 'drag-and-drop is broken' }).ctx)

    const comments = getKanbanComments('card1')
    expect(comments).toHaveLength(1)
    expect(comments[0].author).toBe('gemma')
    expect(comments[0].content).toContain('drag-and-drop is broken')
    expect(comments[0].content).toContain('❌')
  })

  it('re-dispatching to the same agent resets a prior fail back to pending', async () => {
    const approval = createApproval({ id: 'a7', agent_id: 'lackor2-bot', category: 'code_change', action_description: 'Fix T' })
    await tryHandleApprovals(fakeReq('POST', `/api/approvals/${approval.id}/verify`, { agents: ['gemma'] }).ctx)
    await tryHandleApprovals(fakeReq('POST', `/api/approvals/${approval.id}/verify-result`, { agent: 'gemma', status: 'fail', report: 'broken' }).ctx)
    await tryHandleApprovals(fakeReq('POST', `/api/approvals/${approval.id}/verify`, { agents: ['gemma'] }).ctx)

    const { ctx, out } = fakeReq('GET', `/api/approvals/${approval.id}/verify`)
    await tryHandleApprovals(ctx)
    expect(out.body).toHaveLength(1)
    expect(out.body[0]).toMatchObject({ status: 'pending', report: null })
  })
})

// --- mode: review vs. fix (Boss 2026-08-24) --------------------------------
describe('verification mode on the dispatch endpoint', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    runningAgents.clear()
    startAgentProcessMock.mockClear()
    liveTmuxSessions.clear()
    liveTmuxSessions.add('lackor2-bot-channels')
    existingAgentDirs.clear()
    existingAgentDirs.add('gemma')
    resetCodeBridgeTablesForTests()
  })

  it("stores 'verify' when the caller sends no mode at all -- an old client must not gain write rights", async () => {
    const approval = createApproval({ id: 'm1', agent_id: 'lackor2-bot', category: 'code_change', action_description: 'X' })
    const { ctx, out } = fakeReq('POST', `/api/approvals/${approval.id}/verify`, { agents: ['gemma'] })
    await tryHandleApprovals(ctx)
    expect(out.body.mode).toBe('verify')
    expect(listApprovalVerifications(approval.id)[0]!.mode).toBe('verify')
    expect(getPendingMessages('gemma')[0]!.content).toContain('CSAK-OLVASO ELLENORZES')
  })

  it("stores 'verify' for an unknown mode rather than failing the dispatch", async () => {
    const approval = createApproval({ id: 'm2', agent_id: 'lackor2-bot', category: 'code_change', action_description: 'X' })
    const { ctx, out } = fakeReq('POST', `/api/approvals/${approval.id}/verify`, { agents: ['gemma'], mode: 'repair' })
    await tryHandleApprovals(ctx)
    expect(out.status).toBe(200)
    expect(out.body.mode).toBe('verify')
  })

  it("dispatches a real fix job when mode is 'fix'", async () => {
    const approval = createApproval({ id: 'm3', agent_id: 'lackor2-bot', category: 'code_change', action_description: 'X' })
    const { ctx, out } = fakeReq('POST', `/api/approvals/${approval.id}/verify`, { agents: ['gemma'], mode: 'fix' })
    await tryHandleApprovals(ctx)
    expect(out.body.mode).toBe('fix')
    expect(listApprovalVerifications(approval.id)[0]!.mode).toBe('fix')
    const prompt = getPendingMessages('gemma')[0]!.content
    expect(prompt).toContain('JAVITASI FELADAT')
    expect(prompt).not.toContain('CSAK-OLVASO')
    expect(prompt).toContain('szabad kezed van')
  })

  it('re-dispatching the same agent replaces the stored mode, never leaves a stale one', async () => {
    const approval = createApproval({ id: 'm4', agent_id: 'lackor2-bot', category: 'code_change', action_description: 'X' })
    await tryHandleApprovals(fakeReq('POST', `/api/approvals/${approval.id}/verify`, { agents: ['gemma'] }).ctx)
    expect(listApprovalVerifications(approval.id)[0]!.mode).toBe('verify')
    await tryHandleApprovals(fakeReq('POST', `/api/approvals/${approval.id}/verify`, { agents: ['gemma'], mode: 'fix' }).ctx)
    const rows = listApprovalVerifications(approval.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.mode).toBe('fix')
    expect(rows[0]!.status).toBe('pending')
  })
})

// --- the VS Code executor as a dispatch target ----------------------------
describe('dispatching to a VS Code (code-bridge) executor', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    runningAgents.clear()
    startAgentProcessMock.mockClear()
    liveTmuxSessions.clear()
    liveTmuxSessions.add('lackor2-bot-channels')
    existingAgentDirs.clear()
    resetCodeBridgeTablesForTests()
    upsertCodeSession({ project: 'someproject', workspacePath: 'C:\\ws\\someproject', sessionId: 'aaaaaaaa-0000-4000-8000-000000000001' })
  })

  it('queues a code task instead of an inter-agent message, and shows a pending row', async () => {
    const approval = createApproval({ id: 'c1', agent_id: 'lackor2-bot', category: 'code_change', action_description: 'X' })
    const { ctx, out } = fakeReq('POST', `/api/approvals/${approval.id}/verify`, { agents: ['code:someproject'], mode: 'fix' })
    await tryHandleApprovals(ctx)
    expect(out.body.dispatched).toEqual(['code:someproject'])
    expect(out.body.failed).toEqual([])
    // No sub-agent process was started -- a VS Code executor has none.
    expect(startAgentProcessMock).not.toHaveBeenCalled()

    const tasks = listCodeTasks({ project: 'someproject' })
    expect(tasks).toHaveLength(1)
    expect(tasks[0]!.prompt).toContain('JAVITASI FELADAT')
    // It has to report back under the SAME id the row was created with.
    expect(tasks[0]!.prompt).toContain('"agent":"code:someproject"')

    const rows = listApprovalVerifications(approval.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ agent: 'code:someproject', status: 'pending', mode: 'fix' })
  })

  it('says WHICH project is unknown instead of reporting a generic "agent not found"', async () => {
    const approval = createApproval({ id: 'c2', agent_id: 'lackor2-bot', category: 'code_change', action_description: 'X' })
    const { ctx, out } = fakeReq('POST', `/api/approvals/${approval.id}/verify`, { agents: ['code:nosuchproject'] })
    await tryHandleApprovals(ctx)
    expect(out.body.dispatched).toEqual([])
    expect(out.body.failed[0].agent).toBe('code:nosuchproject')
    expect(out.body.failed[0].error).toContain('nosuchproject')
    // No half-finished row left behind claiming a review is in progress.
    expect(listApprovalVerifications(approval.id)).toHaveLength(0)
  })

  it('the executor reports back through the ordinary verify-result endpoint', async () => {
    const approval = createApproval({ id: 'c3', agent_id: 'lackor2-bot', category: 'code_change', action_description: 'X' })
    await tryHandleApprovals(fakeReq('POST', `/api/approvals/${approval.id}/verify`, { agents: ['code:someproject'], mode: 'fix' }).ctx)
    const { ctx, out } = fakeReq('POST', `/api/approvals/${approval.id}/verify-result`, {
      agent: 'code:someproject', status: 'pass', report: 'megjavitva',
    })
    await tryHandleApprovals(ctx)
    expect(out.status).toBe(200)
    expect(out.body).toEqual({ ok: true })
    expect(listApprovalVerifications(approval.id)[0]).toMatchObject({ status: 'pass', mode: 'fix' })
  })
})
