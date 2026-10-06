// #501: "Munkadarabba tétel" on a .pptx makes a real presentation with the slides read in, not an empty document.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase } from '../db.js'
import { createProject, updateProject } from '../projects.js'
import { applyDeckOps, emptyDeck } from '../workbench-deck.js'
import { buildDeckPptx } from '../workbench-deck-pptx.js'
import { workItemTypeForFile } from '../workbench-upload.js'
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
