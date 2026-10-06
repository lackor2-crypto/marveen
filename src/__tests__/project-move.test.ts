// Moving items between projects, merging and deleting with contents (Boss TG 2547, 2549).
import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, createKanbanCard, getKanbanCard, getDb, createIdea } from '../db.js'
import { createProject, getProject, linkObject, projectForObject, setProjectArchived } from '../projects.js'
import { parseMoveItems, moveItemsBetweenProjects, mergeProjectInto, deleteProjectWithContents, projectContents } from '../project-move.js'

beforeEach(() => { initDatabase(':memory:') })

function mk(name: string) {
  const r = createProject({ name })
  if (!r.ok) throw new Error(r.code)
  return r.project
}
const idea = (id: string) => createIdea({ id, title: id, description: null, category: 'Egyéb', status: 'new', source: 'manual', kanban_id: null, impact: null, effort: null })

describe('parseMoveItems', () => {
  it('only known types with ids', () => {
    expect(parseMoveItems([])).toBeNull()
    expect(parseMoveItems([{ type: 'x', id: '1' }])).toBeNull()
    expect(parseMoveItems([{ type: 'card', id: '' }])).toBeNull()
    expect(parseMoveItems([{ type: 'card', id: 'c1' }])).toEqual([{ type: 'card', id: 'c1' }])
  })
})

describe('moveItemsBetweenProjects', () => {
  it('moves cards and links, skips what is not in the source', () => {
    const a = mk('A'), b = mk('B')
    createKanbanCard({ id: 'c1', title: 'Egy', project: a.id })
    createKanbanCard({ id: 'c2', title: 'Más', project: b.id })
    idea('i1'); linkObject(a.id, 'idea', 'i1')
    linkObject(a.id, 'debate', 's1')
    const r = moveItemsBetweenProjects(a.id, b.id, [{ type: 'card', id: 'c1' }, { type: 'card', id: 'c2' }, { type: 'idea', id: 'i1' }, { type: 'debate', id: 's1' }])
    expect(r).toEqual({ ok: true, moved: 3, skipped: 1 })
    expect(getKanbanCard('c1')?.project).toBe(b.id)
    expect(projectForObject('idea', 'i1')).toBe(b.id)
    expect(projectForObject('debate', 's1')).toBe(b.id)
  })
  it('refuses the same, missing or archived target', () => {
    const a = mk('A'), b = mk('B')
    const it1 = [{ type: 'card' as const, id: 'c1' }]
    expect(moveItemsBetweenProjects(a.id, a.id, it1)).toEqual({ ok: false, code: 'same_project' })
    expect(moveItemsBetweenProjects(a.id, 'nincs', it1)).toEqual({ ok: false, code: 'target_missing' })
    setProjectArchived(b.id, true)
    expect(moveItemsBetweenProjects(a.id, b.id, it1)).toEqual({ ok: false, code: 'target_archived' })
  })
})

describe('merge and delete with contents', () => {
  it('merge moves everything, then the source project is gone', () => {
    const a = mk('A'), b = mk('B')
    createKanbanCard({ id: 'c1', title: 'Egy', project: a.id })
    createKanbanCard({ id: 'c2', title: 'Kettő', project: a.id })
    linkObject(a.id, 'research', 'r1')
    expect(mergeProjectInto(a.id, b.id)).toEqual({ ok: true, cards: 2, ideas: 0, links: 1 })
    expect(getProject(a.id)).toBeUndefined()
    expect(getKanbanCard('c2')?.project).toBe(b.id)
    expect(projectForObject('research', 'r1')).toBe(b.id)
  })
  it('delete with contents removes cards and ideas, cuts other links', () => {
    const a = mk('A')
    createKanbanCard({ id: 'c1', title: 'Egy', project: a.id })
    idea('i1'); linkObject(a.id, 'idea', 'i1'); linkObject(a.id, 'debate', 's1')
    expect(deleteProjectWithContents(a.id)).toEqual({ ok: true, cards: 1, ideas: 1, links: 2 })
    expect(getKanbanCard('c1')).toBeUndefined()
    expect(getDb().prepare('SELECT COUNT(*) n FROM idea_box').get()).toEqual({ n: 0 })
    expect(getProject(a.id)).toBeUndefined()
  })
  it('a project with live work items refuses both, and nothing is touched', () => {
    const a = mk('A'), b = mk('B')
    createKanbanCard({ id: 'c1', title: 'Egy', project: a.id })
    getDb().exec(`CREATE TABLE IF NOT EXISTS work_items (id TEXT, project_id TEXT, deleted_at INTEGER)`)
    getDb().prepare('INSERT INTO work_items (id, project_id, deleted_at) VALUES (?, ?, NULL)').run('w1', a.id)
    expect(projectContents(a.id).workItems).toBe(1)
    expect(mergeProjectInto(a.id, b.id)).toEqual({ ok: false, code: 'has_work_items', workItems: 1 })
    expect(deleteProjectWithContents(a.id)).toEqual({ ok: false, code: 'has_work_items', workItems: 1 })
    expect(getKanbanCard('c1')?.project).toBe(a.id)
    expect(getProject(a.id)?.id).toBe(a.id)
  })
})
