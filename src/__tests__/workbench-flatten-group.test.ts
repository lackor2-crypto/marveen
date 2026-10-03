// An existing work item whose own folder sits inside a group can be put DIRECTLY in that group
// (#477/#479/#480): the group becomes its folder, the files move up, the emptied sub-folder goes away.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, getDb } from '../db.js'
import { createProject, updateProject, getProject, type ProjectRow } from '../projects.js'
import { createWorkItem, getWorkItem } from '../workbench.js'
import { makeWorkFolder, ensureWorkItemFolder, moveWorkItemToFolder, findWorkItemsBox, FOLDER_MARKER } from '../workbench-assets.js'

let pid = ''
let dir = ''
const root = () => join(dir, 'Projektek', 'Robotok')
const proj = (): ProjectRow => getProject(pid) as ProjectRow
const abs = (rel: string) => join(root(), ...rel.split('/'))

beforeEach(() => {
  initDatabase(':memory:')
  dir = mkdtempSync(join(tmpdir(), 'wb-flat-'))
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
function itemIn(folder: string, title: string) {
  const r = createWorkItem({ project_id: pid, title, type: 'note', container_folder: folder })
  if (!r.ok) throw new Error('item: ' + r.code)
  const f = ensureWorkItemFolder(r.item)
  if (!f.ok) throw new Error('folder: ' + f.code)
  return { id: r.item.id, folder: f.folder }
}

describe('put an existing item directly into its parent group', () => {
  it('flattens: the group becomes the folder, files move up, the sub-folder goes, every path follows', () => {
    const g = group('Prezentacio')
    const { id, folder } = itemIn(g, 'Munkapad prezi')
    const rel = `Projektek/Robotok/${folder}`
    writeFileSync(join(abs(folder), 'deck.pptx'), 'x')
    writeFileSync(join(abs(folder), FOLDER_MARKER), 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa\n')
    const db = getDb()
    db.prepare('UPDATE work_items SET source_path = ? WHERE id = ?').run(`${rel}/deck.pptx`, id)
    db.prepare("INSERT INTO work_item_assets (id, work_item_id, path, name, support, sha256, bytes, created_at) VALUES ('a1', ?, ?, 'deck.pptx', 'text', 'h', 1, 1)").run(id, `${rel}/deck.pptx`)

    const r = moveWorkItemToFolder(getWorkItem(id)!, g)

    expect(r).toMatchObject({ ok: true, moved: true, folder: g })
    expect(existsSync(join(abs(g), 'deck.pptx'))).toBe(true)
    expect(existsSync(abs(folder))).toBe(false) // the emptied own sub-folder is gone
    const after = getWorkItem(id)!
    expect(after.folder).toBe(g)
    expect(after.source_path).toBe(`Projektek/Robotok/${g}/deck.pptx`)
    expect((db.prepare("SELECT path FROM work_item_assets WHERE id = 'a1'").get() as { path: string }).path).toBe(`Projektek/Robotok/${g}/deck.pptx`)
  })

  it('a target that IS the current folder stays a no-op', () => {
    const g = group('Csoport')
    const { id, folder } = itemIn(g, 'Egy')
    const r = moveWorkItemToFolder(getWorkItem(id)!, folder)
    expect(r).toMatchObject({ ok: true, moved: false })
    expect(getWorkItem(id)!.folder).toBe(folder)
  })

  it('the work items box itself is no group: an item already directly in it stays put', () => {
    group('Seged') // creates the box
    const box = findWorkItemsBox(proj())!
    expect(box).toBeTruthy()
    const { id, folder } = itemIn(box, 'Gyoker')
    const r = moveWorkItemToFolder(getWorkItem(id)!, box)
    expect(r).toMatchObject({ ok: true, moved: false, reason: 'same_place' })
    expect(getWorkItem(id)!.folder).toBe(folder)
  })

  it('refuses without moving anything when a file of that name already sits in the group', () => {
    const g = group('Utkozes')
    const { id, folder } = itemIn(g, 'Elso')
    writeFileSync(join(abs(folder), 'kep.png'), 'a')
    writeFileSync(join(abs(g), 'kep.png'), 'b')
    const r = moveWorkItemToFolder(getWorkItem(id)!, g)
    expect(r.ok).toBe(false)
    expect(existsSync(join(abs(folder), 'kep.png'))).toBe(true)
    expect(getWorkItem(id)!.folder).toBe(folder)
  })

  it('leaves it alone when another item already uses the group folder as its own', () => {
    const g = group('Foglalt')
    const a = itemIn(g, 'A')
    const b = itemIn(g, 'B')
    getDb().prepare('UPDATE work_items SET folder = ? WHERE id = ?').run(g, b.id)
    const r = moveWorkItemToFolder(getWorkItem(a.id)!, g)
    expect(r).toMatchObject({ ok: true, moved: false, reason: 'shared' })
    expect(getWorkItem(a.id)!.folder).toBe(a.folder)
  })
  it('a TOMBSTONE of a deleted item in the group is no clash; the item keeps its content that sits OUTSIDE its folder', () => {
    const g = group('Prezentacio2')
    const { id, folder } = itemIn(g, 'Munkakpad prezentacio')
    // The item's own folder holds only its registration file; the deck lives in the project root.
    writeFileSync(join(abs(folder), 'marveen-item.json'), JSON.stringify({ format: 1, id, item: { id } }))
    writeFileSync(join(root(), 'diak.deck.json'), '{}')
    getDb().prepare('UPDATE work_items SET source_path = ? WHERE id = ?').run('Projektek/Robotok/diak.deck.json', id)
    // The group holds the tombstone of a thrown-away item.
    writeFileSync(join(abs(g), 'marveen-item.json'), JSON.stringify({ format: 1, tombstone: true, id: '535316fa', at: 'x' }))

    const r = moveWorkItemToFolder(getWorkItem(id)!, g)

    expect(r).toMatchObject({ ok: true, moved: true, folder: g })
    expect(getWorkItem(id)!.folder).toBe(g)
    expect(getWorkItem(id)!.source_path).toBe('Projektek/Robotok/diak.deck.json') // outside the folder: untouched
    expect(existsSync(join(root(), 'diak.deck.json'))).toBe(true) // nothing lost
    const snap = JSON.parse(readFileSync(join(abs(g), 'marveen-item.json'), 'utf8')) as { tombstone?: boolean; id: string }
    expect(snap.tombstone).toBeUndefined()
    expect(snap.id).toBe(id) // the item's own registration file replaced the stale tombstone
    expect(existsSync(abs(folder))).toBe(false)
  })

  it('a LIVE registration file of another item in the group is a real clash: nothing moves', () => {
    const g = group('Utkozes2')
    const { id, folder } = itemIn(g, 'Sajat')
    writeFileSync(join(abs(folder), 'marveen-item.json'), JSON.stringify({ format: 1, id, item: { id } }))
    writeFileSync(join(abs(g), 'marveen-item.json'), JSON.stringify({ format: 1, id: 'masik', item: { id: 'masik' } }))
    const r = moveWorkItemToFolder(getWorkItem(id)!, g)
    expect(r.ok).toBe(false)
    expect(existsSync(join(abs(folder), 'marveen-item.json'))).toBe(true)
    expect(JSON.parse(readFileSync(join(abs(g), 'marveen-item.json'), 'utf8')).id).toBe('masik')
    expect(getWorkItem(id)!.folder).toBe(folder)
  })
})
