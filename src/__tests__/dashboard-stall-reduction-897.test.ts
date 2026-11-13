/**
 * Dashboard freeze follow-up (#897): the event loop must not be held by work that grows with the board,
 * and the background polls run at a third of the old rate (Boss, TG 6118: "vedd vissza a kis pingeket").
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { initDatabase, createKanbanCard } from '../db.js'
import * as db from '../db.js'
import { reconcileWaitingApprovals } from '../web/routes/approvals.js'

const root = join(__dirname, '..', '..')

describe('reconcileWaitingApprovals reads the open requests once per pass', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('does not re-read the approvals table once per waiting card', () => {
    for (let i = 0; i < 12; i++) createKanbanCard({ id: `c${String(i).padStart(7, '0')}`, title: `card ${i}`, status: 'waiting' })
    const spy = vi.spyOn(db, 'listPendingApprovals')
    reconcileWaitingApprovals()
    // 12 waiting cards: one read for matching, one for the withdraw loop -- never 12+.
    // (raising an approval for a card with none reads inside ensureApprovalForWaitingCard; that is the
    // exceptional path, so seed the cards first and allow for it.)
    const first = spy.mock.calls.length
    spy.mockClear()
    reconcileWaitingApprovals() // steady state: every card already has its request
    expect(spy.mock.calls.length).toBeLessThanOrEqual(2)
    expect(first).toBeGreaterThanOrEqual(1)
  })
})

describe('background polls are slowed to a third', () => {
  const app = readFileSync(join(root, 'web/app.js'), 'utf8')
  it('3 s / 4 s / 5 s polls are now 9 s / 12 s / 15 s', () => {
    expect(app).toContain('activityTimer = setInterval(loadActivity, 9000)')
    expect(app).toContain('refreshAgentTerminalBusy() }, 9000)')
    expect(app).toContain('setInterval(refreshRunningIndicators, 12000)')
    expect(app).toContain('_cbTimer = setInterval(cbRefresh, 15000)')
    expect(app).toContain('void _dupRefreshStatus() }, 9000)')
    expect(app).not.toContain('setInterval(loadActivity, 3000)')
  })
})

describe('code-bridge activity reads the long text of one row only', () => {
  const src = readFileSync(join(root, 'src/web/code-bridge-store.ts'), 'utf8')
  it('the ordering statement does not select summary/error, and finished_at is indexed', () => {
    expect(src).toContain('idx_code_tasks_finished ON code_tasks(finished_at)')
    expect(src).not.toMatch(/SELECT status, summary, error, finished_at FROM code_tasks/)
  })
})
