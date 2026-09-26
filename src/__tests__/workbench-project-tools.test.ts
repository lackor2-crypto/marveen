// #404 H5: the workbench agent reaches the rest of the project -- Idea box,
// Research page, comments and links on existing cards -- through the same
// paths the dashboard uses, and ALWAYS inside the current project.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, createKanbanCard, getKanbanCard, getKanbanComments, getDb } from '../db.js'
import { createProject, projectForObject } from '../projects.js'
import { ideaProjectMap, researchProject } from '../project-scope.js'
import { executeTool } from '../workbench-agent/execute.js'
import { getTool } from '../workbench-agent/tools.js'
import { setResearchDirForTest, researchSlug } from '../workbench-agent/project-tools.js'
import { MAIN_AGENT_ID } from '../config.js'

let projectId = ''
let otherId = ''
let dir = ''
const ctx = (actor?: string) => ({ projectId, workItemId: null, lang: 'hu' as const, actor })
const seqOf = (id: string) => (getDb().prepare('SELECT rowid AS s FROM kanban_cards WHERE id = ?').get(id) as { s: number }).s

beforeEach(() => {
  initDatabase(':memory:')
  const p = createProject({ name: 'Kovács-ház' })
  const o = createProject({ name: 'Idegen' })
  if (!p.ok || !o.ok) throw new Error('projekt')
  projectId = p.project.id
  otherId = o.project.id
  dir = mkdtempSync(join(tmpdir(), 'wb-research-'))
  setResearchDirForTest(join(dir, 'research'))
})
afterEach(() => { setResearchDirForTest(null); rmSync(dir, { recursive: true, force: true }) })

describe('uj eszkozok a registryben', () => {
  it('mind megvan, iras-eszkoz meglevo autonomy-kategoriaval', () => {
    for (const n of ['idea.create', 'research.save', 'kanban.comment', 'kanban.relate']) expect(getTool(n)?.autonomyCategory).toBe('marveen_selfdev')
    expect(getTool('idea.list')?.autonomyCategory).toBeNull()
  })
})

describe('otletlada', () => {
  it('ures projektnel kimondja, hogy nincs otlet (friss telepites)', () => {
    const r = executeTool('idea.list', {}, ctx())
    expect(r).toMatchObject({ ok: true, data: { count: 0 } })
    expect((r as any).data.note).toMatch(/no idea/)
  })

  it('a letrehozott otlet EHHEZ a projekthez kotodik, a lista csak ezt mutatja', () => {
    const r = executeTool('idea.create', { title: 'Napelem a tetőre', description: 'később' }, ctx())
    expect(r.ok).toBe(true)
    const id = (r as any).data.id
    expect(ideaProjectMap().get(id)).toBe(projectId)
    const l = executeTool('idea.list', {}, ctx()) as any
    expect(l.data.ideas.map((i: any) => i.title)).toEqual(['Napelem a tetőre'])
    const other = executeTool('idea.list', {}, { ...ctx(), projectId: otherId }) as any
    expect(other.data.count).toBe(0)
  })

  it('cim nelkul nincs otlet', () => {
    expect(executeTool('idea.create', { title: ' ' }, ctx())).toMatchObject({ ok: false, code: 'bad_input' })
  })
})

describe('kutatas', () => {
  it('md-t ir a research mappaba, projekt-jelolessel es kotessel; sosem ir felul', () => {
    const a = executeTool('research.save', { title: 'Hőszivattyú árak 2026', text: '# Más cím\n\n- A: 1 Ft' }, ctx()) as any
    const b = executeTool('research.save', { title: 'Hőszivattyú árak 2026', text: 'második' }, ctx()) as any
    expect(a.ok && b.ok).toBe(true)
    expect(a.data.name).toBe('hoszivattyu-arak-2026.md')
    expect(b.data.name).toBe('hoszivattyu-arak-2026-2.md')
    const content = readFileSync(join(dir, 'research', a.data.name), 'utf-8')
    expect(content).toBe(`# Hőszivattyú árak 2026\n\nproject: ${projectId}\n\n- A: 1 Ft\n`)
    expect(researchProject(MAIN_AGENT_ID, a.data.name, content)).toBe(projectId)
    expect(projectForObject('research', `${MAIN_AGENT_ID}/${b.data.name}`)).toBe(projectId)
    expect(readdirSync(join(dir, 'research'))).toHaveLength(2)
  })

  it('ures szoveg / cim hiba, a slug sosem ures', () => {
    expect(executeTool('research.save', { title: 'x', text: '' }, ctx())).toMatchObject({ ok: false, code: 'bad_input' })
    expect(researchSlug('???')).toBe('kutatas')
  })
})

describe('kanban komment + osszekotes', () => {
  beforeEach(() => {
    createKanbanCard({ id: 'aaaa1111', title: 'Tető', project: projectId } as any)
    createKanbanCard({ id: 'bbbb2222', title: 'Fűtés', project: projectId } as any)
    createKanbanCard({ id: 'cccc3333', title: 'Idegen kártya', project: otherId } as any)
  })

  it('komment #N-nel, a kero a szerzo', () => {
    const r = executeTool('kanban.comment', { card: `#${seqOf('aaaa1111')}`, text: 'Megjött az árajánlat.' }, ctx('boss')) as any
    expect(r.ok).toBe(true)
    expect(getKanbanComments('aaaa1111').map((c) => [c.author, c.content])).toEqual([['boss', 'Megjött az árajánlat.']])
  })

  it('masik projekt kartyajara nem ir', () => {
    expect(executeTool('kanban.comment', { card: 'cccc3333', text: 'x' }, ctx())).toMatchObject({ ok: false, code: 'card_other_project' })
    expect(executeTool('kanban.comment', { card: '#9999', text: 'x' }, ctx())).toMatchObject({ ok: false, code: 'card_not_found' })
  })

  it('osszekotes mindket kartya leirasaba, ismetelve sem duplaz', () => {
    const r = executeTool('kanban.relate', { card: 'aaaa1111', related: ['bbbb2222'] }, ctx()) as any
    expect(r).toMatchObject({ ok: true, data: { linked: [`#${seqOf('bbbb2222')}`] } })
    executeTool('kanban.relate', { card: 'aaaa1111', related: ['bbbb2222'] }, ctx())
    expect(getKanbanCard('aaaa1111')?.description).toBe(`Kapcsolodo kartya: bbbb2222 (#${seqOf('bbbb2222')}).`)
    expect(getKanbanCard('bbbb2222')?.description).toBe(`Kapcsolodo kartya: aaaa1111 (#${seqOf('aaaa1111')}).`)
  })

  it('ismeretlen vagy sajat maga -> hiba, nem ir semmit', () => {
    expect(executeTool('kanban.relate', { card: 'aaaa1111', related: ['nincs'] }, ctx())).toMatchObject({ ok: false, code: 'card_not_found' })
    expect(executeTool('kanban.relate', { card: 'aaaa1111', related: ['aaaa1111'] }, ctx())).toMatchObject({ ok: false, code: 'bad_input' })
    expect(getKanbanCard('aaaa1111')?.description ?? '').toBe('')
  })
})
