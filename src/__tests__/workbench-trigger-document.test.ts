// #794 (Boss TG 3665/3670): the "Kiváltó irat" folder of every work item, the "no trigger document" mark, and what the
// assistant is told about it.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase } from '../db.js'
import { createProject, updateProject, getProject } from '../projects.js'
import { getWorkItem } from '../workbench.js'
import { triggerStateOf, triggerContextLine } from '../workbench-trigger.js'
import { callWorkbench } from './helpers/workbench-route-call.js'

describe('trigger document folder', () => {
  let depot = ''
  let pid = ''
  beforeEach(() => {
    initDatabase(':memory:')
    depot = mkdtempSync(join(tmpdir(), 'marveen-wb-trigger-'))
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

  async function newItem() {
    const r = await callWorkbench('/api/workbench/items', 'POST', JSON.stringify({ project_id: pid, type: 'document', title: 'Válasz' }), { 'content-type': 'application/json' })
    expect(r.status).toBe(201)
    return getWorkItem(r.body.item.id)!
  }

  it('a new item gets the folder, and with nothing in it the assistant is told to warn the owner first', async () => {
    const it = await newItem()
    expect(existsSync(join(depot, 'Projektek', 'Iroda', it.folder!, 'Kiváltó irat'))).toBe(true)
    const st = triggerStateOf(getProject(pid)!, it)
    expect(st.folder).toBe(`${it.folder}/Kiváltó irat`)
    expect(st.files).toEqual([])
    expect(triggerContextLine(st)).toMatch(/NONE is linked[\s\S]*FIRST reply/)
  })

  it('a file in the folder is reported as the trigger document', async () => {
    const it = await newItem()
    writeFileSync(join(depot, 'Projektek', 'Iroda', it.folder!, 'Kiváltó irat', 'Hiánypótlás.pdf'), 'x')
    const st = triggerStateOf(getProject(pid)!, getWorkItem(it.id)!)
    expect(st.files).toEqual(['Hiánypótlás.pdf'])
    expect(triggerContextLine(st)).toContain('Hiánypótlás.pdf')
  })

  it('the "no trigger document" mark is saved, shown to the assistant, and can be taken back', async () => {
    const it = await newItem()
    const on = await callWorkbench(`/api/workbench/items/${it.id}/no-trigger`, 'POST', JSON.stringify({ no_trigger: true }), { 'content-type': 'application/json' })
    expect(on.status).toBe(200)
    const st = triggerStateOf(getProject(pid)!, getWorkItem(it.id)!)
    expect(st.noTrigger).toBe(true)
    expect(triggerContextLine(st)).toMatch(/own initiative/)
    const bad = await callWorkbench(`/api/workbench/items/${it.id}/no-trigger`, 'POST', JSON.stringify({ no_trigger: 'x' }), { 'content-type': 'application/json' })
    expect(bad.status).toBe(400)
    await callWorkbench(`/api/workbench/items/${it.id}/no-trigger`, 'POST', JSON.stringify({ no_trigger: false }), { 'content-type': 'application/json' })
    expect(triggerStateOf(getProject(pid)!, getWorkItem(it.id)!).noTrigger).toBe(false)
  })
})

// Boss TG 3676: the "Approve and move" click of the Life-tree move must work in a browser that holds only the dashboard
// token (no sign-in session); only a script (no Sec-Fetch-Site: same-origin) is refused.
describe('life-move approval in token mode', () => {
  let depot = ''
  let id = ''
  beforeEach(async () => {
    initDatabase(':memory:')
    depot = mkdtempSync(join(tmpdir(), 'marveen-wb-lm-tok-'))
    mkdirSync(join(depot, 'Projektek', 'Iroda'), { recursive: true })
    process.env['MARVEEN_DEPOT'] = depot
    const p = createProject({ name: 'Iroda fejlesztese' })
    if (!p.ok) throw new Error('project')
    updateProject(p.project.id, { folder_path: 'Projektek/Iroda' })
    const r = await callWorkbench('/api/workbench/items', 'POST', JSON.stringify({ project_id: p.project.id, type: 'document', title: 'Berlin' }), { 'content-type': 'application/json' })
    id = r.body.item.id
  })
  afterEach(() => { rmSync(depot, { recursive: true, force: true }); delete process.env['MARVEEN_DEPOT'] })

  it('a same-origin browser click with the token is accepted, a bare token call is refused', async () => {
    const body = JSON.stringify({ moves: [] })
    const bare = await callWorkbench(`/api/workbench/items/${id}/life-move`, 'POST', body, undefined, { kind: 'token' })
    expect(bare.status).toBe(403)
    const click = await callWorkbench(`/api/workbench/items/${id}/life-move`, 'POST', body, { 'sec-fetch-site': 'same-origin' }, { kind: 'token' })
    expect(click.status).not.toBe(403)
  })
})
