// Boss TG 5898/5903: the Kanban column follows what a work item really is. A SENT one shows in Done, an
// unsent draft being worked on right now shows in In progress. Since TG 5918 sending also stores done.
import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { createProject } from '../projects.js'
import { createWorkItem } from '../workbench.js'
import { markSentManually } from '../workbench-docsent.js'
import { addTodo } from '../workbench-todos.js'
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

  it('a sent draft shows in Done, and its stored status is done too (Boss TG 5918)', () => {
    const w = item('Elkuldott')
    markSentManually(w.id, 'test')
    expect(col(w.id)).toBe('done')
    const st = (getDb().prepare('SELECT status FROM work_items WHERE id = ?').get(w.id) as { status: string }).status
    expect(st).toBe('done')
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

  const ago3d = () => Math.floor(Date.now() / 1000) - 3 * 86400
  const ymd = (offsetDays: number) => {
    const d = new Date(); d.setDate(d.getDate() + offsetDays)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }
  function oldDraftWithDue(title: string, offsetDays: number) {
    const w = item(title)
    const r = addTodo({ work_item_id: w.id, text: 'teendo', due_date: ymd(offsetDays) })
    if (!r.ok) throw new Error('todo failed')
    getDb().prepare('UPDATE work_items SET updated_at = ? WHERE id = ?').run(ago3d(), w.id)
    return w
  }

  it('an old unsent draft with a deadline TODAY shows in In progress (card #901: the "ARD 88M" case)', () => {
    expect(col(oldDraftWithDue('Ma hatarido', 0).id)).toBe('in_progress')
  })

  it('an old unsent draft with an overdue deadline shows in In progress', () => {
    expect(col(oldDraftWithDue('Lejart', -2).id)).toBe('in_progress')
  })

  it('an old unsent draft with a deadline in the future stays in Planned', () => {
    expect(col(oldDraftWithDue('Kesobbi', 5).id)).toBe('planned')
  })

  it('a stored in_progress item shows in In progress even when old', () => {
    const w = item('Folyamatban', 'in_progress')
    getDb().prepare('UPDATE work_items SET updated_at = ? WHERE id = ?').run(ago3d(), w.id)
    expect(col(w.id)).toBe('in_progress')
  })

  it('the project-filtered list (project Kanban tab) uses the same columns as the all-projects list (main board)', () => {
    const s = item('Elkuldott2'); markSentManually(s.id, 'test')
    const f = item('Friss2')
    const o = item('Regi2'); getDb().prepare('UPDATE work_items SET updated_at = ? WHERE id = ?').run(ago3d(), o.id)
    const byId = (list: ReturnType<typeof listBoardWorkItems>) => Object.fromEntries(list.map((w) => [w.id, w.column]))
    const all = byId(listBoardWorkItems())
    const one = byId(listBoardWorkItems(pid))
    expect(one).toEqual(all)
    expect(one[s.id]).toBe('done'); expect(one[f.id]).toBe('in_progress'); expect(one[o.id]).toBe('planned')
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
