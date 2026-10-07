// Card #474: "make it a work item" on a file in a deeper / accented folder outside the work items box must not fail with bad_folder.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase } from '../db.js'
import { createProject, updateProject } from '../projects.js'
import { callWorkbench } from './helpers/workbench-route-call.js'

let pid = ''
let dir = ''
beforeEach(() => {
  initDatabase(':memory:')
  dir = mkdtempSync(join(tmpdir(), 'wb-fi-'))
  process.env['MARVEEN_DEPOT'] = dir
  const p = createProject({ name: 'Diak' })
  if (!p.ok) throw new Error('projekt')
  pid = p.project.id
  if (!updateProject(pid, { folder_path: 'Projektek/Diak' }).ok) throw new Error('projektmappa')
  mkdirSync(join(dir, 'Projektek', 'Diak', 'Munkapad terv', 'diák'), { recursive: true })
  writeFileSync(join(dir, 'Projektek', 'Diak', 'Munkapad terv', 'diák', 's03.png'), 'x')
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }); delete process.env['MARVEEN_DEPOT'] })

describe('file -> work item in a nested accented folder (#474)', () => {
  it('creates the item, no bad_folder', async () => {
    const rel = 'Projektek/Diak/Munkapad terv/diák/s03.png'
    const c = await callWorkbench('/api/workbench/items', 'POST', { project_id: pid, type: 'image', title: 's03', source_path: rel, folder: 'Munkapad terv/diák' })
    expect(c.status).toBe(201)
    expect(c.body.item.source_path).toBe(rel)
  })
  it('a deck made from ticked files needs no folder at all (from_files)', async () => {
    const c = await callWorkbench('/api/workbench/items', 'POST', { project_id: pid, type: 'presentation', title: 'Valogatas', from_files: true })
    expect(c.status).toBe(201)
  })
  it('a deck made from ticked files gets its own folder named after it (TG 2675)', async () => {
    const c = await callWorkbench('/api/workbench/items', 'POST', { project_id: pid, type: 'presentation', title: 'Valogatas', from_files: true })
    expect(c.status).toBe(201)
    expect(String(c.body.item.container_folder || '')).toMatch(/Valogatas$/)
  })
  // TG 2856: the loose file's menu sends the folder as the Explorer path (project folder included).
  it('the file menu sends the folder with the project folder prefix: still no bad_folder', async () => {
    const rel = 'Projektek/Diak/Munkapad terv/diák/s03.png'
    const c = await callWorkbench('/api/workbench/items', 'POST', { project_id: pid, type: 'image', title: 's03', source_path: rel, folder: 'Projektek/Diak/Munkapad terv/diák' })
    expect(c.status).toBe(201)
    expect(c.body.item.source_path).toBe(rel)
  })
  it('a file straight in the project folder: folder equal to the project folder is the project root', async () => {
    writeFileSync(join(dir, 'Projektek', 'Diak', 'logo.png'), 'x')
    const c = await callWorkbench('/api/workbench/items', 'POST', { project_id: pid, type: 'graphic', title: 'logo', source_path: 'Projektek/Diak/logo.png', folder: 'Projektek/Diak' })
    expect(c.status).toBe(201)
  })
  it('a picture made into a presentation (from_files) with the prefixed folder is accepted', async () => {
    const c = await callWorkbench('/api/workbench/items', 'POST', { project_id: pid, type: 'presentation', title: 's03', folder: 'Projektek/Diak/Munkapad terv/diák', from_files: true })
    expect(c.status).toBe(201)
  })
  it('a typo folder with no file is still refused', async () => {
    const c = await callWorkbench('/api/workbench/items', 'POST', { project_id: pid, type: 'image', title: 'x', folder: 'Nincs/ilyen' })
    expect(c.status).toBe(400)
  })
})
