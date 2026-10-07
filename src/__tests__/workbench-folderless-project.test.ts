// TG 2895 audit: on a fresh install (or for a project made before the Depot was set) the project has no
// folder yet. The explicit writes of the Workbench -- a raw upload, a new table, a new work item -- must give
// it one instead of failing with "no folder" / "the chosen folder is gone".
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase } from '../db.js'
import { createProject, getProject } from '../projects.js'
import { makeWorkFolder, makeFreshFolder } from '../workbench-assets.js'
import { callWorkbench } from './helpers/workbench-route-call.js'

describe('folderless project on a fresh install', () => {
  let depot = ''
  let pid = ''
  beforeEach(() => {
    initDatabase(':memory:')
    depot = mkdtempSync(join(tmpdir(), 'marveen-folderless-'))
    process.env['MARVEEN_DEPOT'] = depot
    const p = createProject({ name: 'Uj Ugyfel' })
    if (!p.ok) throw new Error('projekt')
    pid = p.project.id
    expect(getProject(pid)?.folder_path ?? null).toBeNull()
  })
  afterEach(() => {
    rmSync(depot, { recursive: true, force: true })
    delete process.env['MARVEEN_DEPOT']
  })

  it('makeWorkFolder / makeFreshFolder give the project its folder first', () => {
    const r = makeWorkFolder(getProject(pid)!, '', 'Elso')
    expect(r.ok).toBe(true)
    const fp = getProject(pid)!.folder_path
    expect(fp).toBeTruthy()
    expect(existsSync(join(depot, ...String(fp).split('/')))).toBe(true)
    const p2 = createProject({ name: 'Masik' })
    if (!p2.ok) throw new Error('projekt')
    expect(makeFreshFolder(getProject(p2.project.id)!, 'Valami').ok).toBe(true)
    expect(getProject(p2.project.id)!.folder_path).toBeTruthy()
  })

  it('a raw upload lands in the new project folder', async () => {
    const r = await callWorkbench(`/api/workbench/items/upload?project=${pid}&name=a.txt`, 'POST', Buffer.from('hello'))
    expect(r.status).toBe(201)
    expect(String((r.body as { file: { rel: string } }).file.rel)).toMatch(/a\.txt$/)
  })

  it('a new table is made, not refused with folder_gone', async () => {
    const r = await callWorkbench('/api/workbench/items/new-table', 'POST', { project_id: pid, title: 'Koltsegek' })
    expect(r.status).toBe(201)
    expect(String((r.body as { item: { source_path: string } }).item.source_path)).toMatch(/Koltsegek\.xlsx$/)
  })

  it('a new work item gets its own folder', async () => {
    const r = await callWorkbench('/api/workbench/items', 'POST', { project_id: pid, title: 'Level', type: 'document' })
    expect(r.status).toBe(201)
    expect(getProject(pid)!.folder_path).toBeTruthy()
  })
})

describe('file manager move/rename re-homes work items at once (TG 2895 audit)', () => {
  it('the life move and rename routes trigger the relocate pass right after a success', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(join(__dirname, '..', 'web', 'routes', 'life.ts'), 'utf8')
    expect(src).toMatch(/pasteLife\('move'[\s\S]{0,200}if \(pasteStatus\(result\) < 300\) followWorkItems\(\)/)
    expect(src).toMatch(/renameLife\(rel[\s\S]{0,200}followWorkItems\(\)/)
    expect(src).toMatch(/import\('\.\.\/\.\.\/workbench-relocate\.js'\)[\s\S]{0,80}reconcileItemLocations\(\)/)
  })
})
