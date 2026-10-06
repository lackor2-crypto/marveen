// #492: a folder with content can be deleted from the Workbench; it goes to the Kuka with everything in it,
// its work items go to the Workbench trash, and moving it back + restoring the items makes it whole again.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, readdirSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase } from '../db.js'
import { createProject, updateProject, getProject, type ProjectRow } from '../projects.js'
import { createWorkItem, getWorkItem, listWorkItems, setWorkItemDeleted } from '../workbench.js'
import { trashRelPath } from '../life-tree.js'
import { makeWorkFolder, ensureWorkItemFolder, deleteWorkFolder } from '../workbench-assets.js'

let pid = ''
let dir = ''
const root = () => join(dir, 'Projektek', 'Robotok')
const proj = (): ProjectRow => getProject(pid) as ProjectRow
const abs = (rel: string) => join(root(), ...rel.split('/'))

beforeEach(() => {
  initDatabase(':memory:')
  dir = mkdtempSync(join(tmpdir(), 'wb-ftrash-'))
  process.env['MARVEEN_DEPOT'] = dir
  const p = createProject({ name: 'Robotok' })
  if (!p.ok) throw new Error('projekt')
  pid = p.project.id
  if (!updateProject(pid, { folder_path: 'Projektek/Robotok' }).ok) throw new Error('projektmappa')
  mkdirSync(root(), { recursive: true })
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env['MARVEEN_DEPOT']
})

function filled() {
  const g = makeWorkFolder(proj(), '', 'Kampany')
  if (!g.ok) throw new Error('mk')
  const it = createWorkItem({ project_id: pid, title: 'Poszt', type: 'note', container_folder: g.folder })
  if (!it.ok) throw new Error('item')
  const f = ensureWorkItemFolder(it.item)
  if (!f.ok) throw new Error('folder')
  writeFileSync(join(abs(f.folder), 'kep.png'), 'PIXELS')
  writeFileSync(join(abs(g.folder), 'laza.txt'), 'hello')
  return { group: g.folder, itemId: it.item.id, itemFolder: f.folder }
}

describe('deleteWorkFolder with trash', () => {
  it('without the trash flag a folder with content is still refused (nothing moves)', () => {
    const x = filled()
    expect(deleteWorkFolder(proj(), x.group)).toMatchObject({ ok: false, code: 'folder_not_empty' })
    expect(existsSync(abs(x.group))).toBe(true)
  })

  it('with it the whole folder goes to the Kuka and its work items to the Workbench trash', () => {
    const x = filled()
    const r = deleteWorkFolder(proj(), x.group, { trash: true })
    expect(r).toMatchObject({ ok: true, trashed: { items: 1 } })
    expect(existsSync(abs(x.group))).toBe(false)
    expect(listWorkItems(pid).map((i) => i.id)).not.toContain(x.itemId)
    expect(getWorkItem(x.itemId)!.deleted_at).not.toBeNull()
    const kuka = join(dir, trashRelPath())
    const stamp = readdirSync(kuka)[0]!
    const inKuka = join(kuka, stamp, 'Kampany')
    expect(existsSync(join(inKuka, 'laza.txt'))).toBe(true)
    expect(existsSync(join(inKuka, x.itemFolder.split('/').pop()!, 'kep.png'))).toBe(true)
  })

  it('moving the folder back and restoring the items makes it whole again', () => {
    const x = filled()
    deleteWorkFolder(proj(), x.group, { trash: true })
    const kuka = join(dir, trashRelPath())
    renameSync(join(kuka, readdirSync(kuka)[0]!, 'Kampany'), abs(x.group))
    setWorkItemDeleted(x.itemId, false)
    expect(listWorkItems(pid).map((i) => i.id)).toContain(x.itemId)
    expect(existsSync(join(abs(x.itemFolder), 'kep.png'))).toBe(true)
  })

  it('the work items box itself is never deleted', () => {
    const x = filled()
    const box = x.group.slice(0, x.group.lastIndexOf('/'))
    expect(deleteWorkFolder(proj(), box, { trash: true })).toMatchObject({ ok: false, code: 'folder_is_box' })
  })
})

describe('Boss TG 2522: a work item file can be moved in the Intéző too (no restriction)', () => {
  it('moveLife moves a file inside a work item folder; copyLife works; a loose file moves', async () => {
    const { moveLife, copyLife } = await import('../life-explorer.js')
    const x = filled()
    const base = 'Projektek/Robotok'
    mkdirSync(abs('Cel'), { recursive: true })
    const m = moveLife(`${base}/${x.itemFolder}/kep.png`, `${base}/Cel`, 'hu')
    expect(m.ok).toBe(true)
    expect(existsSync(join(abs(x.itemFolder), 'kep.png'))).toBe(false)
    expect(existsSync(abs('Cel/kep.png'))).toBe(true)
    expect((await copyLife(`${base}/Cel/kep.png`, `${base}/${x.group}`, 'hu')).ok).toBe(true)
    expect(moveLife(`${base}/${x.group}/laza.txt`, `${base}/Cel`, 'hu').ok).toBe(true)
  })
})
