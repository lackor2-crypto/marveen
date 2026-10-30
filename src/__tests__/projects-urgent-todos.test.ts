// Project chooser badge: open Workbench to-dos that are overdue or due within a week.
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { initDatabase, getDb } from '../db.js'
import { createProject, listProjects, URGENT_DAYS } from '../projects.js'
import { addTodo } from '../workbench-todos.js'
import { createWorkItem, setWorkItemDeleted } from '../workbench.js'

function day(offset: number): string {
  const d = new Date()
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate() + offset)
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`
}

beforeEach(() => {
  initDatabase(':memory:')
})

describe('urgent to-dos per project', () => {
  it('is zero when the to-do table does not exist yet', () => {
    const r = createProject({ name: 'Empty' })
    if (!r.ok) throw new Error(r.code)
    const p = listProjects().find((x) => x.id === r.project.id)!
    expect(p.urgent_todos).toBe(0)
    expect(p.urgent_next_due).toBeNull()
  })

  it('counts overdue and soon-due open to-dos, not done, far or undated ones', () => {
    const r = createProject({ name: 'Hivatal' })
    if (!r.ok) throw new Error(r.code)
    const w = createWorkItem({ project_id: r.project.id, type: 'document', title: 'Level', folder: 'Munkadarabok/x' } as never)
    if (!w.ok) throw new Error(w.code)
    const id = (w as { item: { id: string } }).item.id
    const mk = (due: string | null) => {
      const t = addTodo({ work_item_id: id, text: 'x' + String(due), due_date: due })
      if (!t.ok) throw new Error(String(t.code))
      return (t as { todo: { id: string } }).todo.id
    }
    mk(day(-9))
    mk(day(-2))
    mk(day(URGENT_DAYS))
    mk(day(URGENT_DAYS + 1))
    mk(null)
    const doneId = mk(day(-30))
    getDb().prepare('UPDATE work_item_todos SET done_at = 1 WHERE id = ?').run(doneId)
    const p = listProjects().find((x) => x.id === r.project.id)!
    expect(p.urgent_todos).toBe(3)
    expect(p.urgent_next_due).toBe(day(-9))
  })
})

describe('urgent to-dos follow a deleted work item', () => {
  it('stops counting the to-dos of a work item moved to the Trash, and counts them again on restore', () => {
    const r = createProject({ name: 'Hivatal' })
    if (!r.ok) throw new Error(r.code)
    const mkItem = (folder: string) => {
      const w = createWorkItem({ project_id: r.project.id, type: 'document', title: folder, folder } as never)
      if (!w.ok) throw new Error(w.code)
      return (w as { item: { id: string } }).item.id
    }
    const a = mkItem('Munkadarabok/a')
    const b = mkItem('Munkadarabok/b')
    for (const id of [a, a, b]) addTodo({ work_item_id: id, text: 'x', due_date: day(-1) })
    const n = () => listProjects().find((x) => x.id === r.project.id)!.urgent_todos
    expect(n()).toBe(3)
    setWorkItemDeleted(a, true)
    expect(n()).toBe(1)
    setWorkItemDeleted(a, false)
    expect(n()).toBe(3)
  })
})

describe('project tile source contract', () => {
  it('renders the red badge from the urgent fields with HU+EN text', () => {
    const app = readFileSync('web/app.js', 'utf8')
    expect(app).toContain("t('projects.tile.urgent'")
    expect(app).toContain('p.urgent_todos > 0')
    for (const f of ['web/lang/hu.js', 'web/lang/en.js']) {
      const s = readFileSync(f, 'utf8')
      expect(s).toContain('"projects.tile.urgent"')
      expect(s).toContain('"projects.tile.urgent_title"')
    }
    expect(readFileSync('web/style.css', 'utf8')).toContain('.prj-urgent')
  })
})
