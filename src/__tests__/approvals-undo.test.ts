// #430 -- an approval clicked by mistake can be taken back (owner 2026-09-27:
// "egy visszagomb a jóváhagyásokban mindenféleképpen kell").
//
// Only an approved kanban_done decision qualifies, only its latest one, and
// only while the card still sits in done: then the card goes back to waiting,
// the old row becomes 'withdrawn' with its history in the reason, and a fresh
// pending request with the ORIGINAL description is opened.

import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  initDatabase, createKanbanCard, createApproval, resolveApproval, getApproval,
  getKanbanCard, moveKanbanCard, listPendingApprovals, getKanbanComments, getDb,
} from '../db.js'
import { undoApprovedDecision, approvalUndoBlock } from '../web/routes/approvals.js'

beforeEach(() => {
  initDatabase(':memory:')
})

function approvedCard(cardId: string, approvalId: string, desc = 'Kártya #7 kész: PR #99') {
  createKanbanCard({ id: cardId, title: 'Probe', status: 'waiting', assignee: 'szakerto' })
  createApproval({
    id: approvalId, agent_id: 'szakerto', category: 'kanban_done',
    action_description: desc, action_payload: JSON.stringify({ kanban_card_id: cardId }), timeout_at: null,
  })
  resolveApproval(approvalId, 'approved', 'dashboard')
  moveKanbanCard(cardId, 'done', 0, 'dashboard')
}

describe('undoApprovedDecision', () => {
  it('puts the card back to waiting and reopens the request with the original text', () => {
    approvedCard('card0001', 'appr-1')
    const r = undoApprovedDecision('appr-1', 'dashboard')
    expect(r.ok).toBe(true)
    expect(getKanbanCard('card0001')!.status).toBe('waiting')
    const old = getApproval('appr-1')!
    expect(old.status).toBe('withdrawn')
    expect(old.resolution_reason).toContain('Visszavonva')
    const pending = listPendingApprovals().filter(a => a.category === 'kanban_done')
    expect(pending).toHaveLength(1)
    expect(pending[0].action_description).toBe('Kártya #7 kész: PR #99')
    expect(pending[0].agent_id).toBe('szakerto')
    expect(getKanbanComments('card0001').some(c => c.content.includes('Jóváhagyás visszavonva'))).toBe(true)
  })

  it('a second click changes nothing', () => {
    approvedCard('card0002', 'appr-2')
    expect(undoApprovedDecision('appr-2', 'dashboard').ok).toBe(true)
    expect(undoApprovedDecision('appr-2', 'dashboard')).toEqual({ ok: false, block: 'not_approved' })
    expect(listPendingApprovals().filter(a => a.category === 'kanban_done')).toHaveLength(1)
  })

  it('refuses when the card has moved on since', () => {
    approvedCard('card0003', 'appr-3')
    moveKanbanCard('card0003', 'planned', 0, 'x')
    expect(undoApprovedDecision('appr-3', 'dashboard')).toEqual({ ok: false, block: 'card_not_done' })
    expect(getApproval('appr-3')!.status).toBe('approved')
  })

  it('refuses an archived card', () => {
    approvedCard('card0004', 'appr-4')
    getDb().prepare("UPDATE kanban_cards SET archived_at = 1 WHERE id = 'card0004'").run()
    expect(approvalUndoBlock(getApproval('appr-4'))).toBe('card_not_done')
  })

  it('refuses other categories: their action may already have happened', () => {
    createApproval({ id: 'mail-1', agent_id: 'x', category: 'email_send', action_description: 'levél', timeout_at: null })
    resolveApproval('mail-1', 'approved', 'dashboard')
    expect(undoApprovedDecision('mail-1', 'dashboard')).toEqual({ ok: false, block: 'not_kanban' })
    expect(getApproval('mail-1')!.status).toBe('approved')
  })

  it('refuses pending/rejected rows and unknown ids', () => {
    createKanbanCard({ id: 'card0005', title: 'P', status: 'waiting' })
    createApproval({ id: 'p-1', agent_id: 'x', category: 'kanban_done', action_description: 'd', action_payload: '{"kanban_card_id":"card0005"}', timeout_at: null })
    expect(approvalUndoBlock(getApproval('p-1'))).toBe('not_approved')
    expect(undoApprovedDecision('nope', 'dashboard')).toEqual({ ok: false, block: 'not_found' })
  })

  it('only the latest approval of a card can be undone', () => {
    approvedCard('card0006', 'old-1')
    const db = getDb()
    db.prepare("UPDATE approvals SET resolved_at = resolved_at - 100 WHERE id = 'old-1'").run()
    createApproval({ id: 'new-1', agent_id: 'x', category: 'kanban_done', action_description: 'd', action_payload: '{"kanban_card_id":"card0006"}', timeout_at: null })
    resolveApproval('new-1', 'approved', 'dashboard')
    expect(approvalUndoBlock(getApproval('old-1'))).toBe('not_latest')
    expect(approvalUndoBlock(getApproval('new-1'))).toBeNull()
  })
})

describe('Approvals page wiring', () => {
  const app = readFileSync(join(__dirname, '..', '..', 'web', 'app.js'), 'utf8')
  const route = readFileSync(join(__dirname, '..', 'web', 'routes', 'approvals.ts'), 'utf8')
  it('the button shows on server-marked rows, asks first, and calls the undo endpoint', () => {
    expect(route).toMatch(/undoable: a\.status === 'approved'/)
    expect(app).toContain('a.undoable')
    expect(app).toContain("window.confirm(t('approvals.undo.confirm'))")
    expect(app).toContain('/undo`')
  })
  it('every refusal code has a sentence in both languages', () => {
    const hu = readFileSync(join(__dirname, '..', '..', 'web', 'lang', 'hu.js'), 'utf8')
    const en = readFileSync(join(__dirname, '..', '..', 'web', 'lang', 'en.js'), 'utf8')
    for (const code of ['not_found', 'not_approved', 'not_kanban', 'no_card', 'card_not_done', 'not_latest']) {
      expect(hu).toContain(`'approvals.undo.err.${code}'`)
      expect(en).toContain(`'approvals.undo.err.${code}'`)
    }
  })
})
