// #943: the 3 s dashboard freeze of 2026-11-20 12:16. The stall sampler caught GET /api/approvals rebuilding a 500-row
// pool (SELECT * with big descriptions) on EVERY request, while 6 `claude auth status` children ran at once.
import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, createApproval, resolveApproval } from '../db.js'
import { approvedKanbanDonePool, _resetApprovedPoolCacheForTest } from '../web/routes/approvals.js'
import { mapLimit } from '../map-limit.js'

function approvedKanbanDone(id: string, card: string): void {
  createApproval({ id, agent_id: 'a', category: 'kanban_done', action_description: `Kártya (kanban-azonosító: ${card}) kész`, action_payload: JSON.stringify({ card_id: card }) })
  resolveApproval(id, 'approved', 'boss')
}

describe('#943 approvals pool is reused until an approved kanban_done row changes', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    _resetApprovedPoolCacheForTest()
  })

  it('returns the SAME pool object on repeated calls (no 500-row rebuild per request)', () => {
    approvedKanbanDone('ap1', 'c0000001')
    const first = approvedKanbanDonePool()
    expect(first.length).toBe(1)
    expect(approvedKanbanDonePool()).toBe(first)
  })

  it('rebuilds once a new approved kanban_done row appears', () => {
    approvedKanbanDone('ap1', 'c0000001')
    const first = approvedKanbanDonePool()
    approvedKanbanDone('ap2', 'c0000002')
    const second = approvedKanbanDonePool()
    expect(second).not.toBe(first)
    expect(second.length).toBe(2)
  })
})

describe('#943 mapLimit bounds concurrency (the `claude auth status` probes)', () => {
  it('never runs more than the limit at once and keeps the input order', async () => {
    let inFlight = 0
    let peak = 0
    const out = await mapLimit([1, 2, 3, 4, 5, 6], 2, async (n) => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight--
      return n * 10
    })
    expect(peak).toBe(2)
    expect(out).toEqual([10, 20, 30, 40, 50, 60])
  })
})
