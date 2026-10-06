// #501: "Munkadarabba tétel" on a .pptx makes a real presentation with the slides read in, not an empty document.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase } from '../db.js'
import { createProject, updateProject, getProject } from '../projects.js'
import { applyDeckOps, emptyDeck } from '../workbench-deck.js'
import { buildDeckPptx } from '../workbench-deck-pptx.js'
import { workItemTypeForFile } from '../workbench-upload.js'
import { getWorkItem } from '../workbench.js'
import { moveWorkItemToFolder, makeWorkFolder } from '../workbench-assets.js'
import { callWorkbench } from './helpers/workbench-route-call.js'

let pid = ''
let dir = ''
beforeEach(() => {
  initDatabase(':memory:')
  dir = mkdtempSync(join(tmpdir(), 'wb-pptx-'))
  process.env['MARVEEN_DEPOT'] = dir
  const p = createProject({ name: 'Prezi' })
  if (!p.ok) throw new Error('projekt')
  pid = p.project.id
  if (!updateProject(pid, { folder_path: 'Projektek/Prezi' }).ok) throw new Error('projektmappa')
  mkdirSync(join(dir, 'Projektek', 'Prezi'), { recursive: true })
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }); delete process.env['MARVEEN_DEPOT'] })

describe('pptx -> presentation work item', () => {
  it('the type decision knows presentation files', () => {
    for (const n of ['a.pptx', 'a.PPT', 'a.odp', 'a.ppsx']) expect(workItemTypeForFile(n)).toBe('presentation')
  })

  it('a .pptx file becomes a presentation with its slides; the file stays untouched', async () => {
    const r0 = applyDeckOps(emptyDeck(), [{ op: 'addSlide', layout: 'title', title: 'Hello', body: 'x' }, { op: 'addSlide', layout: 'content', title: 'Two', body: 'y' }])
    if (!r0.ok) throw new Error(r0.detail)
    const { bytes } = buildDeckPptx(r0.doc, () => null)
    writeFileSync(join(dir, 'Projektek', 'Prezi', 'bemutato.pptx'), bytes)
    const r = await callWorkbench('/api/workbench/items', 'POST', { project_id: pid, type: 'document', title: 'bemutato', source_path: 'Projektek/Prezi/bemutato.pptx' })
    expect(r.status).toBe(201)
    expect(r.body.item.type).toBe('presentation')
    const d = await callWorkbench('/api/workbench/items/' + r.body.item.id + '/deck', 'GET')
    expect(d.status).toBe(200)
    const slides = d.body.deck.slides as { canvas: { objects: { text?: string }[] } }[]
    expect(slides).toHaveLength(2)
    expect(slides[0]!.canvas.objects.map((o) => o.text)).toContain('Hello')
    expect(readdirSync(join(dir, 'Projektek', 'Prezi'))).toContain('bemutato.pptx')
    // Boss TG 2516: importing makes no folder, and moving the item makes none either.
    const dirsIn = () => readdirSync(join(dir, 'Projektek', 'Prezi'), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
    expect(dirsIn()).toEqual([])
    const item = getWorkItem(r.body.item.id)!
    const g = makeWorkFolder(getProject(pid)!, '', 'Csoport')
    if (!g.ok) throw new Error('group')
    const walkDirs = (d: string): string[] => readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).flatMap((e) => [join(d, e.name), ...walkDirs(join(d, e.name))])
    const before = walkDirs(join(dir, 'Projektek', 'Prezi')).length
    expect(moveWorkItemToFolder(item, g.folder)).toMatchObject({ ok: true, moved: true })
    expect(walkDirs(join(dir, 'Projektek', 'Prezi')).length).toBe(before)
  })

  it('an unreadable .pptx says so in a human sentence and makes no item', async () => {
    writeFileSync(join(dir, 'Projektek', 'Prezi', 'rossz.pptx'), 'not a zip')
    const r = await callWorkbench('/api/workbench/items', 'POST', { project_id: pid, type: 'document', title: 'rossz', source_path: 'Projektek/Prezi/rossz.pptx' })
    expect(r.status).toBe(400)
    expect(r.body.error).toBe('pptx_unreadable')
    expect(String(r.body.message)).not.toBe('pptx_unreadable')
    const list = await callWorkbench('/api/workbench/items?project=' + pid, 'GET')
    expect(list.body.items).toHaveLength(0)
  })
})

describe('old document item from a pptx (made before the importer)', () => {
  it('to-presentation turns it into a presentation with the slides read in', async () => {
    const r0 = applyDeckOps(emptyDeck(), [{ op: 'addSlide', layout: 'title', title: 'Old', body: 'x' }])
    if (!r0.ok) throw new Error(r0.detail)
    writeFileSync(join(dir, 'Projektek', 'Prezi', 'regi.pptx'), buildDeckPptx(r0.doc, () => null).bytes)
    const c = await callWorkbench('/api/workbench/items', 'POST', { project_id: pid, type: 'document', title: 'regi', status: 'draft' })
    const id = c.body.item.id as string
    const { getDb } = await import('../db.js')
    getDb().prepare('UPDATE work_items SET source_path = ? WHERE id = ?').run('Projektek/Prezi/regi.pptx', id)
    const r = await callWorkbench('/api/workbench/items/' + id + '/to-presentation', 'POST', {})
    expect(r.status).toBe(200)
    expect(r.body.item.type).toBe('presentation')
    const d = await callWorkbench('/api/workbench/items/' + id + '/deck', 'GET')
    expect(d.body.deck.slides).toHaveLength(1)
  })
})
