// #921 (Boss TG 6314/6315): the "no trigger document" tick is the folder's, so it holds for every work item that shares
// the Kiváltó irat folder (a Hungarian and a German version in one container), whichever item the tick was saved on.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, getDb } from '../db.js'
import { createProject, updateProject, getProject } from '../projects.js'
import { getWorkItem, setWorkItemNoTrigger } from '../workbench.js'
import { triggerStateOf, triggerBlocksWork } from '../workbench-trigger.js'
import { callWorkbench } from './helpers/workbench-route-call.js'

describe('#921 the no-trigger tick belongs to the folder', () => {
  let depot = ''
  let pid = ''
  beforeEach(() => {
    initDatabase(':memory:')
    depot = mkdtempSync(join(tmpdir(), 'marveen-wb-trig921-'))
    mkdirSync(join(depot, 'Projektek', 'Iroda'), { recursive: true })
    process.env['MARVEEN_DEPOT'] = depot
    const p = createProject({ name: 'Iroda fejlesztese' })
    if (!p.ok) throw new Error('project')
    pid = p.project.id
    if (!updateProject(pid, { folder_path: 'Projektek/Iroda' }).ok) throw new Error('folder')
  })
  afterEach(() => {
    rmSync(depot, { recursive: true, force: true })
    delete process.env['MARVEEN_DEPOT']
  })

  it('a tick saved on one item frees its sibling in the same folder, and an unrelated item stays held', async () => {
    const mk = async (title: string) => {
      const r = await callWorkbench('/api/workbench/items', 'POST', JSON.stringify({ project_id: pid, type: 'document', title }), { 'content-type': 'application/json' })
      expect(r.status).toBe(201)
      return getWorkItem(r.body.item.id)!
    }
    const a = await mk('DE')
    const b = await mk('HU')
    const other = await mk('Mas')
    // two items on ONE folder, as a language pair in one container
    getDb().prepare('UPDATE work_items SET folder = ? WHERE id = ?').run(a.folder, b.id)
    mkdirSync(join(depot, 'Projektek', 'Iroda', a.folder!, 'Kiváltó irat'), { recursive: true })
    setWorkItemNoTrigger(a.id, true)
    const project = getProject(pid)!
    expect(triggerBlocksWork(triggerStateOf(project, getWorkItem(a.id)!))).toBe(false)
    expect(triggerBlocksWork(triggerStateOf(project, getWorkItem(b.id)!))).toBe(false)
    expect(triggerBlocksWork(triggerStateOf(project, getWorkItem(other.id)!))).toBe(true)
  })
  it('unticking on one item clears the tick of its sibling too (the page draws one tick for the folder)', async () => {
    const mk = async (title: string) => {
      const r = await callWorkbench('/api/workbench/items', 'POST', JSON.stringify({ project_id: pid, type: 'document', title }), { 'content-type': 'application/json' })
      expect(r.status).toBe(201)
      return getWorkItem(r.body.item.id)!
    }
    const a = await mk('DE')
    const b = await mk('HU')
    getDb().prepare('UPDATE work_items SET folder = ? WHERE id = ?').run(a.folder, b.id)
    mkdirSync(join(depot, 'Projektek', 'Iroda', a.folder!, 'Kiváltó irat'), { recursive: true })
    const post = (id: string, on: boolean) => callWorkbench(`/api/workbench/items/${id}/no-trigger`, 'POST', JSON.stringify({ no_trigger: on }), { 'content-type': 'application/json' })
    // the owner ticked on the second item (older data), then unticks the one the page shows
    expect((await post(b.id, true)).status).toBe(200)
    expect((await post(a.id, false)).status).toBe(200)
    const project = getProject(pid)!
    expect(triggerBlocksWork(triggerStateOf(project, getWorkItem(a.id)!))).toBe(true)
    expect(triggerBlocksWork(triggerStateOf(project, getWorkItem(b.id)!))).toBe(true)
    // and ticking on one item frees both again
    expect((await post(a.id, true)).status).toBe(200)
    expect(triggerBlocksWork(triggerStateOf(project, getWorkItem(b.id)!))).toBe(false)
  })
})
