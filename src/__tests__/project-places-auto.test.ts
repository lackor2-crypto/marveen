// #530 (Boss TG 8544): the project's places in the Life tree are COMPUTED from its documents,
// attachments, official copies and work items -- not typed in. A folder appears once, with a count
// and the reasons; the hand-added places stay and are marked; the tree being detached is not "no place".
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase } from '../db.js'
import { createProject, updateProject, getProject, type ProjectRow } from '../projects.js'
import { createWorkItem } from '../workbench.js'
import { addProjectDoc, linkLifeFileAsAnnex } from '../workbench-doc-links.js'
import { addProjectPlace } from '../project-places.js'
import { projectPlacesView } from '../project-places-auto.js'
import { moveDocumentsPrefix } from '../life-doc-ids.js'
import { resolveProjectFile } from '../workbench-docmodel-world.js'

describe('the places of a project are found by the system', () => {
  let depot = ''
  let project: ProjectRow
  let itemId = ''
  const abs = (rel: string) => join(depot, ...rel.split('/'))
  const put = (rel: string) => { mkdirSync(join(abs(rel), '..'), { recursive: true }); writeFileSync(abs(rel), 'x') }

  beforeEach(() => {
    initDatabase(':memory:')
    depot = mkdtempSync(join(tmpdir(), 'marveen-autoplaces-'))
    process.env['MARVEEN_DEPOT'] = depot
    mkdirSync(abs('Projektek/Ügy'), { recursive: true })
    const p = createProject({ name: 'Ügy' })
    if (!p.ok) throw new Error('project')
    updateProject(p.project.id, { folder_path: 'Projektek/Ügy' })
    project = getProject(p.project.id) as ProjectRow
    const w = createWorkItem({ project_id: project.id, title: 'Beadvány', type: 'document' })
    if (!w.ok) throw new Error('item')
    itemId = w.item.id
  })
  afterEach(() => {
    rmSync(depot, { recursive: true, force: true })
    delete process.env['MARVEEN_DEPOT']
  })

  it('an empty project has no places (no invention, no error)', () => {
    expect(projectPlacesView(project.id)).toEqual([])
  })

  it('a linked document of any role puts its folder on the list; one folder once, with its count and reasons', async () => {
    put('Család/Hatóság/a.pdf'); put('Család/Hatóság/b.pdf'); put('Család/Más/c.pdf')
    expect((await addProjectDoc(project.id, 'Család/Hatóság/a.pdf', { role: 'source' }, 't')).ok).toBe(true)
    expect((await addProjectDoc(project.id, 'Család/Hatóság/b.pdf', { role: 'reference' }, 't')).ok).toBe(true)
    expect((await addProjectDoc(project.id, 'Család/Más/c.pdf', { role: 'related' }, 't')).ok).toBe(true)
    const v = projectPlacesView(project.id)
    expect(v.map((x) => [x.rel, x.count, x.auto, x.manual, x.exists, x.reachable])).toEqual([
      ['Család/Hatóság', 2, true, false, true, true],
      ['Család/Más', 1, true, false, true, true],
    ])
    expect(v[0]!.reasons.map((r) => r.kind + ':' + r.name).sort()).toEqual(['reference:b.pdf', 'source:a.pdf'])
  })

  it('an annex attached from the Life tree and a work item folder count too', async () => {
    put('Család/Nyugdíj/igazolas.pdf')
    const r = await linkLifeFileAsAnnex(itemId, 'Család/Nyugdíj/igazolas.pdf', { title: 'Igazolás' }, (p: string) => resolveProjectFile(project, p), 't')
    expect(r.ok).toBe(true)
    mkdirSync(abs('Projektek/Ügy/Munkadarabok/Beadvány'), { recursive: true })
    getDbForTest().prepare('UPDATE work_items SET folder = ? WHERE id = ?').run('Munkadarabok/Beadvány', itemId)
    const v = projectPlacesView(project.id)
    const rels = v.map((x) => x.rel).sort()
    expect(rels).toEqual(['Család/Nyugdíj', 'Projektek/Ügy/Munkadarabok/Beadvány'])
    expect(v.find((x) => x.rel === 'Család/Nyugdíj')!.reasons[0]!.kind).toBe('attachment')
    expect(v.find((x) => x.rel.endsWith('Beadvány'))!.reasons[0]).toEqual({ kind: 'item', name: 'Beadvány', item_id: itemId })
  })

  it('item_counts says which work item put a place on the list; a document or a hand-added place belongs to none', async () => {
    put('Család/Hatóság/a.pdf'); mkdirSync(abs('Család/Kézi'), { recursive: true })
    await addProjectDoc(project.id, 'Család/Hatóság/a.pdf', { role: 'source' }, 't')
    addProjectPlace(project.id, 'Család/Kézi', 't')
    mkdirSync(abs('Projektek/Ügy/Munkadarabok/Beadvány'), { recursive: true })
    getDbForTest().prepare('UPDATE work_items SET folder = ? WHERE id = ?').run('Munkadarabok/Beadvány', itemId)
    const v = projectPlacesView(project.id)
    expect(v.find((x) => x.rel === 'Család/Hatóság')!.item_counts).toEqual({})
    expect(v.find((x) => x.rel === 'Család/Kézi')!.item_counts).toEqual({})
    expect(v.find((x) => x.rel.endsWith('Beadvány'))!.item_counts).toEqual({ [itemId]: 1 })
  })

  it('an item without a recorded folder: the folder of its materials is its place', async () => {
    const { attachAsset } = await import('../workbench-assets.js')
    const it = (await import('../workbench.js')).getWorkItem(itemId)!
    attachAsset(it, 'szamla.txt', Buffer.from('x'), {})
    const v = projectPlacesView(project.id)
    expect(v.length).toBe(1)
    expect(v[0]!.reasons[0]).toEqual({ kind: 'item', name: 'Beadvány', item_id: itemId })
  })

  it('a work item whose folder is stored as another project\'s own tree path is that folder, not base + path', async () => {
    mkdirSync(abs('Projektek/Iroda/Munkadarabok/Terv'), { recursive: true })
    const { getDb } = await import('../db.js')
    getDb().prepare('UPDATE work_items SET folder = ? WHERE id = ?').run('Projektek/Iroda/Munkadarabok/Terv', itemId)
    const v = projectPlacesView(project.id)
    expect(v.map((x) => [x.rel, x.exists])).toEqual([['Projektek/Iroda/Munkadarabok/Terv', true]])
  })

  it('computed on every call: a moved folder is followed, not remembered', async () => {
    put('Család/Régi/a.pdf')
    await addProjectDoc(project.id, 'Család/Régi/a.pdf', { role: 'source' }, 't')
    renameSync(abs('Család/Régi'), abs('Család/Új'))
    moveDocumentsPrefix('Család/Régi', 'Család/Új')
    const v = projectPlacesView(project.id)
    expect(v.map((x) => x.rel)).toEqual(['Család/Új'])
    expect(v[0]!.exists).toBe(true)
  })

  it('a hand-added place stays, marked; one that is also found is one row with both marks', async () => {
    put('Család/Hatóság/a.pdf'); mkdirSync(abs('Család/Kézi'), { recursive: true })
    await addProjectDoc(project.id, 'Család/Hatóság/a.pdf', { role: 'source' }, 't')
    addProjectPlace(project.id, 'Család/Kézi', 't')
    addProjectPlace(project.id, 'Család/Hatóság', 't')
    const v = projectPlacesView(project.id)
    expect(v.map((x) => [x.rel, x.manual, x.auto, x.count])).toEqual([
      ['Család/Hatóság', true, true, 1],
      ['Család/Kézi', true, false, 0],
    ])
  })

  it('the Life tree not being there keeps the row and says "not reachable", not "no such place"', async () => {
    put('Család/Hatóság/a.pdf')
    await addProjectDoc(project.id, 'Család/Hatóság/a.pdf', { role: 'source' }, 't')
    process.env['MARVEEN_DEPOT'] = join(depot, 'nincs-ilyen-lemez')
    const v = projectPlacesView(project.id)
    expect(v.length).toBe(1)
    expect(v[0]).toMatchObject({ rel: 'Család/Hatóság', exists: false, reachable: false, auto: true })
  })
})

import { getDb } from '../db.js'
function getDbForTest() { return getDb() }
