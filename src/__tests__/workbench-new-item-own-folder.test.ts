// #540 (owner, 2026-10-10): "+ New work" with a name that already exists must NOT put the new work item under the
// existing one's folder. It gets a folder of its own next to it ("Name (2)").
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase } from '../db.js'
import { createProject, updateProject } from '../projects.js'
import { callWorkbench } from './helpers/workbench-route-call.js'
import { ensureWorkItemFolder, listWorkFolders } from '../workbench-assets.js'
import { getProject } from '../projects.js'
import { getDb } from '../db.js'
import { getWorkItem, setWorkItemDeleted } from '../workbench.js'

let pid = ''
let dir = ''
beforeEach(() => {
  initDatabase(':memory:')
  dir = mkdtempSync(join(tmpdir(), 'wb-own-'))
  process.env['MARVEEN_DEPOT'] = dir
  const p = createProject({ name: 'Egyeb' })
  if (!p.ok) throw new Error('projekt')
  pid = p.project.id
  if (!updateProject(pid, { folder_path: 'Projektek/Egyeb' }).ok) throw new Error('projektmappa')
  mkdirSync(join(dir, 'Projektek', 'Egyeb'), { recursive: true })
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }); delete process.env['MARVEEN_DEPOT'] })

type Item = { id: string; folder: string | null; container_folder: string | null }
const abs = (rel: string): string => join(dir, 'Projektek', 'Egyeb', ...rel.split('/'))
/** The folder the item really ends up in once something is written for it. */
function settled(id: string): string {
  const r = ensureWorkItemFolder(getWorkItem(id)!)
  if (!r.ok) throw new Error('folder')
  return r.folder
}

describe('#540: a new work item never lands under an existing one', () => {
  it('intake: the same name twice gives two sibling folders, the second numbered', async () => {
    const a = await callWorkbench('/api/workbench/intake', 'POST', { project_id: pid, kind: 'document', title: 'Uj dokumentum', text: '' })
    const b = await callWorkbench('/api/workbench/intake', 'POST', { project_id: pid, kind: 'document', title: 'Uj dokumentum', text: '' })
    expect(a.status).toBe(201)
    expect(b.status).toBe(201)
    const fa = settled((a.body.item as Item).id)
    const fb = settled((b.body.item as Item).id)
    expect(fb).not.toBe(fa)
    expect(fb.startsWith(fa + '/')).toBe(false)
    expect(fb).toBe(fa + ' (2)')
    expect(existsSync(abs(fb))).toBe(true)
    expect(existsSync(join(abs(fa), 'Uj dokumentum'))).toBe(false)
  })

  it('manual form (POST /items) and a new table behave the same', async () => {
    const a = await callWorkbench('/api/workbench/items', 'POST', { project_id: pid, title: 'Ajanlat', type: 'document' })
    const b = await callWorkbench('/api/workbench/items', 'POST', { project_id: pid, title: 'Ajanlat', type: 'document' })
    const fa = settled((a.body.item as Item).id)
    const fb = settled((b.body.item as Item).id)
    expect(fb).toBe(fa + ' (2)')
    const t = await callWorkbench('/api/workbench/items/new-table', 'POST', { project_id: pid, title: 'Ajanlat' })
    expect(t.status).toBe(201)
    expect(String(t.body.folder)).toBe(fa + ' (3)')
    expect(settled((t.body.item as Item).id)).toBe(fa + ' (3)')
  })

  it('an empty folder nobody owns is taken as it is; one with a file in it is not', async () => {
    const first = await callWorkbench('/api/workbench/intake', 'POST', { project_id: pid, kind: 'document', title: 'Elso', text: '' })
    const box = settled((first.body.item as Item).id).split('/').slice(0, -1).join('/')
    mkdirSync(abs(box + '/Ures'))
    mkdirSync(abs(box + '/Teli'))
    writeFileSync(abs(box + '/Teli/regi.txt'), 'x')
    const u = await callWorkbench('/api/workbench/intake', 'POST', { project_id: pid, kind: 'document', title: 'Ures', text: '' })
    const f = await callWorkbench('/api/workbench/intake', 'POST', { project_id: pid, kind: 'document', title: 'Teli', text: '' })
    expect(settled((u.body.item as Item).id)).toBe(box + '/Ures')
    expect(settled((f.body.item as Item).id)).toBe(box + '/Teli (2)')
  })

  it('a picked container that is another live work item\'s own folder is replaced by the level beside it', async () => {
    const a = await callWorkbench('/api/workbench/items', 'POST', { project_id: pid, title: 'Ajanlat', type: 'document' })
    const fa = settled((a.body.item as Item).id)
    const box = fa.split('/').slice(0, -1).join('/')
    const b = await callWorkbench('/api/workbench/items', 'POST', { project_id: pid, title: 'Masik', type: 'document', folder: fa })
    expect(b.status).toBe(201)
    const fb = settled((b.body.item as Item).id)
    expect(fb.startsWith(fa + '/')).toBe(false)
    expect(fb).toBe(box + '/Masik')
    expect(existsSync(join(abs(fa), 'Masik'))).toBe(false)
  })

  it('a hand-named group (not a work item\'s own folder) still takes the new work item inside', async () => {
    const a = await callWorkbench('/api/workbench/items', 'POST', { project_id: pid, title: 'Ajanlat', type: 'document' })
    const box = settled((a.body.item as Item).id).split('/').slice(0, -1).join('/')
    mkdirSync(abs(box + '/Csoport'))
    const b = await callWorkbench('/api/workbench/items', 'POST', { project_id: pid, title: 'Masik', type: 'document', folder: box + '/Csoport' })
    expect(b.status).toBe(201)
    expect(settled((b.body.item as Item).id)).toBe(box + '/Csoport/Masik')
  })

  it('a trashed work item whose folder is gone from the disk does not switch the protection off for a live twin', async () => {
    const a = await callWorkbench('/api/workbench/intake', 'POST', { project_id: pid, kind: 'document', title: 'Uj dokumentum', text: '' })
    const fa = settled((a.body.item as Item).id)
    const box = fa.split('/').slice(0, -1).join('/')
    // The owner trashed it and its folder left the disk (the live state of 'Munkadarabok/Uj dokumentum').
    setWorkItemDeleted((a.body.item as Item).id, true)
    rmSync(abs(fa), { recursive: true, force: true })
    const b = await callWorkbench('/api/workbench/intake', 'POST', { project_id: pid, kind: 'document', title: 'Uj dokumentum', text: '' })
    const fb = settled((b.body.item as Item).id)
    expect(fb).toBe(fa) // the free name is reused: the same folder as the trashed one
    const c = await callWorkbench('/api/workbench/items', 'POST', { project_id: pid, title: 'Harmadik', type: 'document', folder: fb })
    expect(c.status).toBe(201)
    const fc = settled((c.body.item as Item).id)
    expect(fc.startsWith(fb + '/')).toBe(false)
    expect(fc).toBe(box + '/Harmadik')
  })

  it('a trashed work item whose folder is still on the disk keeps that folder: the new twin takes a numbered one', async () => {
    const a = await callWorkbench('/api/workbench/intake', 'POST', { project_id: pid, kind: 'document', title: 'Regi', text: '' })
    const fa = settled((a.body.item as Item).id)
    setWorkItemDeleted((a.body.item as Item).id, true)
    expect(existsSync(abs(fa))).toBe(true)
    const b = await callWorkbench('/api/workbench/intake', 'POST', { project_id: pid, kind: 'document', title: 'Regi', text: '' })
    expect(settled((b.body.item as Item).id)).toBe(fa + ' (2)')
  })

  it('the folder list names the work items\' own folders; a hand-named group (even with one work item in it) and a trashed twin are not', async () => {
    const a = await callWorkbench('/api/workbench/items', 'POST', { project_id: pid, title: 'Ajanlat', type: 'document' })
    const b = await callWorkbench('/api/workbench/items', 'POST', { project_id: pid, title: 'Ajanlat', type: 'document' })
    const c = await callWorkbench('/api/workbench/items', 'POST', { project_id: pid, title: 'Wohngeld', type: 'document' })
    const d = await callWorkbench('/api/workbench/items', 'POST', { project_id: pid, title: 'Regi', type: 'document' })
    const fa = settled((a.body.item as Item).id)
    const fb = settled((b.body.item as Item).id)
    const fc = settled((c.body.item as Item).id)
    const fd = settled((d.body.item as Item).id)
    const box = fa.split('/').slice(0, -1).join('/')
    // Wohngeld lives in a hand-named group: its folder is "<box>/Wohngeld 2026", not a name made from the title.
    mkdirSync(abs(box + '/Wohngeld 2026'), { recursive: true })
    getDb().prepare('UPDATE work_items SET folder = ? WHERE id = ?').run(box + '/Wohngeld 2026', (c.body.item as Item).id)
    setWorkItemDeleted((d.body.item as Item).id, true)
    const own = listWorkFolders(getProject(pid)!).own_folders
    expect(own).toContain(fa)
    expect(own).toContain(fb)
    expect(own).not.toContain(box + '/Wohngeld 2026')
    expect(own).not.toContain(fc)
    expect(own).not.toContain(fd)
    // every own folder is in the folder list too (the picker leaves out exactly these)
    const all = listWorkFolders(getProject(pid)!).folders
    for (const f of own) expect(all).toContain(f)
  })
})
