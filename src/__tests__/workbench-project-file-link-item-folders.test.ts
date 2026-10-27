// Boss TG 4484: a Life-tree file can be linked from the right-click menu of an item's Attachments / Uploads folder
// (as an annex / a material of THAT item). Only the plain work items box (and the item's other folders) stay refused.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase } from '../db.js'
import { createProject, updateProject, getProject } from '../projects.js'
import { createWorkItem } from '../workbench.js'
import { ensureWorkItemFolder, listWorkFolders, findWorkItemsBox, itemSubfolderOf } from '../workbench-assets.js'
import { callWorkbench } from './helpers/workbench-route-call.js'

let dir = ''
let pid = ''
let itemFolder = ''
let itemId = ''
beforeEach(() => {
  initDatabase(':memory:')
  dir = mkdtempSync(join(tmpdir(), 'wb-flink-item-'))
  process.env['MARVEEN_DEPOT'] = dir
  const p = createProject({ name: 'Nemet' })
  if (!p.ok) throw new Error('projekt')
  pid = p.project.id
  if (!updateProject(pid, { folder_path: 'Projektek/Nemet' }).ok) throw new Error('projektmappa')
  mkdirSync(join(dir, 'Projektek', 'Nemet'), { recursive: true })
  mkdirSync(join(dir, 'Hatosagok'), { recursive: true })
  writeFileSync(join(dir, 'Hatosagok', 'level.pdf'), 'pdf-bytes')
  const w = createWorkItem({ project_id: pid, title: 'Billigkeitsantrag', type: 'document' })
  if (!w.ok) throw new Error('munkadarab')
  const f = ensureWorkItemFolder(w.item)
  if (!f.ok) throw new Error('munkadarab-mappa')
  itemFolder = f.folder
  itemId = w.item.id
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }); delete process.env['MARVEEN_DEPOT'] })

const link = (folder: string) => callWorkbench('/api/workbench/project-file-link', 'POST', { project: pid, folder, rel: 'Hatosagok/level.pdf' })
const folderList = () => listWorkFolders(getProject(pid)!)
const sub = (names: string[]) => folderList().folders.find((f) => f.startsWith(itemFolder + '/') && names.includes(f.slice(itemFolder.length + 1)))

describe('project-file-link into an item folder', () => {
  it('finds the item of its Attachments / Uploads subfolder, and nothing for the box or the item folder', () => {
    const project = getProject(pid)!
    const att = sub(['Mellékletek', 'Attachments'])
    const up = sub(['Feltöltések', 'Uploads'])
    expect(att && up).toBeTruthy()
    expect(itemSubfolderOf(project, att!)).toMatchObject({ kind: 'annex', item: { id: itemId } })
    expect(itemSubfolderOf(project, up!)).toMatchObject({ kind: 'uploads', item: { id: itemId } })
    expect(itemSubfolderOf(project, itemFolder)).toBeNull()
    expect(itemSubfolderOf(project, findWorkItemsBox(project)!)).toBeNull()
  })
  it('the work items box itself and the item folder stay refused', async () => {
    expect((await link(findWorkItemsBox(getProject(pid)!)!)).status).toBe(400)
    expect((await link(itemFolder)).status).toBe(400)
  })
  it('Attachments: the file becomes an annex of the item and shows there as a link, the original stays', async () => {
    const att = sub(['Mellékletek', 'Attachments'])!
    const r = await link(att)
    expect(r.status).toBe(201)
    const f = (r.body.work_folders.files[att] || []).find((x: { name: string }) => x.name === 'level.pdf')
    expect(f).toMatchObject({ linked: true, annex: true, link: { kind: 'annex', item: itemId } })
    // taking the link off: the annex goes, the original is not touched
    const del = await callWorkbench(`/api/workbench/items/${itemId}/outline/annexes/${f.link.id}`, 'DELETE')
    expect(del.status).toBe(200)
    expect((folderList().files[att] || []).some((x) => x.name === 'level.pdf')).toBe(false)
    expect((await callWorkbench('/api/workbench/project-file-link', 'POST', { project: pid, folder: att, rel: 'Hatosagok/level.pdf' })).status).toBe(201)
  })
  it('Uploads: the file becomes a material of the item and shows there as a link', async () => {
    const up = sub(['Feltöltések', 'Uploads'])!
    const r = await link(up)
    expect(r.status).toBe(201)
    const f = (r.body.work_folders.files[up] || []).find((x: { name: string }) => x.name === 'level.pdf')
    expect(f).toMatchObject({ linked: true, annex: true, link: { kind: 'asset', item: itemId } })
    const del = await callWorkbench(`/api/workbench/items/${itemId}/assets/${f.link.id}`, 'DELETE')
    expect(del.status).toBeLessThan(300)
    expect((folderList().files[up] || []).some((x) => x.name === 'level.pdf')).toBe(false)
  })
  it('a missing Life file is refused in both folders', async () => {
    for (const names of [['Mellékletek', 'Attachments'], ['Feltöltések', 'Uploads']]) {
      const r = await callWorkbench('/api/workbench/project-file-link', 'POST', { project: pid, folder: sub(names)!, rel: 'Hatosagok/nincs.pdf' })
      expect(r.status).toBe(404)
    }
  })
})
