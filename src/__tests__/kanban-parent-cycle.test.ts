// #456 (rebuilt from upstream 94765127): re-parenting a card must never close a loop.
import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, createKanbanCard, updateKanbanCard, parentWouldCycle } from '../db.js'

function card(id: string, parent?: string): void {
  createKanbanCard({ id, title: id, description: '', status: 'planned', assignee: null, priority: 'normal', parent_id: parent } as never)
}

beforeEach(() => { initDatabase(':memory:') })

describe('parentWouldCycle', () => {
  it('refuses a card as its own parent', () => {
    card('a')
    expect(parentWouldCycle('a', 'a')).toBe(true)
  })
  it('refuses A -> B -> A', () => {
    card('a'); card('b', 'a')
    expect(parentWouldCycle('a', 'b')).toBe(true)
  })
  it('refuses a longer loop', () => {
    card('a'); card('b', 'a'); card('c', 'b')
    expect(parentWouldCycle('a', 'c')).toBe(true)
  })
  it('allows an unrelated re-parent', () => {
    card('a'); card('b'); card('c', 'a')
    expect(parentWouldCycle('c', 'b')).toBe(false)
    expect(updateKanbanCard('c', { parent_id: 'b' })).toBe(true)
  })
})
