// Boss TG 5914/5918: sending a work item stores status "done"; taking the last sending back reopens it; the
// one-time migration sets the already-sent ones to done without touching updated_at, and never runs twice.
import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { createProject } from '../projects.js'
import { createWorkItem } from '../workbench.js'
import { ensureDocLangTables } from '../workbench-doclang.js'
import { markSentManually, unmarkSentManually, migrateSentStatusesOnce } from '../workbench-docsent.js'

let pid = ''
function item(title: string, status = 'draft') {
  const r = createWorkItem({ project_id: pid, title, type: 'note', status })
  if (!r.ok) throw new Error('create failed')
  return r.item
}
const row = (id: string) => getDb().prepare('SELECT status, updated_at FROM work_items WHERE id = ?').get(id) as { status: string; updated_at: number }

describe('sent => stored status done', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    const p = createProject({ name: 'Proba' })
    if (!p.ok) throw new Error('project')
    pid = p.project.id
  })

  it('marking sent stores done', () => {
    const w = item('A')
    markSentManually(w.id, 'test')
    expect(row(w.id).status).toBe('done')
  })

  it('taking the mark back reopens it to in_progress', () => {
    const w = item('B')
    markSentManually(w.id, 'test')
    unmarkSentManually(w.id)
    expect(row(w.id).status).toBe('in_progress')
  })

  it('an unsent item that is not done is left alone by an unmark', () => {
    const w = item('C', 'review')
    unmarkSentManually(w.id)
    expect(row(w.id).status).toBe('review')
  })

  it('migration sets already-sent items to done, keeps updated_at, and runs only once', () => {
    const a = item('Regi elkuldott')
    const b = item('Nem elkuldott')
    markSentManually(a.id, 'test')
    getDb().prepare("UPDATE work_items SET status = 'draft', updated_at = 5000 WHERE id = ?").run(a.id)
    expect(migrateSentStatusesOnce()).toBe(1)
    expect(row(a.id)).toEqual({ status: 'done', updated_at: 5000 })
    expect(row(b.id).status).toBe('draft')
    getDb().prepare("UPDATE work_items SET status = 'in_progress' WHERE id = ?").run(a.id)
    expect(migrateSentStatusesOnce()).toBe(0)
    expect(row(a.id).status).toBe('in_progress')
  })

  function pair() {
    const hu = item('HU levél'); const de = item('DE levél')
    ensureDocLangTables()
    getDb().prepare('INSERT INTO wb_doc_variants (work_item_id, source_item_id, lang, created_at, created_by) VALUES (?, ?, ?, 0, NULL)').run(de.id, hu.id, 'de')
    return { hu, de }
  }

  it('sending one language version stores done on every version of the same work', () => {
    const { hu, de } = pair()
    markSentManually(de.id, 'test')
    expect(row(hu.id).status).toBe('done')
    expect(row(de.id).status).toBe('done')
  })

  it('taking the sending back reopens every version of the work', () => {
    const { hu, de } = pair()
    markSentManually(hu.id, 'test')
    unmarkSentManually(hu.id)
    expect([row(hu.id).status, row(de.id).status]).toEqual(['in_progress', 'in_progress'])
  })

  it('migration also reaches the language versions that were never sent themselves', () => {
    const { hu, de } = pair()
    markSentManually(hu.id, 'test')
    getDb().prepare("UPDATE work_items SET status = 'draft'").run()
    getDb().exec("CREATE TABLE IF NOT EXISTS wb_sent_status_migration (id TEXT PRIMARY KEY, done_at INTEGER NOT NULL, changed INTEGER NOT NULL); INSERT INTO wb_sent_status_migration VALUES ('sent-to-done-1', 0, 0)")
    expect(migrateSentStatusesOnce()).toBe(2)
    expect([row(hu.id).status, row(de.id).status]).toEqual(['done', 'done'])
  })
})
