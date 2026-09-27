// #429: the Done column lists the most recently finished card first.
//
// Server side: listKanbanCards() exposes done_at = the time the card last
// entered "done" (latest kanban_card_events row), falling back to updated_at
// for cards finished before status events existed; null outside "done".
// Client side: web/app.js sorts the done column by it, newest first, and
// keeps the urgency sort for every other column.

import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { initDatabase, createKanbanCard, moveKanbanCard, listKanbanCards, getDb } from '../db.js'

beforeEach(() => {
  initDatabase(':memory:')
})

describe('listKanbanCards done_at', () => {
  it('uses the latest move into done, not the earliest', () => {
    createKanbanCard({ id: 'c1', title: 'Twice done' })
    const now = Math.floor(Date.now() / 1000)
    moveKanbanCard('c1', 'done', 0, 'x')
    moveKanbanCard('c1', 'waiting', 0, 'x')
    moveKanbanCard('c1', 'done', 0, 'x')
    const db = getDb()
    const ev = db.prepare("SELECT id FROM kanban_card_events WHERE card_id='c1' AND to_status='done' ORDER BY id").all() as { id: number }[]
    db.prepare('UPDATE kanban_card_events SET created_at = ? WHERE id = ?').run(now - 500, ev[0].id)
    db.prepare('UPDATE kanban_card_events SET created_at = ? WHERE id = ?').run(now - 10, ev[1].id)
    const card = listKanbanCards().find(c => c.id === 'c1')!
    expect(card.done_at).toBe(now - 10)
  })

  it('falls back to updated_at when the card has no done event', () => {
    createKanbanCard({ id: 'c2', title: 'Legacy done' })
    getDb().prepare("UPDATE kanban_cards SET status='done', updated_at = ? WHERE id='c2'").run(Math.floor(Date.now() / 1000) - 100)
    const card = listKanbanCards().find(c => c.id === 'c2')!
    expect(card.done_at).toBe(card.updated_at)
  })

  it('is null for cards outside the done column', () => {
    createKanbanCard({ id: 'c3', title: 'Open' })
    moveKanbanCard('c3', 'done', 0, 'x')
    moveKanbanCard('c3', 'waiting', 0, 'x')
    expect(listKanbanCards().find(c => c.id === 'c3')!.done_at).toBeNull()
  })
})

describe('web/app.js done column order', () => {
  const src = readFileSync(join(__dirname, '..', '..', 'web', 'app.js'), 'utf8')
  const start = src.indexOf('function kanbanDoneRecencySort')
  const end = src.indexOf('// Which swimlane a card belongs to')
  // eslint-disable-next-line no-new-func
  const { kanbanColumnSort } = new Function(
    'kanbanUrgencySort',
    src.slice(start, end) + '\nreturn { kanbanColumnSort }',
  )(() => 0)

  it('puts the most recently finished card on top', () => {
    const cards = [
      { seq: 1, done_at: 100, updated_at: 900 },
      { seq: 2, done_at: 300, updated_at: 300 },
      { seq: 3, done_at: null, updated_at: 200 },
    ]
    expect(cards.sort(kanbanColumnSort('done')).map(c => c.seq)).toEqual([2, 3, 1])
  })

  it('keeps the urgency sort for the other columns and uses it in both board layouts', () => {
    expect(kanbanColumnSort('waiting')).not.toBe(kanbanColumnSort('done'))
    expect(src).toContain('cards.sort(kanbanColumnSort(status))')
    expect(src).toContain('laneCardsByStatus[def.status].sort(kanbanColumnSort(def.status))')
  })
})
