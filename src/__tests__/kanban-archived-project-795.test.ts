// #795 (continued): no kanban card goes under an ARCHIVED project, whichever door it comes through.
// The first fix covered a top-level create (checkCardProject). Three doors stayed open:
//   1. a sub-card (`parent_id`) skipped the check -- an explicit or inherited archived project was stored;
//   2. PUT /api/kanban/:id could move a card INTO an archived project;
//   3. the dashboard's project picker offered / pre-selected an archived project (new-card modal on a board
//      filtered to an archived project, idea promote of an idea that sits in one).
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { initDatabase, createKanbanCard, getKanbanCard, listKanbanCards } from '../db.js'
import { createCardWithRules } from '../kanban-create.js'
import { createProject, setProjectArchived } from '../projects.js'
import { tryHandleKanban } from '../web/routes/kanban.js'
import type { RouteContext } from '../web/routes/types.js'

const base = { status: 'planned', related: [] as string[] }

function putCtx(id: string, payload: unknown): { ctx: RouteContext; out: { status: number; body: any } } {
  const out: { status: number; body: any } = { status: 200, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    setHeader() { return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
  }
  const req: any = Readable.from([Buffer.from(JSON.stringify(payload))])
  const url = new URL(`http://localhost:3420/api/kanban/${encodeURIComponent(id)}`)
  return { ctx: { req, res, path: url.pathname, method: 'PUT', url } as RouteContext, out }
}

function setup() {
  const live = createProject({ name: 'Aktiv' })
  const old = createProject({ name: 'Regi iroda' })
  if (!live.ok || !old.ok) throw new Error('project')
  return { live: live.project.id, old: old.project.id }
}

describe('#795: archived project, the sub-card door', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('a sub-card with an explicit archived project is refused', () => {
    const { live, old } = setup()
    createKanbanCard({ id: 'par1', title: 'Parent', status: 'planned', project: live })
    setProjectArchived(old, true)
    const before = listKanbanCards().length
    const r = createCardWithRules({ ...base, title: 'Sub', parent_id: 'par1', project: old })
    expect(r.ok).toBe(false)
    if (!r.ok && r.code === 'project_required') {
      expect(r.error).toContain('ARCHIVALT PROJEKT')
      expect(r.projects.map((x) => x.id)).toEqual([live])
    } else throw new Error('project_required expected: ' + JSON.stringify(r))
    expect(listKanbanCards().length).toBe(before)
  })

  it('a sub-card inheriting an archived parent project is refused', () => {
    const { old } = setup()
    createKanbanCard({ id: 'par2', title: 'Parent', status: 'planned', project: old })
    setProjectArchived(old, true)
    const r = createCardWithRules({ ...base, title: 'Sub', parent_id: 'par2' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('project_required')
  })

  it('a sub-card under an active project is still created', () => {
    const { live } = setup()
    createKanbanCard({ id: 'par3', title: 'Parent', status: 'planned', project: live })
    const r = createCardWithRules({ ...base, title: 'Sub', parent_id: 'par3' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(getKanbanCard(r.id)?.project).toBe(live)
  })
})

describe('#795: archived project, the card-move door (PUT)', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('moving a card INTO an archived project is refused and the card is untouched', async () => {
    const { live, old } = setup()
    createKanbanCard({ id: 'mv1', title: 'Card', status: 'planned', project: live })
    setProjectArchived(old, true)
    const { ctx, out } = putCtx('mv1', { project: old })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(400)
    expect(out.body.code).toBe('project_required')
    expect(out.body.projects.map((x: { id: string }) => x.id)).toEqual([live])
    expect(getKanbanCard('mv1')?.project).toBe(live)
  })

  it('a card that already sits in an archived project can still be edited (project unchanged)', async () => {
    const { old } = setup()
    createKanbanCard({ id: 'mv2', title: 'Card', status: 'planned', project: old })
    setProjectArchived(old, true)
    const { ctx, out } = putCtx('mv2', { project: old, priority: 'high' })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(getKanbanCard('mv2')?.priority).toBe('high')
  })

  it('moving a card between active projects works', async () => {
    const { live } = setup()
    const other = createProject({ name: 'Masik' })
    if (!other.ok) throw new Error('project')
    createKanbanCard({ id: 'mv3', title: 'Card', status: 'planned', project: live })
    const { ctx, out } = putCtx('mv3', { project: other.project.id })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(getKanbanCard('mv3')?.project).toBe(other.project.id)
  })
})

describe('#795: archived project, the dashboard picker', () => {
  const app = readFileSync(join(process.cwd(), 'web', 'app.js'), 'utf8')
  const fn = app.slice(app.indexOf('function populateProjectSuggestions'), app.indexOf("document.getElementById('kanbanProjectFilter').addEventListener"))

  it('populateProjectSuggestions can be told to drop an archived "keep" value', () => {
    expect(fn).toMatch(/function populateProjectSuggestions\(current, selectId = 'cardProject', opts = \{\}\)/)
    expect(fn).toContain('opts.forNew')
  })

  it('the NEW-card modal, the idea picker and the project page ask for it', () => {
    expect(app).toContain('populateProjectSuggestions(scoped, \'cardProject\', { forNew: true })')
    expect(app).toContain('populateProjectSuggestions(idea?.project || \'\', selectId, { forNew: true })')
    expect(app).toContain('populateProjectSuggestions(p.id, \'cardProject\', { forNew: true })')
  })

  it('editing an existing card still keeps its own archived project selectable', () => {
    expect(app).toContain("populateProjectSuggestions(card.project || '')")
  })
})
