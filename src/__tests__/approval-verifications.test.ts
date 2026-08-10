import { describe, it, expect, beforeEach, vi } from 'vitest'
import { initDatabase, createApproval, createKanbanCard, getKanbanComments } from '../db.js'

vi.mock('../config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../config.js')>()
  return { ...real, MAIN_AGENT_ID: 'lackor2-bot' }
})

const runningAgents = new Set<string>()
vi.mock('../web/agent-process.js', () => ({
  isAgentRunning: (name: string) => runningAgents.has(name),
  startAgentProcess: vi.fn((name: string) => { runningAgents.add(name); return { ok: true, pid: 1 } }),
}))

const existingAgentDirs = new Set<string>()
vi.mock('../web/agent-config.js', () => ({
  agentDir: (name: string) => `/fake/agents/${name}`,
  // Non-free default: keeps these tests' dispatch timing unaffected by the
  // free-tier throttle added in src/web/routes/approvals.ts (kanban 45c3cfad).
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

import { tryHandleApprovals } from '../web/routes/approvals.js'
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
    existingAgentDirs.clear()
    existingAgentDirs.add('gemma')
    existingAgentDirs.add('north')
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
