// Card #479: a work item may sit directly in the project folder (no group of the work items box).
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase } from '../db.js'
import { createProject, updateProject, getProject, type ProjectRow } from '../projects.js'
import { getWorkItem } from '../workbench.js'
import { ensureWorkItemFolder, migrateWorkItemFolders, PROJECT_ROOT_PLACE } from '../workbench-assets.js'
import { callWorkbench } from './helpers/workbench-route-call.js'

let pid = ''
let dir = ''
const root = () => join(dir, 'Projektek', 'Robotok')

beforeEach(() => {
  initDatabase(':memory:')
  dir = mkdtempSync(join(tmpdir(), 'wb-root-'))
  process.env['MARVEEN_DEPOT'] = dir
  const p = createProject({ name: 'Robotok' })
  if (!p.ok) throw new Error('projekt')
  pid = p.project.id
  if (!updateProject(pid, { folder_path: 'Projektek/Robotok' }).ok) throw new Error('projektmappa')
  mkdirSync(root(), { recursive: true })
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env['MARVEEN_DEPOT']
})

describe('place "directly in the project folder"', () => {
  it('POST /items with folder @project files the item there; its own folder is made in the project folder, not the box', async () => {
    const r = await callWorkbench('/api/workbench/items', 'POST', { project_id: pid, title: 'Terv', type: 'note', folder: PROJECT_ROOT_PLACE })
    expect(r.status).toBe(201)
    const item = (r.body as { item: { id: string; container_folder: string } }).item
    expect(item.container_folder).toBe(PROJECT_ROOT_PLACE)
    const f = ensureWorkItemFolder(getWorkItem(item.id)!)
    if (!f.ok) throw new Error('folder ' + f.code)
    expect(f.folder.includes('/')).toBe(false)
    expect(existsSync(join(root(), f.folder))).toBe(true)
  })

  it('the startup migration does not pull such an item back into the Work items box', async () => {
    const r = await callWorkbench('/api/workbench/items', 'POST', { project_id: pid, title: 'Terv', type: 'note', folder: PROJECT_ROOT_PLACE })
    const id = (r.body as { item: { id: string } }).item.id
    const f = ensureWorkItemFolder(getWorkItem(id)!)
    if (!f.ok) throw new Error('folder')
    const res = migrateWorkItemFolders(getProject(pid) as ProjectRow)
    expect(res.moved).toBe(0)
    expect(getWorkItem(id)!.folder).toBe(f.folder)
    expect(existsSync(join(root(), f.folder))).toBe(true)
  })

  it('a typed new group wins over @project (the item goes into the new group)', async () => {
    const r = await callWorkbench('/api/workbench/items', 'POST', { project_id: pid, title: 'X', type: 'note', folder: PROJECT_ROOT_PLACE, new_folder: 'Csoport' })
    expect(r.status).toBe(201)
    expect((r.body as { item: { container_folder: string } }).item.container_folder.endsWith('/Csoport')).toBe(true)
  })

  it('intake and a new table accept @project too', async () => {
    const i = await callWorkbench('/api/workbench/intake', 'POST', { project_id: pid, kind: 'note', text: 'Jegyzet', folder: PROJECT_ROOT_PLACE })
    expect(i.status).toBe(201)
    expect((i.body as { item: { container_folder: string } }).item.container_folder).toBe(PROJECT_ROOT_PLACE)
    const t = await callWorkbench('/api/workbench/items/new-table', 'POST', { project_id: pid, title: 'Tabla', folder: PROJECT_ROOT_PLACE })
    expect(t.status).toBe(201)
    expect((t.body as { item: { container_folder: string } }).item.container_folder).toBe(PROJECT_ROOT_PLACE)
    expect(existsSync(join(root(), 'Tabla.xlsx'))).toBe(true)
  })

  it('a plain group name is still checked against the box (nonsense folder refused)', async () => {
    const r = await callWorkbench('/api/workbench/items', 'POST', { project_id: pid, title: 'X', type: 'note', folder: 'Projektek/nem-a-doboz' })
    expect(r.status).toBe(400)
  })
})
