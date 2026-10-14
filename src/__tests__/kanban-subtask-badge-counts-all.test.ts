import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Boss TG 3332: a subtask nested inside its parent card must still be counted on the card face.
describe('kanban subtask badge', () => {
  const app = readFileSync(join(__dirname, '../../web/app.js'), 'utf8')
  const body = app.slice(app.indexOf('function updateSubtaskBadges'), app.indexOf('function createCardEl'))

  it('counts every child, embedded ones included', () => {
    expect(body).toContain('kanbanCards.filter(c => c.parent_id === id)')
    expect(body).toContain("badge.textContent = t('kanban.card.subtask_count', { n: nonEmbedded.length })")
  })

  it('lists the subtasks that sit in another column one per line, number + title (Boss TG 3357)', () => {
    expect(body).toContain('kanban-subtask-refs')
    expect(body).toContain('c.seq')
    expect(body).toContain('escapeHtml(c.title)')
    expect(body).toContain('embeddedSubtaskIds.has(c.id)')
    expect(body).not.toContain('refs:')
  })

  it('uses a translated label in both languages', () => {
    expect(body).toContain("t('kanban.card.subtask_count'")
    for (const l of ['hu', 'en']) {
      expect(readFileSync(join(__dirname, `../../web/lang/${l}.js`), 'utf8')).toContain("'kanban.card.subtask_count'")
    }
  })
})
