// Card #471: item and folder names stay one name. Repro of the deck-from-folder case first.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase } from '../db.js'
import { createProject, updateProject, getProject } from '../projects.js'
import { makeWorkFolder } from '../workbench-assets.js'
import { callWorkbench } from './helpers/workbench-route-call.js'

let pid = ''
let dir = ''
beforeEach(() => {
  initDatabase(':memory:')
  dir = mkdtempSync(join(tmpdir(), 'wb-ren-'))
  process.env['MARVEEN_DEPOT'] = dir
  const p = createProject({ name: 'Diak' })
  if (!p.ok) throw new Error('projekt')
  pid = p.project.id
  if (!updateProject(pid, { folder_path: 'Projektek/Diak' }).ok) throw new Error('projektmappa')
  mkdirSync(join(dir, 'Projektek', 'Diak'), { recursive: true })
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }); delete process.env['MARVEEN_DEPOT'] })

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

async function deckFromFolder(name: string, adopt = true): Promise<{ id: string; folder: string }> {
  const f = makeWorkFolder(getProject(pid)!, '', name)
  if (!f.ok) throw new Error('mk')
  const names = ['s1.png', 's2.png']
  for (const n of names) writeFileSync(join(dir, 'Projektek', 'Diak', ...f.folder.split('/'), n), PNG)
  const c = await callWorkbench('/api/workbench/items', 'POST', { project_id: pid, type: 'presentation', title: name, folder: f.folder, ...(adopt ? { adopt_folder: true } : {}) })
  expect(c.status).toBe(201)
  const id = c.body.item.id as string
  const rels = names.map((n) => 'Projektek/Diak/' + f.folder + '/' + n)
  const ops: unknown[] = rels.map(() => ({ op: 'addSlide', layout: 'blank' }))
  rels.forEach((src, k) => ops.push({ op: 'slide', id: 'd' + (k + 1), ops: [{ op: 'add', object: { type: 'image', src, x: 0, y: 0, width: 1920, height: 1080, fit: 'contain', alt: names[k] } }] }))
  const r = await callWorkbench('/api/workbench/items/' + id + '/deck/ops', 'POST', { ops })
  expect([200, 201]).toContain(r.status)
  return { id, folder: f.folder }
}
const onDisk = (rel: string): boolean => existsSync(join(dir, 'Projektek', 'Diak', ...rel.split('/')))

describe('one name for the work item and its folder (#471)', () => {
  it('item -> folder: a deck made from an existing folder renames that folder (the reported case)', async () => {
    const d = await deckFromFolder('diak')
    const r = await callWorkbench('/api/workbench/items/' + d.id + '/rename', 'POST', { title: 'ggg' })
    expect(r.body.folder_rename).toMatchObject({ renamed: true })
    const to = String(r.body.folder_rename.to)
    expect(to.endsWith('/ggg')).toBe(true)
    expect(onDisk(to)).toBe(true)
    expect(onDisk(d.folder)).toBe(false)
    // the slide pictures follow the folder
    const deck = await callWorkbench('/api/workbench/items/' + d.id + '/deck', 'GET')
    const srcs = (deck.body.deck.slides as { canvas: { objects: { src: string }[] } }[]).map((sl) => sl.canvas.objects[0]!.src)
    expect(srcs.every((x) => x.includes('/ggg/'))).toBe(true)
  })

  it('folder -> item: renaming the folder directly renames its work item with it', async () => {
    const d = await deckFromFolder('diak')
    const r = await callWorkbench('/api/workbench/folders/rename', 'POST', { project_id: pid, folder: d.folder, name: 'ggg' })
    expect(r.status).toBe(200)
    expect(r.body.renamed).toBe(true)
    expect(r.body.item).toMatchObject({ id: d.id, title: 'ggg' })
    expect(onDisk(String(r.body.folder))).toBe(true)
    expect(onDisk(d.folder)).toBe(false)
  })

  it('a taken folder name is a clear error both ways, nothing changes and nothing gets a suffix', async () => {
    const d = await deckFromFolder('diak')
    const other = makeWorkFolder(getProject(pid)!, '', 'ggg')
    if (!other.ok) throw new Error('mk')
    const r1 = await callWorkbench('/api/workbench/items/' + d.id + '/rename', 'POST', { title: 'ggg' })
    expect(r1.status).toBe(409)
    expect(r1.body.message).toMatch(/már van|already exists/)
    const item = await callWorkbench('/api/workbench/items/' + d.id, 'GET')
    expect(item.body.item.title).toBe('diak')
    expect(onDisk(d.folder)).toBe(true)
    const r2 = await callWorkbench('/api/workbench/folders/rename', 'POST', { project_id: pid, folder: d.folder, name: 'ggg' })
    expect(r2.status).toBe(409)
    expect(onDisk(d.folder)).toBe(true)
  })

  it('a deck from a folder that another item already owns just stays a container (no second owner)', async () => {
    const d = await deckFromFolder('diak')
    const c = await callWorkbench('/api/workbench/items', 'POST', { project_id: pid, type: 'presentation', title: 'masik', folder: d.folder, adopt_folder: true })
    expect(c.status).toBe(201)
    const r = await callWorkbench('/api/workbench/folders/rename', 'POST', { project_id: pid, folder: d.folder, name: 'ggg' })
    expect(r.status).toBe(409)
    expect(onDisk(d.folder)).toBe(true)
  })

  it('a folder shared by several items refuses the direct rename with a sentence, not a code', async () => {
    const f = makeWorkFolder(getProject(pid)!, '', 'kozos')
    if (!f.ok) throw new Error('mk')
    writeFileSync(join(dir, 'Projektek', 'Diak', ...f.folder.split('/'), 'a.txt'), 'a')
    writeFileSync(join(dir, 'Projektek', 'Diak', ...f.folder.split('/'), 'b.txt'), 'b')
    for (const n of ['a', 'b']) {
      const c = await callWorkbench('/api/workbench/items', 'POST', { project_id: pid, type: 'note', title: n, source_path: 'Projektek/Diak/' + f.folder + '/' + n + '.txt', folder: f.folder })
      expect(c.status).toBe(201)
    }
    const r = await callWorkbench('/api/workbench/folders/rename', 'POST', { project_id: pid, folder: f.folder, name: 'uj' })
    expect(r.status).toBe(409)
    expect(r.body.message).toMatch(/több munkadarab|several work items/)
    expect(onDisk(f.folder)).toBe(true)
  })

  it('an item with no folder of its own renames fine and the response says why the folder stayed', async () => {
    const f = makeWorkFolder(getProject(pid)!, '', 'kozos')
    if (!f.ok) throw new Error('mk')
    writeFileSync(join(dir, 'Projektek', 'Diak', ...f.folder.split('/'), 'a.txt'), 'a')
    const c = await callWorkbench('/api/workbench/items', 'POST', { project_id: pid, type: 'note', title: 'a', source_path: 'Projektek/Diak/' + f.folder + '/a.txt', folder: f.folder })
    const r = await callWorkbench('/api/workbench/items/' + c.body.item.id + '/rename', 'POST', { title: 'b' })
    expect(r.body.folder_rename).toMatchObject({ renamed: false, reason: 'no_folder' })
    expect(onDisk(f.folder)).toBe(true)
  })
})
