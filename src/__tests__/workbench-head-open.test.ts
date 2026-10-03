// Card #476: an "Open" button next to the work items heading opens the Explorer at the work item's place.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { workbenchHarness, itemsBody, untranslatedHungarian, PROJECT } from './helpers/workbench-harness.js'
import { initDatabase } from '../db.js'
import { createProject, updateProject } from '../projects.js'
import { callWorkbench } from './helpers/workbench-route-call.js'

const ITEM = { id: 'w0', title: 'Régi', type: 'note', status: 'draft', current_version_id: 'v0', container_folder: null }
const isOpen = (c: { url: string; init?: RequestInit }) => c.init?.method === 'POST' && c.url.includes('/api/workbench/open-folder')

async function open() {
  const h = workbenchHarness()
  h.respond((url, init) => {
    if (init?.method === 'POST' && url.includes('/api/workbench/open-folder')) return { status: 200, body: { ok: true, path: 'Projektek/X/Munkadarabok', project: { id: 'p1', name: 'X' } } }
    return { status: 200, body: itemsBody([ITEM]) }
  })
  h.win.MarvinWorkbench.open('p1', PROJECT.name)
  await vi.waitFor(() => expect(h.html()).toMatch(/wb-head-open/))
  return h
}

describe('Open button in the work items heading (#476)', () => {
  it('sits next to the heading, asks for the work items box when nothing is picked, with a plain tooltip', async () => {
    const h = await open()
    expect(h.html()).toMatch(/wb-panel-head[\s\S]*wb-head-open/)
    expect(h.html()).toContain('data-wb-place="box"')
    h.click({ 'data-wb-act': 'folder-intezo', 'data-wb-place': 'box' })
    await vi.waitFor(() => expect(h.fetchCalls.some(isOpen)).toBe(true))
    expect(JSON.parse(String(h.fetchCalls.find(isOpen)!.init!.body))).toMatchObject({ project: 'p1', place: 'box', app: 'intezo' })
  })
  it('no raw Hungarian on screen', async () => {
    const h = await open()
    expect(untranslatedHungarian(h.html(), ['Régi', 'Kovács'])).toBe('')
  })
})

describe('open-folder place "box" (#476)', () => {
  let dir = ''
  let pid = ''
  beforeEach(() => {
    initDatabase(':memory:')
    dir = mkdtempSync(join(tmpdir(), 'wb-ho-'))
    process.env['MARVEEN_DEPOT'] = dir
    const p = createProject({ name: 'Diak' })
    if (!p.ok) throw new Error('projekt')
    pid = p.project.id
    if (!updateProject(pid, { folder_path: 'Projektek/Diak' }).ok) throw new Error('mappa')
    mkdirSync(join(dir, 'Projektek', 'Diak'), { recursive: true })
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); delete process.env['MARVEEN_DEPOT'] })
  it('falls back to the project folder when there is no box yet (fresh install), never an error', async () => {
    const r = await callWorkbench('/api/workbench/open-folder', 'POST', { project: pid, place: 'box', app: 'intezo' })
    expect(r.status).toBe(200)
    expect(r.body.path).toBe('Projektek/Diak')
  })
  it('opens the work items box when it exists', async () => {
    const f = await callWorkbench('/api/workbench/folders', 'POST', { project_id: pid, name: 'diak' })
    expect([200, 201]).toContain(f.status)
    const r = await callWorkbench('/api/workbench/open-folder', 'POST', { project: pid, place: 'box', app: 'intezo' })
    expect(r.status).toBe(200)
    expect(String(r.body.path)).toMatch(/^Projektek\/Diak\/.+/)
  })
})
