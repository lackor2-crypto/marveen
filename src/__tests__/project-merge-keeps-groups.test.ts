// #509 (fresh-install re-check): a merge moves a folder of the work items box as ONE unit, so its structure
// survives. Seen on a fresh instance: a new table's .xlsx was pulled out of its own folder into the box root
// (the folder stayed behind empty), and an item folder in a group ("Wohngeld 2026") lost its group. The
// project skeleton folders join their counterparts in the target, so a merge leaves no empty "(2)" twins.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readdirSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase } from '../db.js'
import { createProject, getProject } from '../projects.js'
import { mergeProjectInto } from '../project-move.js'
import { makeWorkFolder, projectWorkItemsFolder, projectMaterialsFolder } from '../workbench-assets.js'
import { createWorkItem, getWorkItem } from '../workbench.js'
import { saveCanvas } from '../workbench-canvas-store.js'
import { emptyCanvas } from '../workbench-graphic.js'
import { ensureProjectHasFolder } from '../project-files.js'
import { lifeName } from '../life-tree.js'
import { callWorkbench } from './helpers/workbench-route-call.js'

type Item = { id: string; project_id: string; folder: string | null; container_folder: string | null; source_path: string | null }

describe('merge keeps the folders of the work items box together', () => {
  let depot = ''
  let a = '', b = ''
  const abs = (rel: string) => join(depot, ...rel.split('/'))
  const mk = (name: string) => { const r = createProject({ name }); if (!r.ok) throw new Error(r.code); return r.project.id }
  const box = (pid: string) => { const r = projectWorkItemsFolder(getProject(pid)!); if (!r.ok) throw new Error(r.code); return r.folder }
  const root = (pid: string) => getProject(pid)!.folder_path as string
  const group = (pid: string, name: string) => { const g = makeWorkFolder(getProject(pid)!, '', name); if (!g.ok) throw new Error(g.code); return g.folder }
  beforeEach(() => {
    initDatabase(':memory:')
    depot = mkdtempSync(join(tmpdir(), 'marveen-merge-groups-'))
    process.env['MARVEEN_DEPOT'] = depot
    a = mk('Regi ugyek')
    b = mk('Uj ugyek')
    for (const id of [a, b]) ensureProjectHasFolder(getProject(id)!)
  })
  afterEach(() => {
    rmSync(depot, { recursive: true, force: true })
    delete process.env['MARVEEN_DEPOT']
  })

  it('a new table stays in its own folder; no empty folder and no stray file is left', async () => {
    const r = await callWorkbench('/api/workbench/items/new-table', 'POST', { project_id: a, title: 'Koltsegek' })
    expect(r.status).toBe(201)
    const id = (r.body as { item: Item }).item.id
    expect(mergeProjectInto(a, b).ok).toBe(true)
    const it = getWorkItem(id) as Item
    expect(it.project_id).toBe(b)
    expect(it.source_path).toBe(`${root(b)}/${box(b)}/Koltsegek/Koltsegek.xlsx`)
    expect(existsSync(abs(it.source_path!))).toBe(true)
    expect(it.container_folder).toBe(`${box(b)}/Koltsegek`)
    expect(readdirSync(abs(`${root(b)}/${box(b)}`)).filter((n) => !n.startsWith('.'))).toEqual(['Koltsegek'])
  })

  it('an item folder in a group keeps its group', async () => {
    const g = group(a, 'Wohngeld 2026')
    const r = await callWorkbench('/api/workbench/items', 'POST', { project_id: a, title: 'Rajz', type: 'document', folder: g })
    expect(r.status).toBe(201)
    const id = (r.body as { item: Item }).item.id
    const before = getWorkItem(id) as Item
    expect(before.folder).toBe(`${g}/Rajz`)
    expect(mergeProjectInto(a, b).ok).toBe(true)
    const it = getWorkItem(id) as Item
    expect(it.project_id).toBe(b)
    expect(it.folder).toBe(`${box(b)}/Wohngeld 2026/Rajz`)
    expect(existsSync(abs(`${root(b)}/${it.folder}`))).toBe(true)
    expect(existsSync(abs(`${root(b)}/${box(b)}/Rajz`))).toBe(false)
  })

  it('a taken group name gets (2) and the items inside follow; the target group is untouched', async () => {
    const ga = group(a, 'Wohngeld 2026')
    group(b, 'Wohngeld 2026')
    const r = await callWorkbench('/api/workbench/items', 'POST', { project_id: a, title: 'Level', type: 'document', folder: ga })
    const id = (r.body as { item: Item }).item.id
    expect(mergeProjectInto(a, b).ok).toBe(true)
    const it = getWorkItem(id) as Item
    expect(it.folder).toBe(`${box(b)}/Wohngeld 2026 (2)/Level`)
    expect(existsSync(abs(`${root(b)}/${it.folder}`))).toBe(true)
    expect(readdirSync(abs(`${root(b)}/${box(b)}/Wohngeld 2026`)).filter((n) => !n.startsWith('.'))).toEqual([])
  })

  it('a folderless item listed in a group keeps its JSON in that group', () => {
    const g = group(a, 'Wohngeld 2026')
    const c = createWorkItem({ project_id: a, title: 'Rajz', type: 'graphic', container_folder: g })
    if (!c.ok) throw new Error(c.code)
    const s = saveCanvas(getWorkItem(c.item.id)!, emptyCanvas())
    if (!s.ok) throw new Error(s.code)
    expect(s.rel.startsWith(`${root(a)}/${g}/`)).toBe(true)
    expect(mergeProjectInto(a, b).ok).toBe(true)
    const it = getWorkItem(c.item.id) as Item
    expect(it.project_id).toBe(b)
    expect(it.container_folder).toBe(`${box(b)}/Wohngeld 2026`)
    expect(it.source_path?.startsWith(`${root(b)}/${box(b)}/Wohngeld 2026/`)).toBe(true)
    expect(existsSync(abs(it.source_path!))).toBe(true)
  })

  it('a grouped item whose file lies outside the group gets the file next to it; the link does not break', () => {
    const g = group(a, 'Wohngeld 2026')
    const mat = projectMaterialsFolder(getProject(a)!)
    if (!mat.ok) throw new Error(mat.code)
    const src = `${root(a)}/${mat.folder}/kerelem.pdf`
    mkdirSync(abs(`${root(a)}/${mat.folder}`), { recursive: true })
    writeFileSync(abs(src), 'pdf')
    const c = createWorkItem({ project_id: a, title: 'Kerelem', type: 'document', source_path: src, container_folder: g })
    if (!c.ok) throw new Error(c.code)
    expect(mergeProjectInto(a, b).ok).toBe(true)
    const it = getWorkItem(c.item.id) as Item
    expect(it.source_path).toBe(`${root(b)}/${box(b)}/Wohngeld 2026/kerelem.pdf`)
    expect(readFileSync(abs(it.source_path!), 'utf8')).toBe('pdf')
  })

  it('the hidden snapshot folder joins the target one instead of landing beside it as "(2)"', () => {
    for (const [pid, id] of [[a, 'aaaa1111'], [b, 'bbbb2222']]) {
      mkdirSync(abs(`${root(pid)}/.marveen-items`), { recursive: true })
      writeFileSync(abs(`${root(pid)}/.marveen-items/${id}.json`), '{}')
    }
    const bRoot = root(b)
    expect(mergeProjectInto(a, b).ok).toBe(true)
    expect(readdirSync(abs(bRoot)).filter((n) => n.startsWith('.marveen-items'))).toEqual(['.marveen-items'])
    expect(readdirSync(abs(`${bRoot}/.marveen-items`)).sort()).toEqual(['aaaa1111.json', 'bbbb2222.json'])
  })

  it('the knowledge base joins the target one: no "Tudasbazis (2)" after every merge', () => {
    const kb = lifeName('knowledgeBase')
    expect(existsSync(abs(`${root(a)}/${kb}`)) && existsSync(abs(`${root(b)}/${kb}`))).toBe(true)
    writeFileSync(abs(`${root(a)}/${kb}/jegyzet.md`), 'A')
    const bRoot = root(b)
    expect(mergeProjectInto(a, b).ok).toBe(true)
    expect(readdirSync(abs(bRoot)).filter((n) => n.startsWith(kb))).toEqual([kb])
    expect(readFileSync(abs(`${bRoot}/${kb}/jegyzet.md`), 'utf8')).toBe('A')
  })

  it('an item made from a file in a group (no folder, not listed anywhere) stays next to its file', () => {
    const g = group(a, 'Wohngeld 2026')
    const src = `${root(a)}/${g}/Feltoltesek/level.pdf`
    mkdirSync(abs(`${root(a)}/${g}/Feltoltesek`), { recursive: true })
    writeFileSync(abs(src), 'pdf')
    const c = createWorkItem({ project_id: a, title: 'Level', type: 'document', source_path: src })
    if (!c.ok) throw new Error(c.code)
    expect(mergeProjectInto(a, b).ok).toBe(true)
    const it = getWorkItem(c.item.id) as Item
    expect(it.project_id).toBe(b)
    expect(it.source_path).toBe(`${root(b)}/${box(b)}/Wohngeld 2026/Feltoltesek/level.pdf`)
    expect(existsSync(abs(it.source_path!))).toBe(true)
  })

  it('a file already deeper inside the moving group stays where it is', () => {
    const g = group(a, 'Wohngeld 2026')
    const src = `${root(a)}/${g}/Feltoltesek/foto.png`
    mkdirSync(abs(`${root(a)}/${g}/Feltoltesek`), { recursive: true })
    writeFileSync(abs(src), 'png')
    const c = createWorkItem({ project_id: a, title: 'Foto', type: 'image', source_path: src, container_folder: g })
    if (!c.ok) throw new Error(c.code)
    expect(mergeProjectInto(a, b).ok).toBe(true)
    const it = getWorkItem(c.item.id) as Item
    expect(it.source_path).toBe(`${root(b)}/${box(b)}/Wohngeld 2026/Feltoltesek/foto.png`)
    expect(existsSync(abs(it.source_path!))).toBe(true)
  })
})
