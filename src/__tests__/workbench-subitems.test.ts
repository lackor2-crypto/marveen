// #448 -- main work item + sub work items: creation rules, trash with subs,
// the folder inside the main item's folder, agent context, and the list UI.
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase } from '../db.js'
import { createProject, updateProject } from '../projects.js'
import { createWorkItem, getWorkItem, listWorkItems, listSubItems, setWorkItemDeleted, purgeWorkItem } from '../workbench.js'
import { ensureWorkItemFolder } from '../workbench-assets.js'
import { familyLines } from '../workbench-agent/context.js'
import { callWorkbench } from './helpers/workbench-route-call.js'
import { workbenchHarness, itemsBody, untranslatedHungarian } from './helpers/workbench-harness.js'
import { vi } from 'vitest'

let pid = ''
let main = ''

function mk(title: string, parent?: string): string {
  const r = createWorkItem({ project_id: pid, title, type: 'note', parent_item_id: parent })
  if (!r.ok) throw new Error('create: ' + r.code)
  return r.item.id
}

function setup() {
  initDatabase(':memory:')
  const p = createProject({ name: 'Robotok' })
  if (!p.ok) throw new Error('projekt')
  pid = p.project.id
  main = mk('LK Trendvonal EA')
}

describe('creation rules', () => {
  beforeEach(setup)

  it('a sub item stores its main item; without a parent nothing changes', () => {
    const sub = mk('BL', main)
    expect(getWorkItem(sub)!.parent_item_id).toBe(main)
    expect(getWorkItem(main)!.parent_item_id ?? null).toBeNull()
    expect(listSubItems(main).map((i) => i.title)).toEqual(['BL'])
  })

  it('unknown parent, other project, and sub-under-sub are refused', () => {
    expect(createWorkItem({ project_id: pid, title: 'x', parent_item_id: 'nincs' })).toMatchObject({ ok: false, code: 'parent_not_found' })
    const p2 = createProject({ name: 'Masik' })
    if (!p2.ok) throw new Error('projekt')
    expect(createWorkItem({ project_id: p2.project.id, title: 'x', parent_item_id: main })).toMatchObject({ ok: false, code: 'parent_other_project' })
    const sub = mk('BL', main)
    expect(createWorkItem({ project_id: pid, title: 'x', parent_item_id: sub })).toMatchObject({ ok: false, code: 'parent_is_sub' })
  })

  it('a trashed parent cannot take new subs', () => {
    setWorkItemDeleted(main, true)
    expect(createWorkItem({ project_id: pid, title: 'x', parent_item_id: main })).toMatchObject({ ok: false, code: 'parent_not_found' })
  })
})

describe('trash with sub items', () => {
  beforeEach(setup)

  it('trash all: subs go with the main item and come back with it', () => {
    const a = mk('BL', main)
    const b = mk('BB', main)
    setWorkItemDeleted(main, true, 5_000, 'trash')
    expect(listWorkItems(pid)).toHaveLength(0)
    setWorkItemDeleted(main, false)
    expect(listWorkItems(pid).map((i) => i.id).sort()).toEqual([main, a, b].sort())
  })

  it('a sub trashed on its own stays in the trash when the main item comes back', () => {
    const a = mk('BL', main)
    const b = mk('BB', main)
    setWorkItemDeleted(a, true, 1_000)
    setWorkItemDeleted(main, true, 5_000, 'trash')
    setWorkItemDeleted(main, false)
    expect(listWorkItems(pid).map((i) => i.id).sort()).toEqual([main, b].sort())
  })

  it('detach: subs stay alive as stand-alone items', () => {
    const a = mk('BL', main)
    setWorkItemDeleted(main, true, 5_000, 'detach')
    const live = listWorkItems(pid)
    expect(live.map((i) => i.id)).toEqual([a])
    expect(live[0].parent_item_id).toBeNull()
  })

  it('purging a main item frees the subs that are left', () => {
    const a = mk('BL', main)
    setWorkItemDeleted(a, true, 1_000)
    setWorkItemDeleted(main, true, 5_000, 'detach')
    expect(purgeWorkItem(main)).toMatchObject({ ok: true })
    setWorkItemDeleted(a, false)
    expect(getWorkItem(a)!.parent_item_id).toBeNull()
  })

  it('endpoint: asks first (409), then does what was chosen', async () => {
    const a = mk('BL', main)
    const ask = await callWorkbench(`/api/workbench/items/${main}/trash`, 'POST', { deleted: true })
    expect(ask.status).toBe(409)
    expect(ask.body).toMatchObject({ error: 'has_sub_items' })
    expect(typeof (ask.body as { message: string }).message).toBe('string')
    expect(listWorkItems(pid)).toHaveLength(2)
    const ok = await callWorkbench(`/api/workbench/items/${main}/trash`, 'POST', { deleted: true, subs: 'detach' })
    expect(ok.status).toBe(200)
    expect(listWorkItems(pid).map((i) => i.id)).toEqual([a])
  })

  it('endpoint: a main item without subs trashes with no question', async () => {
    const r = await callWorkbench(`/api/workbench/items/${main}/trash`, 'POST', { deleted: true })
    expect(r.status).toBe(200)
  })
})

describe('create endpoint', () => {
  beforeEach(setup)

  it('POST /items takes parent_item_id; a bad parent gives a human message', async () => {
    const ok = await callWorkbench('/api/workbench/items', 'POST', { project_id: pid, title: 'ST', type: 'note', parent_item_id: main })
    expect(ok.status).toBe(201)
    expect((ok.body as { item: { parent_item_id: string } }).item.parent_item_id).toBe(main)
    const bad = await callWorkbench('/api/workbench/items', 'POST', { project_id: pid, title: 'ST', type: 'note', parent_item_id: 'nincs' })
    expect(bad.status).toBe(404)
    expect(bad.body).toMatchObject({ error: 'parent_not_found' })
    expect(typeof (bad.body as { message: string }).message).toBe('string')
  })
})

describe('folder inside the main item folder', () => {
  it('a sub item folder is created under the main item folder', () => {
    initDatabase(':memory:')
    const dir = mkdtempSync(join(tmpdir(), 'wb-sub-'))
    process.env['MARVEEN_DEPOT'] = dir
    const p = createProject({ name: 'Robotok' })
    if (!p.ok) throw new Error('projekt')
    pid = p.project.id
    if (!updateProject(pid, { folder_path: 'Projektek/Robotok' }).ok) throw new Error('projektmappa')
    mkdirSync(join(dir, 'Projektek', 'Robotok'), { recursive: true })
    const m = mk('LK Trendvonal EA')
    const s = mk('BL', m)
    const f = ensureWorkItemFolder(getWorkItem(s)!)
    if (!f.ok) throw new Error('folder: ' + f.code)
    const mainFolder = getWorkItem(m)!.folder
    expect(mainFolder).toBeTruthy()
    expect(f.folder.startsWith(mainFolder + '/')).toBe(true)
    expect(existsSync(join(dir, 'Projektek', 'Robotok', ...f.folder.split('/')))).toBe(true)
    rmSync(dir, { recursive: true, force: true })
    delete process.env['MARVEEN_DEPOT']
  })
})

describe('agent context', () => {
  beforeEach(setup)

  it('a sub item shows its main item and siblings; a main item lists its subs', () => {
    const a = mk('BL', main)
    mk('BB', main)
    const sub = familyLines(getWorkItem(a)!).join('\n')
    expect(sub).toContain('SUB work item')
    expect(sub).toContain('LK Trendvonal EA')
    expect(sub).toContain('BB')
    const top = familyLines(getWorkItem(main)!).join('\n')
    expect(top).toContain('MAIN work item')
    expect(top).toContain('BL')
    expect(familyLines(getWorkItem(mk('Onallo'))!)).toEqual([])
  })
})

describe('list UI', () => {
  const item = (id: string, title: string, parent: string | null) => ({
    id, project_id: 'p1', type: 'document', title, status: 'draft', source_path: null, editor_type: 'text',
    current_version_id: null, created_at: 1, updated_at: 1, created_by: null, pinned_at: null, parent_item_id: parent,
  })

  function open() {
    const h = workbenchHarness()
    h.respond((url) => {
      if (url.includes('/api/workbench/items?')) {
        return { status: 200, body: itemsBody([item('m1', 'Robot', null), item('s1', 'BL', 'm1'), item('s2', 'BB', 'm1'), item('x1', 'Egyeb', null)]) }
      }
      if (url.includes('/api/workbench/todos')) return { status: 200, body: { todos: [] } }
      return { status: 200, body: {} }
    })
    h.win.MarvinWorkbench.open('p1', 'Robotok')
    return h
  }

  it('subs are indented under the main item, with a fold toggle; translated', async () => {
    const h = open()
    await vi.waitFor(() => expect(h.html()).toContain('data-wb-item="s1"'))
    const html = h.html()
    expect(html).toContain('wb-item-sub')
    expect(html).toContain('data-wb-act="main-fold"')
    expect(html.indexOf('data-wb-item="m1"')).toBeLessThan(html.indexOf('data-wb-item="s1"'))
    expect(html.indexOf('data-wb-item="s2"')).toBeLessThan(html.indexOf('data-wb-item="x1"'))
    expect(untranslatedHungarian(html, ['Robotok', 'Robot', 'Egyeb', 'Kovács weboldal'])).toBe('')
  })
})
