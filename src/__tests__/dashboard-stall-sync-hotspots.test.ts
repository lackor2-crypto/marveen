// Dashboard freezes (Boss TG 6333, 3.1-3.2 s warnings): three synchronous hot spots named by the stall sampler
// (store/event-loop-stalls.jsonl). Each is pinned here so it cannot creep back:
//   1. the code-bridge verification sweep / approval cancel pulled 200 task rows through JS per pending row;
//   2. the approvals list re-parsed every pool row's card id for every listed row (quadratic);
//   3. the agent summary forked a tmux capture on the event loop when its cached pane was 5 s old.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const calls = { n: 0 }
vi.mock('../kanban-related.js', async (orig) => {
  const real = await orig<typeof import('../kanban-related.js')>()
  return { ...real, approvalCardId: (...a: Parameters<typeof real.approvalCardId>) => { calls.n++; return real.approvalCardId(...a) } }
})

import { initDatabase, createKanbanCard, createApproval, resolveApproval, moveKanbanCard, listApprovals } from '../db.js'
import { approvalUndoBlock } from '../web/routes/approvals.js'
import {
  resetCodeBridgeTablesForTests, upsertCodeSession, enqueueCodeTask, listCodeTasks,
} from '../web/code-bridge-store.js'

beforeEach(() => {
  initDatabase(':memory:')
  resetCodeBridgeTablesForTests()
  calls.n = 0
})

describe('listCodeTasks filters in SQL', () => {
  it('keeps only the rows whose prompt holds the text, from the given origin and time', () => {
    upsertCodeSession({ project: 'marvin', workspacePath: 'C:\\ws\\marvin', sessionId: 'aaaaaaaa-0000-4000-8000-000000000001' })
    const mk = (prompt: string, origin: 'dashboard' | 'api') => {
      const out = enqueueCodeTask({ project: 'marvin', prompt, origin })
      if ('error' in out) throw new Error(out.error)
      return out.task
    }
    mk('verify appr-AAA please', 'dashboard')
    mk('something else', 'dashboard')
    mk('verify appr-AAA via api', 'api')
    expect(listCodeTasks({ project: 'marvin', limit: 200 }).length).toBe(3)
    expect(listCodeTasks({ project: 'marvin', limit: 200, promptIncludes: 'appr-AAA' }).length).toBe(2)
    expect(listCodeTasks({ project: 'marvin', limit: 200, promptIncludes: 'appr-AAA', origin: 'dashboard' }).length).toBe(1)
    expect(listCodeTasks({ project: 'marvin', limit: 200, createdAtFrom: Date.now() + 60_000 }).length).toBe(0)
    expect(listCodeTasks({ project: 'marvin', limit: 200, promptIncludes: 'no-such-text' }).length).toBe(0)
  })
})

describe('approvalUndoBlock over a shared pool', () => {
  function approved(i: number): void {
    const id = 'c' + String(i).padStart(7, '0')
    createKanbanCard({ id, title: 'T' + i, status: 'waiting', assignee: 'szakerto' })
    createApproval({ id: 'a-' + i, agent_id: 'szakerto', category: 'kanban_done', action_description: 'k',
      action_payload: JSON.stringify({ kanban_card_id: id }), timeout_at: null })
    resolveApproval('a-' + i, 'approved', 'dashboard')
    moveKanbanCard(id, 'done', 0, 'dashboard')
  }

  it('derives each pool row card id once, not once per asked row (linear, not quadratic)', () => {
    for (let i = 0; i < 40; i++) approved(i)
    const pool = listApprovals({ category: 'kanban_done', status: 'approved', limit: 500 })
    expect(pool.length).toBe(40)
    calls.n = 0
    for (const a of pool) approvalUndoBlock(a, pool)
    // one id lookup per asked row + one per pool row; the old pairwise scan made 40 * 40 more
    expect(calls.n).toBeLessThanOrEqual(pool.length * 2 + 5)
  })

  it('still blocks an older decision when a newer one exists for the same card', () => {
    approved(1)
    createApproval({ id: 'a-1b', agent_id: 'szakerto', category: 'kanban_done', action_description: 'k',
      action_payload: JSON.stringify({ kanban_card_id: 'c0000001' }), timeout_at: null })
    resolveApproval('a-1b', 'approved', 'dashboard')
    const pool = listApprovals({ category: 'kanban_done', status: 'approved', limit: 500 })
    const older = pool.find(a => a.id === 'a-1')!
    const newer = pool.find(a => a.id === 'a-1b')!
    // force a strictly later resolution time on the newer row
    older.resolved_at = 100
    newer.resolved_at = 200
    expect(approvalUndoBlock(older, pool)).toBe('not_latest')
    expect(approvalUndoBlock(newer, pool)).toBeNull()
  })
})

describe('agent summary pane read', () => {
  it('never forks a synchronous tmux capture for a stale cached pane', () => {
    const src = readFileSync(join(__dirname, '..', 'web', 'routes', 'agents.ts'), 'utf8')
    const body = src.slice(src.indexOf('function summaryPane('), src.indexOf('// Resolve an agent\'s run state'))
    expect(body).not.toMatch(/getWithin\(/)
    expect(body).toMatch(/capturePaneAsync\(/)
  })
})
