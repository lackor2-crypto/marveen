// A kanban card can never be created without a label. Boss's standing rule,
// broken repeatedly the same way (label attached in a SECOND step that could
// be dropped), so on 2026-08-10 the rule moved into the server: every card
// creation path resolves its labels through resolveCardLabels() and refuses to
// write the card if that fails.
// Same pattern as kanban-labels.test.ts: the real db.js entry points against
// an in-memory database seeded with the production schema.
import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, createKanbanCard, createLabel } from '../db.js'
import { resolveCardLabels, applyCardLabels } from '../web/kanban-labels.js'

function makeLabel(id: string, name: string) {
  return createLabel({ id, name, color: '#3b82f6' })
}

beforeEach(() => {
  initDatabase(':memory:')
})

describe('resolveCardLabels', () => {
  it('rejects a card with no label when labels exist', () => {
    makeLabel('aaaa1111', 'marveen_fejlesztese')
    const r = resolveCardLabels(undefined)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toContain('Címke kötelező')
      // The message has to be actionable on its own: it lists what to pick from
      // and says to ask Boss rather than guess.
      expect(r.error).toContain('marveen_fejlesztese')
      expect(r.error).toContain('kérdezd meg Bosst')
    }
  })

  it('accepts a label id and a label NAME alike', () => {
    makeLabel('aaaa1111', 'marveen_fejlesztese')
    expect(resolveCardLabels(['aaaa1111'])).toEqual({ ok: true, labelIds: ['aaaa1111'] })
    expect(resolveCardLabels(['marveen_fejlesztese'])).toEqual({ ok: true, labelIds: ['aaaa1111'] })
    expect(resolveCardLabels('marveen_fejlesztese')).toEqual({ ok: true, labelIds: ['aaaa1111'] })
  })

  it('rejects an unknown label instead of silently creating an unlabelled card', () => {
    makeLabel('aaaa1111', 'marveen_fejlesztese')
    const r = resolveCardLabels(['nincs-ilyen'])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('Ismeretlen címke')
  })

  it('de-duplicates when the same label arrives twice', () => {
    makeLabel('aaaa1111', 'marveen_fejlesztese')
    expect(resolveCardLabels(['aaaa1111', 'marveen_fejlesztese'])).toEqual({ ok: true, labelIds: ['aaaa1111'] })
  })

  it('a subtask inherits its parent labels instead of being asked again', () => {
    makeLabel('aaaa1111', 'marveen_fejlesztese')
    makeLabel('bbbb2222', 'szemelyes')
    createKanbanCard({ id: 'parent01', title: 'parent' })
    applyCardLabels('parent01', ['aaaa1111', 'bbbb2222'])
    expect(resolveCardLabels(undefined, { parentId: 'parent01' })).toEqual({
      ok: true,
      labelIds: ['aaaa1111', 'bbbb2222'],
    })
  })

  it('an explicit label on a subtask wins over inheritance', () => {
    makeLabel('aaaa1111', 'marveen_fejlesztese')
    makeLabel('bbbb2222', 'szemelyes')
    createKanbanCard({ id: 'parent01', title: 'parent' })
    applyCardLabels('parent01', ['aaaa1111'])
    expect(resolveCardLabels(['szemelyes'], { parentId: 'parent01' })).toEqual({ ok: true, labelIds: ['bbbb2222'] })
  })

  it('a parent with no labels does NOT let a subtask through unlabelled', () => {
    makeLabel('aaaa1111', 'marveen_fejlesztese')
    createKanbanCard({ id: 'parent01', title: 'parent' })
    expect(resolveCardLabels(undefined, { parentId: 'parent01' }).ok).toBe(false)
  })

  it('an install with no labels defined cannot be required to pick one', () => {
    expect(resolveCardLabels(undefined)).toEqual({ ok: true, labelIds: [] })
  })
})
