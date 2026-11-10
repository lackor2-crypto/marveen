// Boss TG 5898/5903: the Kanban column follows what a work item really is. A SENT one shows in Done, an
// unsent draft being worked on right now shows in In progress. Display only: the stored status stays.
import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { createProject } from '../projects.js'
import { createWorkItem } from '../workbench.js'
import { markSentManually } from '../workbench-docsent.js'
import { listBoardWorkItems } from '../workbench-overview.js'

let pid = ''
function item(title: string, status = 'draft') {
  const r = createWorkItem({ project_id: pid, title, type: 'note', status })
  if (!r.ok) throw new Error('create failed')
  return r.item
}
const col = (id: string) => listBoardWorkItems(pid).find((w) => w.id === id)?.column

describe('board column follows sent / current work', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    const p = createProject({ name: 'Proba' })
    if (!p.ok) throw new Error('project')
    pid = p.project.id
  })

  it('a sent draft shows in Done, its stored status is untouched', () => {
    const w = item('Elkuldott')
    markSentManually(w.id, 'test')
    expect(col(w.id)).toBe('done')
    const st = (getDb().prepare('SELECT status FROM work_items WHERE id = ?').get(w.id) as { status: string }).status
    expect(st).toBe('draft')
  })

  it('an unsent draft touched just now shows in In progress', () => {
    expect(col(item('Friss').id)).toBe('in_progress')
  })

  it('an old unsent draft stays in Planned', () => {
    const w = item('Regi')
    getDb().prepare('UPDATE work_items SET updated_at = ? WHERE id = ?').run(Math.floor(Date.now() / 1000) - 3 * 86400, w.id)
    expect(col(w.id)).toBe('planned')
  })

  it('a fresh item in review stays in Waiting (a deliberate column)', () => {
    expect(col(item('Varakozo', 'review').id)).toBe('waiting')
  })

  it('a sent item older than the recent window drops off the board', () => {
    const w = item('Nagyon regi')
    markSentManually(w.id, 'test')
    getDb().prepare('UPDATE work_items SET updated_at = ? WHERE id = ?').run(1000, w.id)
    expect(listBoardWorkItems(pid).some((x) => x.id === w.id)).toBe(false)
  })
})

describe('column header count (source contract)', () => {
  it('the no-limit WIP badge pass keeps counting the work items shown in the column', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const app = readFileSync(join(__dirname, '..', '..', 'web', 'app.js'), 'utf8')
    const fn = app.slice(app.indexOf('function updateWipBadges'))
    const noLimit = fn.slice(0, fn.indexOf('delete el.dataset.wip'))
    expect(noLimit).toContain('kanbanWorkItems.filter')
    expect(noLimit).toContain('cards.length + works')
  })
})
