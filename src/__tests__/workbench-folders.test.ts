// #454 -- folders instead of main / sub work items: the folder picker on the
// create endpoints, the folder list, the conversion of old sub items, the agent
// context by folder, and the tree in the list UI.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, getDb } from '../db.js'
import { createProject, updateProject } from '../projects.js'
import { createWorkItem, getWorkItem, listWorkItems, setWorkItemDeleted } from '../workbench.js'
import { ensureWorkItemFolder, listWorkFolders, makeWorkFolder, migrateSubItemsToFolders, workFolderTarget } from '../workbench-assets.js'
import { familyLines } from '../workbench-agent/context.js'
import { callWorkbench } from './helpers/workbench-route-call.js'
import { workbenchHarness, itemsBody, untranslatedHungarian } from './helpers/workbench-harness.js'

let pid = ''
let dir = ''

function mk(title: string, container?: string): string {
  const r = createWorkItem({ project_id: pid, title, type: 'note', container_folder: container })
  if (!r.ok) throw new Error('create: ' + r.code)
  return r.item.id
}

function setup() {
  initDatabase(':memory:')
  dir = mkdtempSync(join(tmpdir(), 'wb-folders-'))
  process.env['MARVEEN_DEPOT'] = dir
  const p = createProject({ name: 'Robotok' })
  if (!p.ok) throw new Error('projekt')
  pid = p.project.id
  if (!updateProject(pid, { folder_path: 'Projektek/Robotok' }).ok) throw new Error('projektmappa')
  mkdirSync(join(dir, 'Projektek', 'Robotok'), { recursive: true })
}
function teardown() {
  rmSync(dir, { recursive: true, force: true })
  delete process.env['MARVEEN_DEPOT']
}
const project = () => {
  const p = createProject({ name: 'x' + Math.random() })
  void p
}
void project

describe('folders in the work items box', () => {
  beforeEach(setup)
  afterEach(teardown)

  it('no box yet: the list is empty and nothing is created', () => {
    expect(listWorkFolders(getProjectRow())).toEqual({ box: null, folders: [], truncated: false })
    expect(workFolderTarget(getProjectRow(), 'Projektek')).toMatchObject({ ok: false, code: 'no_box' })
  })

  it('makeWorkFolder makes the box on demand, nests, and refuses paths outside the box', () => {
    const p = getProjectRow()
    const a = makeWorkFolder(p, '', 'LK Trendvonal EA')
    if (!a.ok) throw new Error('mk: ' + a.code)
    const b = makeWorkFolder(p, a.folder, 'BL')
    if (!b.ok) throw new Error('mk2: ' + b.code)
    expect(b.folder).toBe(a.folder + '/BL')
    expect(listWorkFolders(p).folders).toEqual([a.folder, b.folder])
    expect(existsSync(join(dir, 'Projektek', 'Robotok', ...b.folder.split('/')))).toBe(true)
    expect(makeWorkFolder(p, '..', 'x')).toMatchObject({ ok: false })
    expect(makeWorkFolder(p, 'Egyeb', 'x')).toMatchObject({ ok: false, code: 'bad_folder' })
    expect(makeWorkFolder(p, a.folder, 'a/../../b')).toMatchObject({ ok: false })
  })

  it('an item made in a chosen folder gets its own folder INSIDE it', () => {
    const p = getProjectRow()
    const a = makeWorkFolder(p, '', 'LK Trendvonal EA')
    if (!a.ok) throw new Error('mk')
    const id = mk('BL', a.folder)
    const f = ensureWorkItemFolder(getWorkItem(id)!)
    if (!f.ok) throw new Error('folder: ' + f.code)
    expect(f.folder).toBe(a.folder + '/BL')
    expect(existsSync(join(dir, 'Projektek', 'Robotok', ...f.folder.split('/')))).toBe(true)
  })

  it('a chosen folder that has vanished falls back to the default box', () => {
    const id = mk('Elveszett', 'Munkadarabok/nincs-ilyen')
    const f = ensureWorkItemFolder(getWorkItem(id)!)
    if (!f.ok) throw new Error('folder: ' + f.code)
    expect(f.folder).not.toContain('nincs-ilyen')
  })
})

function getProjectRow() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const row = getDb().prepare('SELECT * FROM projects WHERE id = ?').get(pid)
  return row as Parameters<typeof listWorkFolders>[0]
}

describe('endpoints', () => {
  beforeEach(setup)
  afterEach(teardown)

  it('POST /folders makes a folder and returns the fresh list; bad name gives a human message', async () => {
    const ok = await callWorkbench('/api/workbench/folders', 'POST', { project_id: pid, parent: '', name: 'Robotok mappa' })
    expect(ok.status).toBe(201)
    const body = ok.body as { folder: string; work_folders: { folders: string[] } }
    expect(body.work_folders.folders).toContain(body.folder)
    const bad = await callWorkbench('/api/workbench/folders', 'POST', { project_id: pid, parent: body.folder, name: '.rejtett' })
    expect(bad.status).toBe(400)
    expect(typeof (bad.body as { message: string }).message).toBe('string')
  })

  it('POST /items with a folder files the item there; a missing folder gives a human message', async () => {
    const f = await callWorkbench('/api/workbench/folders', 'POST', { project_id: pid, parent: '', name: 'LK' })
    const folder = (f.body as { folder: string }).folder
    const ok = await callWorkbench('/api/workbench/items', 'POST', { project_id: pid, title: 'BL', type: 'note', folder })
    expect(ok.status).toBe(201)
    expect((ok.body as { item: { container_folder: string } }).item.container_folder).toBe(folder)
    const bad = await callWorkbench('/api/workbench/items', 'POST', { project_id: pid, title: 'X', type: 'note', folder: 'Projektek/nem-a-doboz' })
    expect(bad.status).toBe(400)
    expect(typeof (bad.body as { message: string }).message).toBe('string')
  })

  it('POST /items makes the item its own folder at once, with no file needed', async () => {
    const r = await callWorkbench('/api/workbench/items', 'POST', { project_id: pid, title: 'BL szignal', type: 'note' })
    expect(r.status).toBe(201)
    const folder = (r.body as { item: { folder: string | null } }).item.folder
    expect(folder).toBeTruthy()
    expect(existsSync(join(dir, 'Projektek', 'Robotok', ...String(folder).split('/')))).toBe(true)
  })

  it('POST /items with a typed new folder name makes that folder and files the item into it', async () => {
    const r = await callWorkbench('/api/workbench/items', 'POST', { project_id: pid, title: 'BL szignal', type: 'note', new_folder: 'LK Trendvonal' })
    expect(r.status).toBe(201)
    const item = (r.body as { item: { folder: string; container_folder: string } }).item
    expect(item.folder.endsWith('/LK Trendvonal')).toBe(true)
    expect(item.container_folder).toBe(item.folder)
    expect(existsSync(join(dir, 'Projektek', 'Robotok', ...item.folder.split('/')))).toBe(true)
    const bad = await callWorkbench('/api/workbench/items', 'POST', { project_id: pid, title: 'X', type: 'note', new_folder: '.rejtett' })
    expect(bad.status).toBe(400)
  })

  it('POST /items flags folder_existed when the typed folder name was already there, and never wipes it', async () => {
    const a = await callWorkbench('/api/workbench/items', 'POST', { project_id: pid, title: 'Elso', type: 'note', new_folder: 'Kozos' })
    expect((a.body as { folder_existed: boolean }).folder_existed).toBe(false)
    const b = await callWorkbench('/api/workbench/items', 'POST', { project_id: pid, title: 'Masodik', type: 'note', new_folder: 'Kozos' })
    expect(b.status).toBe(201)
    expect((b.body as { folder_existed: boolean }).folder_existed).toBe(true)
    const fa = (a.body as { item: { folder: string } }).item.folder
    const fb = (b.body as { item: { folder: string } }).item.folder
    expect(fb).toBe(fa)
    expect(existsSync(join(dir, 'Projektek', 'Robotok', ...fa.split('/')))).toBe(true)
  })

  it('POST /items/:id/folder moves an existing item (and its folder) into a folder made afterwards', async () => {
    const a = await callWorkbench('/api/workbench/items', 'POST', { project_id: pid, title: 'BL szignal', type: 'note' })
    const id = (a.body as { item: { id: string } }).item.id
    const f = await callWorkbench('/api/workbench/folders', 'POST', { project_id: pid, parent: '', name: 'LK Trendvonal' })
    const folder = (f.body as { folder: string }).folder
    const m = await callWorkbench(`/api/workbench/items/${id}/folder`, 'POST', { folder })
    expect(m.status).toBe(200)
    const moved = (m.body as { moved: boolean; item: { folder: string; container_folder: string } })
    expect(moved.moved).toBe(true)
    expect(moved.item.folder).toBe(folder + '/BL szignal')
    expect(moved.item.container_folder).toBe(folder)
    expect(existsSync(join(dir, 'Projektek', 'Robotok', ...moved.item.folder.split('/')))).toBe(true)
    const again = await callWorkbench(`/api/workbench/items/${id}/folder`, 'POST', { folder })
    expect((again.body as { moved: boolean; reason: string }).reason).toBe('same_place')
    const gone = await callWorkbench(`/api/workbench/items/${id}/folder`, 'POST', { folder: 'Projektek/nem-a-doboz' })
    expect(gone.status).toBe(400)
  })

  it('new table goes into the chosen folder with its own folder and .xlsx', async () => {
    const f = await callWorkbench('/api/workbench/folders', 'POST', { project_id: pid, parent: '', name: 'LK' })
    const folder = (f.body as { folder: string }).folder
    const r = await callWorkbench('/api/workbench/items/new-table', 'POST', { project_id: pid, title: 'Osszesito', folder })
    expect(r.status).toBe(201)
    const body = r.body as { item: { id: string; source_path: string }; folder: string }
    expect(body.folder.startsWith(folder + '/')).toBe(true)
    expect(getWorkItem(body.item.id)!.folder).toBe(body.folder)
    expect(existsSync(join(dir, ...body.item.source_path.split('/')))).toBe(true)
  })

  it('new table without a folder is a stand-alone table as before; a bad folder writes no file', async () => {
    const ok = await callWorkbench('/api/workbench/items/new-table', 'POST', { project_id: pid, title: 'Onallo' })
    expect(ok.status).toBe(201)
    const bad = await callWorkbench('/api/workbench/items/new-table', 'POST', { project_id: pid, title: 'Rossz', folder: 'Projektek/masik' })
    expect(bad.status).toBe(400)
    expect(existsSync(join(dir, 'Projektek', 'Robotok', 'Rossz.xlsx'))).toBe(false)
  })

  it('trashing never asks about sub items any more', async () => {
    const id = mk('Egyedul')
    const r = await callWorkbench(`/api/workbench/items/${id}/trash`, 'POST', { deleted: true })
    expect(r.status).toBe(200)
    expect(listWorkItems(pid)).toHaveLength(0)
  })

  it('GET /items carries the folder list', async () => {
    await callWorkbench('/api/workbench/folders', 'POST', { project_id: pid, parent: '', name: 'LK' })
    const r = await callWorkbench(`/api/workbench/items?project=${pid}`, 'GET')
    expect((r.body as { work_folders: { folders: string[] } }).work_folders.folders).toHaveLength(1)
  })
})

describe('old main / sub items become folders (Boss: 1A)', () => {
  beforeEach(setup)
  afterEach(teardown)

  function legacy(withOwnContent: boolean) {
    const main = mk('LK Trendvonal EA')
    const s1 = mk('BL')
    const s2 = mk('BB')
    getDb().prepare('UPDATE work_items SET parent_item_id = ? WHERE id IN (?, ?)').run(main, s1, s2)
    // The old code made the sub folders INSIDE the main folder.
    const mf = ensureWorkItemFolder(getWorkItem(main)!)
    if (!mf.ok) throw new Error('mf')
    for (const s of [s1, s2]) {
      const f = ensureWorkItemFolder({ ...getWorkItem(s)!, container_folder: mf.folder })
      if (!f.ok) throw new Error('sf')
      getDb().prepare('UPDATE work_items SET folder = ? WHERE id = ?').run(f.folder, s)
    }
    if (withOwnContent) {
      getDb().prepare(`INSERT INTO work_item_assets (id, work_item_id, path, name, support, sha256, bytes, created_at, created_by)
        VALUES ('a1', ?, 'x/y.txt', 'y.txt', 'readable', 'h', 1, 1, NULL)`).run(main)
    }
    return { main, s1, s2, mainFolder: mf.folder }
  }

  it('an empty main item IS the folder now: it goes to the trash, the subs stay as plain items in it', () => {
    const { main, s1, s2, mainFolder } = legacy(false)
    expect(migrateSubItemsToFolders()).toBe(2)
    expect(getWorkItem(s1)!.parent_item_id ?? null).toBeNull()
    expect(getWorkItem(s1)!.folder).toBe(mainFolder + '/BL')
    expect(getWorkItem(main)!.deleted_at).not.toBeNull()
    expect(listWorkItems(pid).map((i) => i.id).sort()).toEqual([s1, s2].sort())
    expect(listWorkFolders(getProjectRow()).folders).toContain(mainFolder)
    // restorable, nothing on disk touched
    setWorkItemDeleted(main, false)
    expect(getWorkItem(main)!.deleted_at).toBeNull()
  })

  it('a main item with its own material stays a plain work item in the same folder', () => {
    const { main } = legacy(true)
    migrateSubItemsToFolders()
    expect(getWorkItem(main)!.deleted_at).toBeNull()
    expect(listWorkItems(pid)).toHaveLength(3)
  })

  it('is idempotent', () => {
    legacy(false)
    expect(migrateSubItemsToFolders()).toBe(2)
    expect(migrateSubItemsToFolders()).toBe(0)
  })
})

describe('agent context by folder', () => {
  beforeEach(setup)
  afterEach(teardown)

  it('shows the other items in the same folder and the ones inside its own folder', () => {
    const p = getProjectRow()
    const a = makeWorkFolder(p, '', 'LK')
    if (!a.ok) throw new Error('mk')
    const ids = ['BL', 'BB'].map((t) => {
      const id = mk(t, a.folder)
      const f = ensureWorkItemFolder(getWorkItem(id)!)
      if (!f.ok) throw new Error('f')
      return id
    })
    const text = familyLines(getWorkItem(ids[0]!)!).join('\n')
    expect(text).toContain('same folder')
    expect(text).toContain('BB')
    expect(text).not.toContain('"BL"')
    const lone = mk('Onallo')
    expect(familyLines(getWorkItem(lone)!)).toEqual([])
  })
})

/** The tree in the items panel only (in split layout the editor pane lists the items flat, too). */
function treeOf(html: string): string {
  const a = html.indexOf('<ul class="wb-items">')
  return a < 0 ? '' : html.slice(a, html.indexOf('</ul>', a))
}

describe('list UI', () => {
  const box = 'Munkadarabok'
  const item = (id: string, title: string, folder: string | null, container: string | null = null) => ({
    id, project_id: 'p1', type: 'document', title, status: 'draft', source_path: null, editor_type: 'text',
    current_version_id: null, created_at: 1, updated_at: 1, created_by: null, pinned_at: null, folder, container_folder: container,
  })

  function open(items: unknown[], folders: string[]) {
    const h = workbenchHarness()
    h.respond((url) => {
      // The request body is what the tests check; new-table gets a clean refusal.
      if (url.includes('/api/workbench/items/new-table')) return { status: 400, body: { error: 'x', message: 'nem most' } }
      if (url.includes('/api/workbench/folders')) return { status: 201, body: { ok: true, folder: `${box}/Uj`, created: true, work_folders: { box, folders: [...folders, `${box}/Uj`], truncated: false } } }
      if (url.includes('/api/workbench/items?')) return { status: 200, body: { ...itemsBody(items), work_folders: { box, folders, truncated: false } } }
      if (url.includes('/api/workbench/todos')) return { status: 200, body: { todos: [] } }
      return { status: 200, body: {} }
    })
    h.win.MarvinWorkbench.open('p1', 'Robotok')
    return h
  }

  it('items sit inside their folder in a collapsible tree; an empty folder shows; translated', async () => {
    const h = open(
      [item('s1', 'BL', `${box}/LK/BL`), item('s2', 'BB', `${box}/LK/BB`), item('x1', 'Egyeb', `${box}/Egyeb`)],
      [`${box}/LK`, `${box}/LK/BL`, `${box}/LK/BB`, `${box}/Egyeb`, `${box}/Ures`],
    )
    await vi.waitFor(() => expect(h.html()).toContain('data-wb-item="s1"'))
    const html = treeOf(h.html())
    expect(html).toContain('data-wb-act="folder-fold"')
    expect(html).toContain('data-wb-folder="Munkadarabok/LK"')
    expect(html).toContain('data-wb-folder="Munkadarabok/Ures"')
    // a leaf folder that IS an item's own folder is not shown a second time
    expect(html).not.toContain('data-wb-folder="Munkadarabok/LK/BL"')
    expect(html).not.toContain('data-wb-folder="Munkadarabok/Egyeb"')
    expect(html.indexOf('data-wb-folder="Munkadarabok/LK"')).toBeLessThan(html.indexOf('data-wb-item="s1"'))
    expect(untranslatedHungarian(h.html(), ['Robotok', 'Egyeb', 'Ures', 'Munkadarabok', 'Kovács weboldal'])).toBe('')
  })

  it('collapsing a folder hides its items', async () => {
    const h = open([item('s1', 'BL', `${box}/LK/BL`)], [`${box}/LK`, `${box}/LK/BL`])
    await vi.waitFor(() => expect(h.html()).toContain('data-wb-item="s1"'))
    h.click({ 'data-wb-act': 'folder-fold', 'data-wb-folder': `${box}/LK` })
    expect(treeOf(h.html())).not.toContain('data-wb-item="s1"')
    h.click({ 'data-wb-act': 'folder-fold', 'data-wb-folder': `${box}/LK` })
    expect(treeOf(h.html())).toContain('data-wb-item="s1"')
  })

  it('an old main item with content is shown inside its own folder, with the others', async () => {
    const h = open(
      [item('m1', 'LK EA', `${box}/LK`), item('s1', 'BL', `${box}/LK/BL`)],
      [`${box}/LK`, `${box}/LK/BL`],
    )
    await vi.waitFor(() => expect(h.html()).toContain('data-wb-item="m1"'))
    const html = treeOf(h.html())
    expect(html.indexOf('data-wb-folder="Munkadarabok/LK"')).toBeLessThan(html.indexOf('data-wb-item="m1"'))
    expect(html.indexOf('data-wb-item="m1"')).toBeLessThan(html.indexOf('data-wb-item="s1"'))
  })

  it('the new-item form asks which folder, also with no folder yet; no main-item question', async () => {
    const h = open([], [])
    await vi.waitFor(() => expect(h.fetchCalls.some((c) => c.url.includes('/api/workbench/items?'))).toBe(true))
    h.click({ 'data-wb-act': 'new' })
    const html = h.html()
    expect(html).toContain('id="wbNewFolder"')
    expect(html).toContain('id="wbNewFolderName"')
    expect(html).not.toContain('wbNewParent')
    expect(untranslatedHungarian(html, ['Robotok'])).toBe('')
  })

  it('"New folder" posts the name under the chosen folder and selects the new one', async () => {
    const h = open([], [`${box}/LK`])
    await vi.waitFor(() => expect(h.fetchCalls.some((c) => c.url.includes('/api/workbench/items?'))).toBe(true))
    h.click({ 'data-wb-act': 'new' })
    h.inputs['wbNewTitle'] = { value: 'Tervezet', focus() {} }
    h.inputs['wbNewFolder'] = { value: `${box}/LK`, focus() {} }
    h.inputs['wbNewFolderName'] = { value: 'Uj', focus() {} }
    h.click({ 'data-wb-act': 'mkfolder' })
    const call = h.fetchCalls.find((c) => c.url.includes('/api/workbench/folders'))
    expect(call).toBeTruthy()
    expect(JSON.parse(String(call!.init!.body))).toMatchObject({ project_id: 'p1', parent: `${box}/LK`, name: 'Uj' })
    await vi.waitFor(() => expect(h.html()).toContain(`value="${box}/Uj" selected`))
    expect(h.html()).toContain('value="Tervezet"')
  })

  it('"New table" files the table under the chosen folder', async () => {
    const h = open([], [`${box}/LK`])
    await vi.waitFor(() => expect(h.fetchCalls.some((c) => c.url.includes('/api/workbench/items?'))).toBe(true))
    h.click({ 'data-wb-act': 'new' })
    h.inputs['wbNewTitle'] = { value: 'Osszesito', focus() {} }
    h.inputs['wbNewFolder'] = { value: `${box}/LK`, focus() {} }
    h.click({ 'data-wb-act': 'create-table' })
    const call = h.fetchCalls.find((c) => c.url.includes('/api/workbench/items/new-table'))
    expect(call).toBeTruthy()
    expect(JSON.parse(String(call!.init!.body))).toMatchObject({ project_id: 'p1', title: 'Osszesito', folder: `${box}/LK` })
  })
})
