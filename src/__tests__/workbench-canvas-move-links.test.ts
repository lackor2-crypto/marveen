// #491 (Boss): a work item moves AS A WHOLE and no picture path goes dead. A drawing (social post, graphic)
// saves its .canvas.json versions in the PROJECT folder while its pictures sit in the item's own folder, so
// when that folder moves (into a group, flattened into an empty group, or renamed) the saved version files
// outside it must follow too -- not only the working copy in the database.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, getDb } from '../db.js'
import { createProject, updateProject, getProject, type ProjectRow } from '../projects.js'
import { createWorkItem, getWorkItem } from '../workbench.js'
import { makeWorkFolder, ensureWorkItemFolder, moveWorkItemToFolder, renameWorkFolder } from '../workbench-assets.js'
import { applyCanvasOps, emptyCanvas, type CanvasDoc } from '../workbench-graphic.js'
import { commitCanvasChange, saveCanvasVersion, readCanvas } from '../workbench-canvas-store.js'

let pid = ''
let dir = ''
const root = () => join(dir, 'Projektek', 'Robotok')
const proj = (): ProjectRow => getProject(pid) as ProjectRow
const abs = (rel: string) => join(root(), ...rel.split('/'))

beforeEach(() => {
  initDatabase(':memory:')
  dir = mkdtempSync(join(tmpdir(), 'wb-canvasmove-'))
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

function group(name: string): string {
  const g = makeWorkFolder(proj(), '', name)
  if (!g.ok) throw new Error('mk: ' + g.code)
  return g.folder
}

function ops(doc: CanvasDoc, list: unknown[]): CanvasDoc {
  const r = applyCanvasOps(doc, list)
  if (!r.ok) throw new Error(r.code + ': ' + r.detail)
  return r.doc
}

/** A social post in group `g`: its picture in the item's own folder, two saved versions that both show it.
 *  The canvas is saved the way the dashboard saves it (no sub-folder given), so the version files land in
 *  the project folder, outside the item's own folder. */
function postIn(g: string) {
  const r = createWorkItem({ project_id: pid, title: 'Poszt', type: 'graphic', container_folder: g })
  if (!r.ok) throw new Error('item: ' + r.code)
  const f = ensureWorkItemFolder(r.item)
  if (!f.ok) throw new Error('folder: ' + f.code)
  writeFileSync(join(abs(f.folder), 'kep.jpg'), 'JPG')
  const src = `Projektek/Robotok/${f.folder}/kep.jpg`
  const first = ops(emptyCanvas(1080, 1350), [{ op: 'add', object: { id: 'foto', type: 'image', src, x: 0, y: 0, width: 1080, height: 1000 } }])
  const c1 = commitCanvasChange(getWorkItem(r.item.id)!, first, { label: 'replace' })
  if (!c1.ok) throw new Error('commit1: ' + c1.code)
  const second = ops(first, [{ op: 'add', object: { id: 'cim', type: 'text', text: 'Gomba', x: 60, y: 1100, width: 960, height: 100 } }])
  const c2 = commitCanvasChange(getWorkItem(r.item.id)!, second, { label: 'add' })
  if (!c2.ok) throw new Error('commit2: ' + c2.code)
  const v = saveCanvasVersion(getWorkItem(r.item.id)!, { reason: 'manual' })
  if (!v.ok || !v.created) throw new Error('version')
  return { id: r.item.id, folder: f.folder }
}

/** Every saved version file of the item, read from disk. */
function versionFiles(id: string): { rel: string; doc: CanvasDoc }[] {
  const rows = getDb().prepare('SELECT source_path FROM work_item_versions WHERE work_item_id = ? AND source_path IS NOT NULL ORDER BY version_no')
    .all(id) as { source_path: string }[]
  return rows.map((r) => ({ rel: r.source_path, doc: JSON.parse(readFileSync(join(dir, ...r.source_path.split('/')), 'utf8')) as CanvasDoc }))
}

function imageSrcs(doc: CanvasDoc): string[] {
  return doc.objects.filter((o) => o.type === 'image').map((o) => (o as { src: string }).src)
}

/** Every picture path -- in every saved version file AND in the working copy -- points into `folder` and exists. */
function expectLinksFollow(id: string, folder: string): void {
  const files = versionFiles(id)
  expect(files.length).toBeGreaterThanOrEqual(2)
  for (const f of files) {
    // The drawing itself stays where it was saved: in the project folder, not in the moved item folder.
    expect(f.rel.startsWith('Projektek/Robotok/') && !f.rel.includes('/Munkadarabok/')).toBe(true)
    const srcs = imageSrcs(f.doc)
    expect(srcs).toHaveLength(1)
    for (const s of srcs) {
      expect(s).toBe(`Projektek/Robotok/${folder}/kep.jpg`)
      expect(existsSync(join(dir, ...s.split('/')))).toBe(true) // no dead link
    }
  }
  const live = readCanvas(id)
  if (!live.ok) throw new Error('read')
  expect(imageSrcs(live.doc)).toEqual([`Projektek/Robotok/${folder}/kep.jpg`])
}

describe('a drawing keeps its picture links when its folder moves (#491)', () => {
  it('into an empty group: flattened directly into the group, every saved version follows', () => {
    const from = group('Innen')
    const to = group('Kozossegi posztok')
    const p = postIn(from)

    const r = moveWorkItemToFolder(getWorkItem(p.id)!, to)

    expect(r).toMatchObject({ ok: true, moved: true, folder: to })
    expect(existsSync(abs(p.folder))).toBe(false)
    expectLinksFollow(p.id, to)
  })

  it('into a group that holds another item: its own folder moves in, every saved version follows', () => {
    const from = group('Innen')
    const to = group('Kozos')
    const other = createWorkItem({ project_id: pid, title: 'Masik', type: 'note', container_folder: to })
    if (!other.ok || !ensureWorkItemFolder(other.item).ok) throw new Error('other')
    const p = postIn(from)

    const r = moveWorkItemToFolder(getWorkItem(p.id)!, to)

    expect(r).toMatchObject({ ok: true, moved: true })
    const now = getWorkItem(p.id)!.folder as string
    expect(now.startsWith(to + '/')).toBe(true)
    expectLinksFollow(p.id, now)
  })

  it('renaming the item folder: every saved version follows', () => {
    const g = group('Csoport')
    const p = postIn(g)

    const r = renameWorkFolder(proj(), p.folder, 'Facebook poszt gombakrol')

    expect(r).toMatchObject({ ok: true, renamed: true })
    expectLinksFollow(p.id, `${g}/Facebook poszt gombakrol`)
  })
})
