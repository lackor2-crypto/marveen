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
import {
  ensureApprovalForWaitingCard, pendingApprovalForCard,
  withdrawApprovalForCardLeavingWaiting, reconcileWaitingApprovals,
} from '../web/routes/approvals.js'
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

/**
 * The other direction, added 2026-08-16. Boss counted the two pages against
 * each other: "a jovahagyasok menupont alatt 19 van soron ami jovahagyasra var.
 * de a kanban ban a varakozoban pedig kevesebb van. ennek a kettonek pontosan
 * ugyanannak a szamnak kellene lennie."
 *
 * He is right, and the mechanism only had an entering side -- so a card pulled
 * back to in_progress left its request pending forever. That is where the two
 * live orphans came from.
 */
describe('a card leaving waiting withdraws its own approval', () => {
  it('resolves the auto-raised request as WITHDRAWN, naming the new column', () => {
    card('bb66291d', 'Iroda nezet a Memoria oldalon', 'usalackor')
    const raised = ensureApprovalForWaitingCard('bb66291d', 'usalackor')
    expect(raised).not.toBeNull()

    const withdrawn = withdrawApprovalForCardLeavingWaiting('bb66291d', 'in_progress', 'Boss')
    expect(withdrawn).toBe(true)
    expect(pendingApprovalForCard('bb66291d')).toBeUndefined()

    const after = listApprovals({}).find(a => a.id === raised!.id)!
    // 'withdrawn', NOT 'timeout' (Boss 2026-09-03): nothing expired -- timeout_at
    // was null -- the card just moved, so labelling it "Lejárt" made a withdrawal
    // look like a spontaneous expiry. Not 'rejected' either: nobody judged the work.
    expect(after.status).toBe('withdrawn')
    expect(after.status).not.toBe('timeout')
    expect(after.resolution_reason).toContain('in_progress')
  })

  it('restores the invariant: withdrawn, then a fresh request when it returns', () => {
    card('cc77302e', 'Ide-oda huzogatott kartya', 'usalackor')
    const first = ensureApprovalForWaitingCard('cc77302e', 'usalackor')!
    withdrawApprovalForCardLeavingWaiting('cc77302e', 'in_progress', 'Boss')

    const second = ensureApprovalForWaitingCard('cc77302e', 'usalackor')!
    expect(second.id).not.toBe(first.id)
    expect(second.status).toBe('pending')
    // Exactly one open request at a time -- the whole point of the count match.
    expect(listApprovals({ status: 'pending' }).length).toBe(1)
  })

  it('leaves a pending request of another category alone', () => {
    card('dd88413f', 'Kartya sajat kulon keressel', 'usalackor')
    const other = createApproval({
      id: 'aaaaaaaa-0000-4000-8000-000000000001',
      agent_id: 'usalackor',
      category: 'file_write',
      action_description: 'Kartya dd88413f miatt fajlt irnek.',
      action_payload: JSON.stringify({ kanban_card_id: 'dd88413f' }),
      timeout_at: null,
    })

    expect(withdrawApprovalForCardLeavingWaiting('dd88413f', 'done', 'Boss')).toBe(false)
    const after = listApprovals({}).find(a => a.id === other.id)!
    expect(after.status).toBe('pending')
  })

  it('does nothing when the card has no pending request', () => {
    card('ee99524a', 'Sose volt varakozo', 'usalackor')
    expect(withdrawApprovalForCardLeavingWaiting('ee99524a', 'planned', 'Boss')).toBe(false)
  })
})


/**
 * The event handlers above only fire on the two HTTP routes. The stuck-task
 * watchdog moves cards through the db layer instead, and rows created before
 * either handler existed never saw one at all -- the live board had four such
 * cards when this was written. So the invariant is also re-established as a
 * whole, once a minute, in both directions.
 */
describe('reconcileWaitingApprovals -- the invariant checked as a whole', () => {
  function waitingCard(id: string, title: string) {
    createKanbanCard({ id, title, status: 'waiting', assignee: 'usalackor' })
  }

  it('raises a request for a waiting card that has none', () => {
    waitingCard('11aa22bb', 'Regota varakozik, sose kertek ra jovahagyast')
    expect(pendingApprovalForCard('11aa22bb')).toBeUndefined()

    expect(reconcileWaitingApprovals()).toEqual({ raised: 1, withdrawn: 0 })
    expect(pendingApprovalForCard('11aa22bb')).toBeDefined()
  })

  it('closes a request whose card already moved on to done', () => {
    createKanbanCard({ id: '33cc44dd', title: 'Mar kesz, megis kerdez', status: 'done', assignee: 'usalackor' })
    const stale = ensureApprovalForWaitingCard('33cc44dd', 'usalackor')!

    expect(reconcileWaitingApprovals()).toEqual({ raised: 0, withdrawn: 1 })
    const after = listApprovals({}).find(a => a.id === stale.id)!
    // 'withdrawn', not 'timeout': the reconcile withdraws a request whose card is
    // no longer waiting; it did not expire on a timer (Boss 2026-09-03).
    expect(after.status).toBe('withdrawn')
    expect(after.resolution_reason).toContain('done')
  })

  it('closes a request whose card no longer exists', () => {
    createApproval({
      id: 'aaaaaaaa-0000-4000-8000-000000000002',
      agent_id: 'usalackor',
      category: 'kanban_done',
      action_description: 'Kártya: torolt munka (55ee66ff) -- várakozóba került.',
      action_payload: JSON.stringify({ kanban_card_id: '55ee66ff' }),
      timeout_at: null,
    })
    expect(reconcileWaitingApprovals()).toEqual({ raised: 0, withdrawn: 1 })
    expect(listApprovals({ status: 'pending' }).length).toBe(0)
  })

  it('is a no-op when the board is already balanced', () => {
    waitingCard('77aa88bb', 'Varakozik, es van is kerese')
    ensureApprovalForWaitingCard('77aa88bb', 'usalackor')

    expect(reconcileWaitingApprovals()).toEqual({ raised: 0, withdrawn: 0 })
    expect(listApprovals({ status: 'pending' }).length).toBe(1)
  })

  it('never touches a pending request of another category', () => {
    createKanbanCard({ id: '99cc00dd', title: 'Folyamatban, sajat keressel', status: 'in_progress', assignee: 'usalackor' })
    createApproval({
      id: 'aaaaaaaa-0000-4000-8000-000000000003',
      agent_id: 'usalackor',
      category: 'file_write',
      action_description: 'Kartya 99cc00dd miatt fajlt irnek.',
      action_payload: JSON.stringify({ kanban_card_id: '99cc00dd' }),
      timeout_at: null,
    })

    expect(reconcileWaitingApprovals()).toEqual({ raised: 0, withdrawn: 0 })
    expect(listApprovals({ status: 'pending' }).length).toBe(1)
  })

  it('leaves the counts equal after a mixed, messy board', () => {
    waitingCard('a1b2c3d4', 'Varakozik keres nelkul')
    waitingCard('b2c3d4e5', 'Varakozik, lesz kerese')
    createKanbanCard({ id: 'c3d4e5f6', title: 'Visszahuzott kartya', status: 'in_progress', assignee: 'usalackor' })
    ensureApprovalForWaitingCard('b2c3d4e5', 'usalackor')
    ensureApprovalForWaitingCard('c3d4e5f6', 'usalackor')   // arva: mar nem varakozik

    reconcileWaitingApprovals()

    const pending = listApprovals({ status: 'pending' })
    // Ez az a ket szam, aminek Boss szerint egyeznie kell.
    expect(pending.length).toBe(2)
    expect(pending.every(a => ['a1b2c3d4', 'b2c3d4e5'].includes(
      approvalCardId(a.action_payload, a.action_description)!))).toBe(true)
  })
})

/**
 * The watchdog parks a possibly-stuck task in waiting. It must still raise a
 * request (the invariant), but must NOT claim the work is finished.
 */
describe('a sajat szoveggel kert jovahagyas', () => {
  it('uses the caller wording instead of the "work is finished" default', () => {
    card('d4e5f607', 'Arany elemzes 30 perc', 'usalackor')
    const a = ensureApprovalForWaitingCard('d4e5f607', 'scheduler', 'Beakadhatott ütemezett feladat: 45 perce fut.')!
    expect(a.action_description).toBe('Beakadhatott ütemezett feladat: 45 perce fut.')
    expect(a.action_description).not.toContain('elkészült')
  })

  it('falls back to the default wording when none is given', () => {
    card('e5f60718', 'Sima kesz munka', 'usalackor')
    const a = ensureApprovalForWaitingCard('e5f60718', 'usalackor')!
    expect(a.action_description).toContain('elkészült')
  })

  it('ignores a blank override rather than filing an empty description', () => {
    card('f6071829', 'Ures szoveggel kert', 'usalackor')
    const a = ensureApprovalForWaitingCard('f6071829', 'usalackor', '   ')!
    expect(a.action_description).toContain('elkészült')
  })
})
