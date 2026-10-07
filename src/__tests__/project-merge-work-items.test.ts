// #509 (Boss TG 2914, A): merging a project into another carries its Workbench items along -- their folders
// go into the target's work items box, every path follows, nothing is deleted. Fresh-install shape: the
// projects start without a folder.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, getDb } from '../db.js'
import { createProject, getProject } from '../projects.js'
import { mergeProjectInto } from '../project-move.js'
import { projectWorkItemsFolder } from '../workbench-assets.js'
import { getWorkItem, setWorkItemDeleted } from '../workbench.js'
import { callWorkbench } from './helpers/workbench-route-call.js'

type Item = { id: string; folder: string | null; source_path: string | null }

describe('merge carries the work items', () => {
  let depot = ''
  let a = '', b = ''
  const abs = (rel: string) => join(depot, ...rel.split('/'))
  const mk = (name: string) => { const r = createProject({ name }); if (!r.ok) throw new Error(r.code); return r.project.id }
  const newItem = async (pid: string, title: string, type = 'document'): Promise<Item> => {
    const r = await callWorkbench('/api/workbench/items', 'POST', { project_id: pid, title, type })
    expect(r.status).toBe(201)
    return (r.body as { item: Item }).item
  }
  beforeEach(() => {
    initDatabase(':memory:')
    depot = mkdtempSync(join(tmpdir(), 'marveen-merge-wi-'))
    process.env['MARVEEN_DEPOT'] = depot
    a = mk('Regi ugyek')
    b = mk('Uj ugyek')
  })
  afterEach(() => {
    rmSync(depot, { recursive: true, force: true })
    delete process.env['MARVEEN_DEPOT']
  })

  it('moves item folders and files into the target box; the source project is gone', async () => {
    const doc = await newItem(a, 'Level')
    const tbl = await callWorkbench('/api/workbench/items/new-table', 'POST', { project_id: a, title: 'Koltsegek' })
    expect(tbl.status).toBe(201)
    const table = (tbl.body as { item: Item }).item
    const docNow = getWorkItem(doc.id) as Item
    expect(docNow.folder).toBeTruthy()
    const oldDocFolderAbs = docNow.folder ? abs(`${getProject(a)!.folder_path}/${docNow.folder}`) : null
    expect(table.source_path && existsSync(abs(table.source_path))).toBeTruthy()

    const out = mergeProjectInto(a, b)
    expect(out.ok).toBe(true)
    expect(out.ok && out.workItems).toBe(2)
    expect(getProject(a)).toBeUndefined()

    const box = projectWorkItemsFolder(getProject(b)!)
    expect(box.ok).toBe(true)
    const bRoot = getProject(b)!.folder_path as string
    for (const id of [doc.id, table.id]) {
      const it = getWorkItem(id) as Item & { project_id: string }
      expect(it.project_id).toBe(b)
      if (it.folder) {
        expect(it.folder.startsWith((box.ok ? box.folder : '') + '/')).toBe(true)
        expect(existsSync(abs(`${bRoot}/${it.folder}`))).toBe(true)
      }
      if (it.source_path) {
        expect(it.source_path.startsWith(bRoot + '/')).toBe(true)
        expect(existsSync(abs(it.source_path))).toBe(true)
      }
    }
    if (oldDocFolderAbs) expect(existsSync(oldDocFolderAbs)).toBe(false)
  })

  it('a taken folder name in the target gets (2); nothing is overwritten', async () => {
    const doc = await newItem(a, 'Level')
    const other = await newItem(b, 'Level')
    const otherFolder = (getWorkItem(other.id) as Item).folder
    const out = mergeProjectInto(a, b)
    expect(out.ok).toBe(true)
    const moved = getWorkItem(doc.id) as Item
    expect(moved.folder).not.toBe(otherFolder)
    expect(moved.folder ?? '').toMatch(/\(2\)$/)
    expect((getWorkItem(other.id) as Item).folder).toBe(otherFolder)
  })

  it('an item in the bin changes project too, its files are not touched', async () => {
    const doc = await newItem(a, 'Torolt')
    setWorkItemDeleted(doc.id, true)
    expect(mergeProjectInto(a, b).ok).toBe(true)
    const row = getDb().prepare('SELECT project_id FROM work_items WHERE id = ?').get(doc.id) as { project_id: string }
    expect(row.project_id).toBe(b)
  })

  it('a failed item move stops the merge and the source project stays', async () => {
    await newItem(a, 'Level')
    // The target's folder is unreachable, so its work items box cannot be made.
    getDb().prepare("UPDATE projects SET folder_path = 'Nincs/Ilyen' WHERE id = ?").run(b)
    const out = mergeProjectInto(a, b)
    expect(out.ok).toBe(false)
    expect(getProject(a)?.id).toBe(a)
  })
})
