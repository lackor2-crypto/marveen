// #540 (owner, 2026-10-10): "+ New work" with a name that already exists must NOT put the new work item under the
// existing one's folder. It gets a folder of its own next to it ("Name (2)").
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase } from '../db.js'
import { createProject, updateProject } from '../projects.js'
import { callWorkbench } from './helpers/workbench-route-call.js'
import { ensureWorkItemFolder } from '../workbench-assets.js'
import { getWorkItem } from '../workbench.js'

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
})
