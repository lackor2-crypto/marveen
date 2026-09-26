// #404 H2: a jovahagyott Munkapad-lepes a TAROLT bemenettel lefut, egy "igen"
// egy futas, elutasitasnal a beszelgetes ertesul.
import { describe, it, expect, beforeEach, vi } from 'vitest'

const ran: { name: string; input: Record<string, unknown> }[] = []
vi.mock('../workbench-agent/execute.js', () => ({
  runTool: async (name: string, input: Record<string, unknown>) => {
    ran.push({ name, input })
    if (input.fail) return { ok: false, code: 'failed', detail: 'lemez tele' }
    return { ok: true, data: { written: input.path } }
  },
}))

import { initDatabase, createApproval, resolveApproval } from '../db.js'
import { createProject } from '../projects.js'
import { settleWorkbenchApprovals, targetOf } from '../workbench-agent/approved-runner.js'
import {
  createAgentSession, finishToolCall, isApprovalConsumed, listAgentMessages, listToolCalls, projectSessionKey, startToolCall,
} from '../workbench-agent/sessions.js'

let projectId = ''
let sessionId = ''

function awaiting(input: Record<string, unknown>, id: string): string {
  createApproval({ id, agent_id: 'main', category: 'workbench_file_write', action_description: 'x', action_payload: null })
  const row = startToolCall(sessionId, 'file.write', input)
  finishToolCall(row.id, 'needs_approval', { approvalId: id }, id)
  return row.id
}

beforeEach(() => {
  initDatabase(':memory:')
  ran.length = 0
  const p = createProject({ name: 'Teszt' })
  if (!p.ok) throw new Error('projekt')
  projectId = p.project.id
  sessionId = createAgentSession({ project_id: projectId, work_item_id: projectSessionKey(projectId), language: 'hu' }).id
})

describe('settleWorkbenchApprovals', () => {
  it('fuggo jovahagyasnal semmi nem fut', async () => {
    awaiting({ path: 'a.txt', content: 'x' }, 'ap-1')
    expect(await settleWorkbenchApprovals()).toBe(0)
    expect(ran).toHaveLength(0)
  })

  it('jovahagyas utan a TAROLT bemenettel fut le, egyszer, es a csevegobe kerul', async () => {
    const long = 'hosszú szöveg '.repeat(500)
    const rowId = awaiting({ path: 'ajanlat.md', content: long }, 'ap-2')
    resolveApproval('ap-2', 'approved', 'owner')
    expect(await settleWorkbenchApprovals()).toBe(1)
    expect(ran).toEqual([{ name: 'file.write', input: { path: 'ajanlat.md', content: long } }])
    expect(listToolCalls(sessionId).find((r) => r.id === rowId)?.status).toBe('ok')
    expect(isApprovalConsumed('ap-2')).toBe(true)
    const last = listAgentMessages(sessionId).at(-1)!
    expect(last.role).toBe('assistant')
    expect(last.content).toContain('ajanlat.md')
    // Masodszor mar nincs mit futtatni: egy igen = egy futas.
    expect(await settleWorkbenchApprovals()).toBe(0)
    expect(ran).toHaveLength(1)
  })

  it('parhuzamos feldolgozasnal is csak egyszer fut', async () => {
    awaiting({ path: 'b.txt' }, 'ap-3')
    resolveApproval('ap-3', 'approved', 'owner')
    await Promise.all([settleWorkbenchApprovals(), settleWorkbenchApprovals(sessionId)])
    expect(ran).toHaveLength(1)
  })

  it('elutasitasnal nem fut, de a csevego ertesul', async () => {
    const rowId = awaiting({ path: 'c.txt' }, 'ap-4')
    resolveApproval('ap-4', 'rejected', 'owner')
    expect(await settleWorkbenchApprovals()).toBe(1)
    expect(ran).toHaveLength(0)
    expect(listToolCalls(sessionId).find((r) => r.id === rowId)?.status).toBe('rejected')
    expect(listAgentMessages(sessionId).at(-1)!.content).toMatch(/nem hagytad jóvá/)
  })

  it('a futas hibaja emberi mondat a csevegoben, a jegy nem hasznalodik el', async () => {
    awaiting({ path: 'd.txt', fail: true }, 'ap-5')
    resolveApproval('ap-5', 'approved', 'owner')
    await settleWorkbenchApprovals()
    expect(listAgentMessages(sessionId).at(-1)!.content).toContain('lemez tele')
    expect(isApprovalConsumed('ap-5')).toBe(false)
  })

  it('a cel emberi nyelven', () => {
    expect(targetOf({ path: 'x.md' })).toBe(' — x.md')
    expect(targetOf({})).toBe('')
  })
})
