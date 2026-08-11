/**
 * Moving a card into `waiting` must raise the approval by itself.
 *
 * Boss, 2026-08-11, after being shown four waiting cards nobody was being asked
 * about: "ha mar egyszer bekerult a varakozo kanban dobozba akkor mar bent
 * kellene lennie a jovairasokban!!! az hogy betesz barki barmit a varakozoba,
 * az valtja ki hogy a jovairasba is bekeruljon!" -- plus the semantics that
 * make it true: "es akor kerulhet be a varakozoba ha a kartya keszen van!".
 *
 * `waiting` therefore means "finished, awaiting Boss". The old design made the
 * move and the request two separate actions, and the second one is the one
 * that got forgotten -- four times on the live board. These tests pin that it
 * is now one action, and that repeating it does not pile up duplicates.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, createKanbanCard, createApproval, listApprovals, resolveApproval } from '../db.js'
import { ensureApprovalForWaitingCard, pendingApprovalForCard } from '../web/routes/approvals.js'
import { approvalCardId } from '../kanban-related.js'

beforeEach(() => {
  initDatabase(':memory:')
})

function card(id: string, title: string, assignee?: string) {
  createKanbanCard({ id, title, status: 'in_progress', assignee })
}

describe('approvalCardId', () => {
  it('prefers the structured payload', () => {
    expect(approvalCardId('{"kanban_card_id":"aa55180c"}', 'no id here')).toBe('aa55180c')
  })

  it('falls back to an 8-hex id in the description', () => {
    expect(approvalCardId(null, 'Kártya: valami (fc904177) kész.')).toBe('fc904177')
  })

  it('returns null when the approval names no card', () => {
    expect(approvalCardId(null, 'Email kiküldése Bossnak.')).toBeNull()
  })

  it('is not fooled by a malformed payload', () => {
    // Must fall through to the text rather than throwing -- a broken payload
    // should degrade to the weaker match, not take the endpoint down.
    expect(approvalCardId('{not json', 'Kártya fc904177 kész.')).toBe('fc904177')
  })
})

describe('a card entering waiting raises its own approval', () => {
  it('creates a pending kanban_done approval linked to the card', () => {
    card('aa55180c', 'Fajlbongeszo a dashboardon', 'usalackor')
    const raised = ensureApprovalForWaitingCard('aa55180c', 'usalackor')

    expect(raised).not.toBeNull()
    expect(raised!.category).toBe('kanban_done')
    expect(raised!.status).toBe('pending')
    expect(raised!.agent_id).toBe('usalackor')
    // The payload link is what makes Boss's approve button move the card, and
    // what the verification flow writes its report against.
    expect(approvalCardId(raised!.action_payload, raised!.action_description)).toBe('aa55180c')
  })

  it('says in the text that a human still has to fill in what was tested', () => {
    // An auto-raised request cannot know how the work was verified. It must not
    // read as if it did, or Boss approves on a description nobody wrote.
    card('aa55180c', 'Fajlbongeszo a dashboardon')
    const raised = ensureApprovalForWaitingCard('aa55180c', null)
    expect(raised!.action_description).toMatch(/automatikusan/)
  })

  it('falls back to the assignee when the mover is not named', () => {
    card('aa55180c', 'Fajlbongeszo a dashboardon', 'usalackor')
    expect(ensureApprovalForWaitingCard('aa55180c', null)!.agent_id).toBe('usalackor')
  })

  it('does not raise a second one when the card already has a pending request', () => {
    // Dragging a card out of waiting and back is normal board fidgeting; it
    // must not cost Boss a new decision each time.
    card('aa55180c', 'Fajlbongeszo a dashboardon')
    ensureApprovalForWaitingCard('aa55180c', 'usalackor')
    expect(ensureApprovalForWaitingCard('aa55180c', 'usalackor')).toBeNull()
    expect(listApprovals({ status: 'pending' })).toHaveLength(1)
  })

  it('does not duplicate an approval an agent filed by hand', () => {
    card('aa55180c', 'Fajlbongeszo a dashboardon')
    createApproval({
      id: 'ap-manual',
      agent_id: 'usalackor',
      category: 'kanban_done',
      action_description: 'Kártya: Fajlbongeszo (aa55180c) -- kész, élesben tesztelve.',
      action_payload: JSON.stringify({ kanban_card_id: 'aa55180c' }),
    })
    expect(ensureApprovalForWaitingCard('aa55180c', 'usalackor')).toBeNull()
    expect(listApprovals({ status: 'pending' })).toHaveLength(1)
  })

  it('ignores a card id that is not on the board', () => {
    expect(ensureApprovalForWaitingCard('deadbeef', 'usalackor')).toBeNull()
    expect(listApprovals({ status: 'pending' })).toHaveLength(0)
  })

  it('raises again once the earlier request has been resolved', () => {
    // A resolved approval is not an open question. If the card comes back to
    // waiting afterwards, Boss has to be asked anew.
    card('aa55180c', 'Fajlbongeszo a dashboardon')
    const first = ensureApprovalForWaitingCard('aa55180c', 'usalackor')!
    resolveApproval(first.id, 'rejected', 'Boss')
    expect(ensureApprovalForWaitingCard('aa55180c', 'usalackor')).not.toBeNull()
  })
})

describe('pendingApprovalForCard', () => {
  it('finds the request whether the card is named in the payload or the text', () => {
    card('aa55180c', 'Fajlbongeszo a dashboardon')
    createApproval({
      id: 'ap-text',
      agent_id: 'usalackor',
      category: 'kanban_done',
      action_description: 'Kártya aa55180c kész.',
    })
    expect(pendingApprovalForCard('aa55180c')?.id).toBe('ap-text')
  })

  it('does not match a different card', () => {
    card('aa55180c', 'Fajlbongeszo a dashboardon')
    createApproval({
      id: 'ap-other',
      agent_id: 'usalackor',
      category: 'kanban_done',
      action_payload: JSON.stringify({ kanban_card_id: 'fc904177' }),
      action_description: 'Masik kartya.',
    })
    expect(pendingApprovalForCard('aa55180c')).toBeUndefined()
  })
})
