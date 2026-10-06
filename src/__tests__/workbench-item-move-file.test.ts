// TG 2692 (A): moving a work item that has no folder of its own moves its file there too, and the item follows.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase } from '../db.js'
import { createProject, updateProject, getProject, type ProjectRow } from '../projects.js'
import { createWorkItem, getWorkItem } from '../workbench.js'
import { makeWorkFolder, moveWorkItemToFolder } from '../workbench-assets.js'

let dir = ''
let pid = ''
beforeEach(() => {
  initDatabase(':memory:')
  dir = mkdtempSync(join(tmpdir(), 'wb-itemmove-'))
  process.env['MARVEEN_DEPOT'] = dir
  const p = createProject({ name: 'Robotok' })
  if (!p.ok) throw new Error('projekt')
  pid = p.project.id
  if (!updateProject(pid, { folder_path: 'Projektek/Robotok' }).ok) throw new Error('projektmappa')
  mkdirSync(join(dir, 'Projektek', 'Robotok'), { recursive: true })
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env['MARVEEN_DEPOT']
})

describe('moving a folderless work item moves its file with it', () => {
  it('the file lies in the project root, the item goes into a group: file and source_path follow', () => {
    const project = getProject(pid) as ProjectRow
    const g = makeWorkFolder(project, '', 'Prezentacio')
    if (!g.ok) throw new Error('group: ' + g.code)
    writeFileSync(join(dir, 'Projektek', 'Robotok', 'diak.deck.json'), '{}')
    const r = createWorkItem({ project_id: pid, title: 'Diak', type: 'presentation', source_path: 'Projektek/Robotok/diak.deck.json' })
    if (!r.ok) throw new Error('item: ' + r.code)
    const out = moveWorkItemToFolder(r.item, g.folder)
    expect(out).toMatchObject({ ok: true, moved: true })
    const now = getWorkItem(r.item.id)!
    expect(now.source_path).toBe(`Projektek/Robotok/${g.folder}/diak.deck.json`)
    expect(existsSync(join(dir, 'Projektek', 'Robotok', g.folder, 'diak.deck.json'))).toBe(true)
    expect(existsSync(join(dir, 'Projektek', 'Robotok', 'diak.deck.json'))).toBe(false)
  })
})
