// #722 (Boss TG 3928): an item added with a file path relative to the PROJECT folder said "the document's file cannot
// be read" on opening, although the file was there -- every reader resolves the path from the Depot root.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, getDb } from '../db.js'
import { createProject, updateProject, getProject } from '../projects.js'
import { createWorkItem, getWorkItem } from '../workbench.js'
import { depotSourcePath, repairProjectRelativeSourcePaths } from '../workbench-source-path.js'
import { callWorkbench } from './helpers/workbench-route-call.js'

let dir = ''
let pid = ''
let projDir = ''
beforeEach(() => {
  initDatabase(':memory:')
  dir = mkdtempSync(join(tmpdir(), 'wb-srcpath-'))
  process.env['MARVEEN_DEPOT'] = dir
  const p = createProject({ name: 'Src' })
  if (!p.ok) throw new Error('projekt')
  pid = p.project.id
  if (!updateProject(pid, { folder_path: 'Projektek/Src' }).ok) throw new Error('projektmappa')
  projDir = join(dir, 'Projektek', 'Src')
  mkdirSync(join(projDir, 'Munkadarabok'), { recursive: true })
  writeFileSync(join(projDir, 'Munkadarabok', 'Level.docx'), 'x')
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }); delete process.env['MARVEEN_DEPOT'] })

describe('a work item file path is kept Depot-root relative', () => {
  it('completes a project-relative path, keeps a full one, leaves an unknown one alone', () => {
    const project = getProject(pid)!
    expect(depotSourcePath(project, 'Munkadarabok/Level.docx')).toBe('Projektek/Src/Munkadarabok/Level.docx')
    expect(depotSourcePath(project, 'Projektek/Src/Munkadarabok/Level.docx')).toBe('Projektek/Src/Munkadarabok/Level.docx')
    expect(depotSourcePath(project, 'Munkadarabok/Nincs.docx')).toBe('Munkadarabok/Nincs.docx')
    expect(depotSourcePath(project, null)).toBeNull()
  })

  it('an item posted with a project-relative path stores the full path', async () => {
    const c = await callWorkbench('/api/workbench/items', 'POST', { project_id: pid, type: 'document', title: 'Level', source_path: 'Munkadarabok/Level.docx' })
    expect(c.status).toBe(201)
    expect(getWorkItem(c.body.item.id as string)!.source_path).toBe('Projektek/Src/Munkadarabok/Level.docx')
  })

  it('an item stored earlier with a project-relative path is repaired, item and version alike', async () => {
    const r = createWorkItem({ project_id: pid, type: 'document', title: 'Level', source_path: 'Munkadarabok/Level.docx' })
    if (!r.ok) throw new Error('item')
    const c = await callWorkbench(`/api/workbench/items?project=${pid}`, 'GET')
    expect(c.status).toBe(200)
    expect(getWorkItem(r.item.id)!.source_path).toBe('Projektek/Src/Munkadarabok/Level.docx')
    const v = getDb().prepare('SELECT source_path FROM work_item_versions WHERE id = ?').get(r.version.id) as { source_path: string }
    expect(v.source_path).toBe('Projektek/Src/Munkadarabok/Level.docx')
    expect(repairProjectRelativeSourcePaths(pid)).toBe(0)
  })
})
