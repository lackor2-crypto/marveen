// Boss's rule, 2026-08-16 (Telegram): the number of cards in the kanban
// `waiting` column must equal the number of approvals in `pending`, and every
// waiting card must actually have its own approval.
//
// "csak ugy mondanam hogy a varakozoban sokkal tobb varakozik mint ami fel lett
// adva a jovahagyasokba. tehat . szabaly. a varakozoban levo elemek szamanak
// meg kell egyeznie pontosan mint a jovahagyasban levo varakozo statusz
// szamaval."
//
// The measured state when he said it: 11 waiting cards, 5 pending approvals,
// only 4 of which paired up. A card in `waiting` means the work is finished and
// somebody has to decide; a waiting card with no approval is work parked in
// silence, and an approval whose card is not waiting is a question about
// something still being worked on.
//
// What is tested here is the DECISION, not the board: the pure function that
// the audit sweep and the dashboard both ask. The live board is checked by
// scripts/kanban-audit.sh calling the same logic, because a test that asserts on
// live data would go red for a state the code is not responsible for.

import { describe, it, expect } from 'vitest'
import { waitingApprovalBalance } from '../kanban-related.js'
import type { BalanceApproval, BalanceCard } from '../kanban-related.js'

const card = (id: string, status: string, seq = 1, title = 'valami'): BalanceCard =>
  ({ id, status, seq, title })

const payloadApproval = (id: string, cardId: string, status = 'pending'): BalanceApproval =>
  ({ id, status, action_payload: JSON.stringify({ kanban_card_id: cardId }), action_description: 'Kartya kesz' })

const textApproval = (id: string, cardId: string, status = 'pending'): BalanceApproval =>
  ({ id, status, action_description: `Kártya: valami (${cardId}) -- várakozóba került.` })

describe('waitingApprovalBalance', () => {
  it('is balanced when every waiting card has its own pending approval', () => {
    const cards = [card('aaaaaaaa', 'waiting'), card('bbbbbbbb', 'waiting'), card('cccccccc', 'in_progress')]
    const approvals = [payloadApproval('ap1', 'aaaaaaaa'), payloadApproval('ap2', 'bbbbbbbb')]

    const r = waitingApprovalBalance(cards, approvals)
    expect(r).toMatchObject({ waitingCount: 2, pendingCount: 2, balanced: true })
    expect(r.waitingWithoutApproval).toEqual([])
    expect(r.pendingWithoutWaitingCard).toEqual([])
  })

  it('names the waiting cards nobody is being asked about', () => {
    // The exact shape Boss caught: more waiting than pending.
    const cards = [card('aaaaaaaa', 'waiting'), card('bbbbbbbb', 'waiting'), card('dddddddd', 'waiting')]
    const approvals = [payloadApproval('ap1', 'aaaaaaaa')]

    const r = waitingApprovalBalance(cards, approvals)
    expect(r.balanced).toBe(false)
    expect(r.waitingCount).toBe(3)
    expect(r.pendingCount).toBe(1)
    expect(r.waitingWithoutApproval.map(c => c.id)).toEqual(['bbbbbbbb', 'dddddddd'])
  })

  // The false alarm this exists to prevent: an approval written by hand carries
  // the card id only in the description. Matching on action_payload alone
  // reported such a card as an orphan while measuring the live imbalance, and
  // nearly produced a duplicate approval for a card that already had one.
  it('pairs an approval that carries the card id only in its description text', () => {
    const cards = [card('184aff52', 'waiting')]
    const approvals = [textApproval('ap-text', '184aff52')]

    const r = waitingApprovalBalance(cards, approvals)
    expect(r.balanced).toBe(true)
    expect(r.waitingWithoutApproval).toEqual([])
  })

  it('matches a truncated 8-hex reference against the full card id', () => {
    const cards = [card('184aff52-2f0e-4d34-9c66-1f0b8b7cd1aa', 'waiting')]
    const approvals = [textApproval('ap-text', '184aff52')]

    expect(waitingApprovalBalance(cards, approvals).balanced).toBe(true)
  })

  it('ignores approvals that are already decided', () => {
    const cards = [card('aaaaaaaa', 'waiting')]
    const approvals = [
      payloadApproval('ap-old', 'aaaaaaaa', 'approved'),
      payloadApproval('ap-old2', 'aaaaaaaa', 'rejected'),
    ]

    const r = waitingApprovalBalance(cards, approvals)
    expect(r.pendingCount).toBe(0)
    expect(r.waitingWithoutApproval.map(c => c.id)).toEqual(['aaaaaaaa'])
  })

  // The other direction, which the count-only reading of the rule would miss:
  // the two numbers can be equal while nothing lines up.
  it('flags a pending approval whose card is no longer waiting', () => {
    const cards = [card('aaaaaaaa', 'waiting'), card('bbbbbbbb', 'in_progress')]
    const approvals = [payloadApproval('ap-wrong', 'bbbbbbbb')]

    const r = waitingApprovalBalance(cards, approvals)
    expect(r.waitingCount).toBe(1)
    expect(r.pendingCount).toBe(1)
    expect(r.balanced).toBe(false)
    expect(r.pendingWithoutWaitingCard).toEqual([
      { approval: approvals[0], cardId: 'bbbbbbbb', reason: 'card-not-waiting', cardStatus: 'in_progress' },
    ])
    expect(r.waitingWithoutApproval.map(c => c.id)).toEqual(['aaaaaaaa'])
  })

  it('flags a pending approval that references no card at all', () => {
    const approvals: BalanceApproval[] = [{ id: 'ap-none', status: 'pending', action_description: 'Email kikuldes' }]

    const r = waitingApprovalBalance([], approvals)
    expect(r.balanced).toBe(false)
    expect(r.pendingWithoutWaitingCard[0]).toMatchObject({ cardId: null, reason: 'no-card' })
  })

  it('flags a pending approval whose card is not on the board any more', () => {
    const r = waitingApprovalBalance([card('aaaaaaaa', 'waiting')], [
      payloadApproval('ap1', 'aaaaaaaa'),
      payloadApproval('ap-ghost', 'ffffffff'),
    ])
    expect(r.pendingWithoutWaitingCard).toEqual([
      { approval: expect.objectContaining({ id: 'ap-ghost' }), cardId: 'ffffffff', reason: 'unknown-card' },
    ])
  })

  it('an empty board is balanced, not an alert', () => {
    expect(waitingApprovalBalance([], [])).toMatchObject({ waitingCount: 0, pendingCount: 0, balanced: true })
  })

  it('two approvals on the same waiting card leave the counts unequal, and it shows', () => {
    // Idempotency is enforced elsewhere; if it ever slips, the rule must not
    // report "balanced" just because both approvals found their card.
    const r = waitingApprovalBalance([card('aaaaaaaa', 'waiting')], [
      payloadApproval('ap1', 'aaaaaaaa'),
      payloadApproval('ap2', 'aaaaaaaa'),
    ])
    expect(r.waitingCount).toBe(1)
    expect(r.pendingCount).toBe(2)
    expect(r.waitingCount === r.pendingCount).toBe(false)
  })

  it('done and archived cards never count as waiting', () => {
    const cards = [card('aaaaaaaa', 'done'), card('bbbbbbbb', 'planned'), card('cccccccc', 'waiting')]
    const r = waitingApprovalBalance(cards, [payloadApproval('ap1', 'cccccccc')])
    expect(r.waitingCount).toBe(1)
    expect(r.balanced).toBe(true)
  })
})
