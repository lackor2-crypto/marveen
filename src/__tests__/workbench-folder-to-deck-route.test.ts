// Card #469, server side of the flow the UI runs: a work item from a loose file, and a deck built
// from a folder of pictures with the exact call sequence web/workbench.js sends.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase } from '../db.js'
import { createProject, updateProject } from '../projects.js'
import { makeWorkFolder } from '../workbench-assets.js'
import { getProject } from '../projects.js'
import { callWorkbench } from './helpers/workbench-route-call.js'

let pid = ''
let dir = ''
beforeEach(() => {
  initDatabase(':memory:')
  dir = mkdtempSync(join(tmpdir(), 'wb-f2d-'))
  process.env['MARVEEN_DEPOT'] = dir
  const p = createProject({ name: 'Diak' })
  if (!p.ok) throw new Error('projekt')
  pid = p.project.id
  if (!updateProject(pid, { folder_path: 'Projektek/Diak' }).ok) throw new Error('projektmappa')
  mkdirSync(join(dir, 'Projektek', 'Diak'), { recursive: true })
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }); delete process.env['MARVEEN_DEPOT'] })

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

describe('folder of pictures -> deck, loose file -> item (server)', () => {
  it('a loose file becomes an item with source_path, in its own folder', async () => {
    const f = makeWorkFolder(getProject(pid)!, '', 'Diak')
    if (!f.ok) throw new Error('mk')
    writeFileSync(join(dir, 'Projektek', 'Diak', ...f.folder.split('/'), 'ajanlat.txt'), 'szia')
    const rel = 'Projektek/Diak/' + f.folder + '/ajanlat.txt'
    const r = await callWorkbench('/api/workbench/items', 'POST', { project_id: pid, type: 'note', title: 'ajanlat', source_path: rel, folder: f.folder })
    expect(r.status).toBe(201)
    expect(r.body.item).toMatchObject({ title: 'ajanlat', type: 'note' })
  })

  it('one presentation item, one slide per picture, d1..dN in the given order, pictures resolve', async () => {
    const f = makeWorkFolder(getProject(pid)!, '', 'Diak')
    if (!f.ok) throw new Error('mk')
    const names = ['s1.png', 's2.png', 's10.png']
    for (const n of names) writeFileSync(join(dir, 'Projektek', 'Diak', ...f.folder.split('/'), n), PNG)
    const c = await callWorkbench('/api/workbench/items', 'POST', { project_id: pid, type: 'presentation', title: 'Diak', folder: f.folder })
    expect(c.status).toBe(201)
    const id = c.body.item.id as string
    const rels = names.map((n) => 'Projektek/Diak/' + f.folder + '/' + n)
    const ops: unknown[] = rels.map(() => ({ op: 'addSlide', layout: 'blank' }))
    rels.forEach((src, k) => ops.push({ op: 'slide', id: 'd' + (k + 1), ops: [{ op: 'add', object: { type: 'image', src, x: 0, y: 0, width: 1920, height: 1080, fit: 'contain', alt: names[k] } }] }))
    const r = await callWorkbench('/api/workbench/items/' + id + '/deck/ops', 'POST', { ops })
    expect([200, 201]).toContain(r.status)
    const slides = r.body.deck.slides as { id: string; canvas: { objects: { src: string }[] } }[]
    expect(slides.map((s) => s.id)).toEqual(['d1', 'd2', 'd3'])
    expect(slides.map((s) => s.canvas.objects[0]!.src)).toEqual(rels)
  })
})
