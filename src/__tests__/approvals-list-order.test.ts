// A "Jovahagyottak" listaja a DONTES ideje szerint rendez (legfrissebb dontes
// felul), nem az erkezes szerint -- hogy a tulajdonos epp meghozott dontese a
// lista tetejere kerul (Boss, 2026-09-27: "amit en a jovahagyasok alatt
// kattintok az mindig legfelulre kerul"). A pending lista sorrendje valtozatlan.
import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, createApproval, resolveApproval, listApprovals, getDb } from '../db.js'

beforeEach(() => {
  initDatabase(':memory:')
})

function mk(id: string, requestedAt: number): void {
  createApproval({
    id, agent_id: 'a', category: 'kanban_done',
    action_description: id, action_payload: null, timeout_at: null,
  })
  getDb().prepare('UPDATE approvals SET requested_at = ? WHERE id = ?').run(requestedAt, id)
}

function decideAt(id: string, resolvedAt: number): void {
  resolveApproval(id, 'approved', 'dashboard')
  getDb().prepare('UPDATE approvals SET resolved_at = ? WHERE id = ?').run(resolvedAt, id)
}

describe('listApprovals rendezes', () => {
  it('a jovahagyott sorok a DONTES ideje szerint jonnek (legfrissebb elol)', () => {
    // Erkezes: A a legregebbi, C a legujabb.
    mk('A', 1000); mk('B', 2000); mk('C', 3000)
    // Dontes MAS sorrendben: B-t dontottuk el utoljara.
    decideAt('A', 5000); decideAt('C', 6000); decideAt('B', 9000)

    const order = listApprovals({ status: 'approved' }).map(a => a.id)
    // Dontes szerint: B(9000) > C(6000) > A(5000). Erkezes szerint C,B,A lenne.
    expect(order).toEqual(['B', 'C', 'A'])
  })

  it('a pending sorok tovabbra is az erkezes szerint jonnek (nincs resolved_at)', () => {
    mk('P1', 1000); mk('P2', 2000); mk('P3', 3000)
    const order = listApprovals({ status: 'pending' }).map(a => a.id)
    expect(order).toEqual(['P3', 'P2', 'P1'])
  })
})
