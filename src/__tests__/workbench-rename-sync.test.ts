// Card #478 (replaces the #471 two-way name link): a work item's name and its folder's name are independent.
// A folder is a named group; renaming it renames only the group, and every path under it follows.
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

const slideSrcs = async (id: string): Promise<string[]> => {
  const deck = await callWorkbench('/api/workbench/items/' + id + '/deck', 'GET')
  return (deck.body.deck.slides as { canvas: { objects: { src: string }[] } }[]).map((sl) => sl.canvas.objects[0]!.src)
}

describe('work item name and folder name are independent (#478)', () => {
  it('item rename touches only the item: the folder and the pictures stay', async () => {
    const d = await deckFromFolder('diak')
    const before = await slideSrcs(d.id)
    const r = await callWorkbench('/api/workbench/items/' + d.id + '/rename', 'POST', { title: 'ggg' })
    expect(r.status).toBe(200)
    expect(r.body.item.title).toBe('ggg')
    expect(r.body.folder_rename).toMatchObject({ renamed: false, reason: 'independent' })
    expect(onDisk(d.folder)).toBe(true)
    expect(await slideSrcs(d.id)).toEqual(before)
  })

  it('a taken name is no problem for the item: the item name is its own, nothing is refused or suffixed', async () => {
    const d = await deckFromFolder('diak')
    const other = makeWorkFolder(getProject(pid)!, '', 'ggg')
    if (!other.ok) throw new Error('mk')
    const r = await callWorkbench('/api/workbench/items/' + d.id + '/rename', 'POST', { title: 'ggg' })
    expect(r.status).toBe(200)
    expect(onDisk(d.folder)).toBe(true)
    expect(onDisk(other.folder)).toBe(true)
  })

  it('folder rename touches only the folder: the item keeps its name, its pictures and its saved paths follow', async () => {
    const d = await deckFromFolder('diak')
    const r = await callWorkbench('/api/workbench/folders/rename', 'POST', { project_id: pid, folder: d.folder, name: 'ggg' })
    expect(r.status).toBe(200)
    expect(r.body.renamed).toBe(true)
    expect(onDisk(String(r.body.folder))).toBe(true)
    expect(onDisk(d.folder)).toBe(false)
    const item = (r.body.items as { id: string; title: string; folder: string | null }[]).find((x) => x.id === d.id)!
    expect(item.title).toBe('diak')
    expect(item.folder).toBe(r.body.folder)
    expect((await slideSrcs(d.id)).every((x) => x.includes('/ggg/'))).toBe(true)
  })

  it('a taken folder name is a clear error, nothing changes and nothing gets a suffix', async () => {
    const d = await deckFromFolder('diak')
    const other = makeWorkFolder(getProject(pid)!, '', 'ggg')
    if (!other.ok) throw new Error('mk')
    const r = await callWorkbench('/api/workbench/folders/rename', 'POST', { project_id: pid, folder: d.folder, name: 'ggg' })
    expect(r.status).toBe(409)
    expect(r.body.message).toMatch(/már van|already exists/)
    expect(onDisk(d.folder)).toBe(true)
  })

  it('a folder with several items in it renames fine: every item keeps its name and its paths follow', async () => {
    const f = makeWorkFolder(getProject(pid)!, '', 'kozos')
    if (!f.ok) throw new Error('mk')
    for (const n of ['a', 'b']) writeFileSync(join(dir, 'Projektek', 'Diak', ...f.folder.split('/'), n + '.txt'), n)
    const ids: string[] = []
    for (const n of ['a', 'b']) {
      const c = await callWorkbench('/api/workbench/items', 'POST', { project_id: pid, type: 'note', title: n, source_path: 'Projektek/Diak/' + f.folder + '/' + n + '.txt', folder: f.folder })
      expect(c.status).toBe(201)
      ids.push(c.body.item.id)
    }
    const r = await callWorkbench('/api/workbench/folders/rename', 'POST', { project_id: pid, folder: f.folder, name: 'uj' })
    expect(r.status).toBe(200)
    const items = r.body.items as { id: string; title: string; source_path: string; container_folder: string }[]
    for (const id of ids) {
      const it = items.find((x) => x.id === id)!
      expect(it.source_path.includes('/uj/')).toBe(true)
      expect(it.container_folder).toBe(r.body.folder)
      expect(onDisk(it.source_path.replace('Projektek/Diak/', ''))).toBe(true)
    }
    expect(items.filter((x) => ids.includes(x.id)).map((x) => x.title).sort()).toEqual(['a', 'b'])
  })

  it('an item without a folder of its own renames fine', async () => {
    const f = makeWorkFolder(getProject(pid)!, '', 'kozos')
    if (!f.ok) throw new Error('mk')
    writeFileSync(join(dir, 'Projektek', 'Diak', ...f.folder.split('/'), 'a.txt'), 'a')
    const c = await callWorkbench('/api/workbench/items', 'POST', { project_id: pid, type: 'note', title: 'a', source_path: 'Projektek/Diak/' + f.folder + '/a.txt', folder: f.folder })
    const r = await callWorkbench('/api/workbench/items/' + c.body.item.id + '/rename', 'POST', { title: 'b' })
    expect(r.status).toBe(200)
    expect(r.body.item.title).toBe('b')
    expect(onDisk(f.folder)).toBe(true)
  })
})
