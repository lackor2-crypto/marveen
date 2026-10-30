// #676 (Boss TG 9372/9375): EVERY work item of EVERY type has five standard subfolders from the start: Finished
// materials, Attachments, Uploads, Agent, Debate. New items get them at creation; existing ones are topped up with
// EMPTY folders only (existing content, and the first generation of the names, are never touched).
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, existsSync, readdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, getDb } from '../db.js'
import { createProject, updateProject, getProject } from '../projects.js'
import { createWorkItem, getWorkItem } from '../workbench.js'
import { ensureWorkItemFolder, ensureAllAttachmentsFolders } from '../workbench-assets.js'
import { createReportDocument } from '../debate-export-doc.js'
import { callWorkbench } from './helpers/workbench-route-call.js'

const FIVE = ['Elkészített anyagok', 'Mellékletek', 'Feltöltések', 'Agent', 'Vitáztatás', 'Kiváltó irat'] // #794: the sixth is the trigger document folder

describe('the five standard folders of a work item', () => {
  let depot = ''
  let pid = ''
  const projDir = () => join(depot, 'Projektek', 'Iroda')
  const subs = (rel: string) => readdirSync(join(projDir(), rel), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()

  beforeEach(() => {
    initDatabase(':memory:')
    depot = mkdtempSync(join(tmpdir(), 'marveen-wb-five-'))
    mkdirSync(projDir(), { recursive: true })
    process.env['MARVEEN_DEPOT'] = depot
    const p = createProject({ name: 'Iroda fejlesztese' })
    if (!p.ok) throw new Error('project')
    pid = p.project.id
    if (!updateProject(pid, { folder_path: 'Projektek/Iroda' }).ok) throw new Error('folder')
  })
  afterEach(() => {
    rmSync(depot, { recursive: true, force: true })
    delete process.env['MARVEEN_DEPOT']
  })

  it('a new item of any type made from the UI route gets its folder with all five subfolders', async () => {
    for (const type of ['document', 'note', 'video', 'image', 'graphic']) {
      const r = await callWorkbench('/api/workbench/items', 'POST', JSON.stringify({ project_id: pid, type, title: `Munka ${type}` }), { 'content-type': 'application/json' })
      expect(r.status, type).toBe(201)
      const folder = getWorkItem(r.body.item.id)!.folder
      expect(folder, type).toBeTruthy()
      expect(subs(folder!), type).toEqual([...FIVE].sort())
    }
  })

  it('a new table gets the five subfolders too', async () => {
    const r = await callWorkbench('/api/workbench/items/new-table', 'POST', JSON.stringify({ project_id: pid, title: 'Költségvetés' }), { 'content-type': 'application/json' })
    expect(r.status).toBe(201)
    const folder = getWorkItem(r.body.item.id)!.folder
    expect(folder).toBeTruthy()
    expect(subs(folder!)).toEqual([...FIVE].sort())
  })

  it('a debate report shares the origin item\'s Vitáztatás folder: no five folders (or a nested Vitáztatás) inside it', () => {
    const w = createWorkItem({ project_id: pid, title: 'Eredeti', type: 'document' })
    if (!w.ok) throw new Error('item')
    const f = ensureWorkItemFolder(w.item)
    if (!f.ok) throw new Error('folder')
    const r = createReportDocument(pid, { title: 'Vitáztatás jelentés: X', sections: [{ title: 'S', paragraphs: ['p'] }] } as never, 'test', { originItem: w.item.id })
    expect(r.ok).toBe(true)
    // #699: the report goes into the "jelentés" subfolder of the Debate folder, and nothing else is made in either
    expect(subs(`${f.folder}/Vitáztatás`)).toEqual(['jelentés'])
    expect(subs(`${f.folder}/Vitáztatás/jelentés`)).toEqual([])
  })

  it('an existing item folder is topped up with the missing EMPTY folders; content and the first-generation names stay', () => {
    const w = createWorkItem({ project_id: pid, title: 'Régi munka', type: 'document' })
    if (!w.ok) throw new Error('item')
    const f = ensureWorkItemFolder(w.item)
    if (!f.ok) throw new Error('folder')
    // simulate an old folder: first-generation names and a file inside
    rmSync(join(projDir(), f.folder, 'Agent'), { recursive: true })
    rmSync(join(projDir(), f.folder, 'Vitáztatás'), { recursive: true })
    mkdirSync(join(projDir(), f.folder, 'Agentnek'))
    mkdirSync(join(projDir(), f.folder, 'Vitáztatás jelentés'))
    writeFileSync(join(projDir(), f.folder, 'Agentnek', 'minta.png'), 'x')
    rmSync(join(projDir(), f.folder, 'Mellékletek'), { recursive: true })
    // an item that was never provisioned (made before the one-time marker existed)
    getDb().prepare('DELETE FROM work_item_std_folders WHERE work_item_id = ?').run(w.item.id)
    getDb().exec('DELETE FROM auto_folders_made') // from before the made-once registry (#681)
    ensureAllAttachmentsFolders()
    const have = subs(f.folder)
    expect(have).toContain('Mellékletek')
    expect(have).toContain('Agentnek')
    expect(have).toContain('Vitáztatás jelentés')
    expect(have).not.toContain('Agent')
    expect(have).not.toContain('Vitáztatás')
    expect(readFileSync(join(projDir(), f.folder, 'Agentnek', 'minta.png'), 'utf8')).toBe('x')
    expect(existsSync(join(projDir(), f.folder, 'Elkészített anyagok'))).toBe(true)
    expect(getProject(pid)).toBeTruthy()
  })

  // #681 (Boss TG 9541): nothing is made automatically inside a sub-document; a folder the user deleted stays deleted.
  it('a sub-document (a debate report item) gets NO folder at all, and a deleted folder is not made again', () => {
    const w = createWorkItem({ project_id: pid, title: 'Eredeti', type: 'document' })
    if (!w.ok) throw new Error('item')
    const f = ensureWorkItemFolder(w.item)
    if (!f.ok) throw new Error('folder')
    const r = createReportDocument(pid, { title: 'Wohngeld vita', sections: [{ title: 'S', paragraphs: ['p'] }] } as never, 'test', { originItem: w.item.id })
    if (!r.ok) throw new Error('report')
    const sub = getWorkItem((r as unknown as { item: { id: string } }).item.id)!
    const sf = ensureWorkItemFolder(sub)
    expect(sf.ok).toBe(true)
    if (sf.ok) expect(subs(sf.folder)).toEqual([])
    ensureAllAttachmentsFolders()
    if (sf.ok) expect(subs(sf.folder)).toEqual([])
    // the user deletes a folder of the real item: neither a re-open nor the sweep brings it back
    rmSync(join(projDir(), f.folder, 'Mellékletek'), { recursive: true })
    ensureWorkItemFolder(w.item)
    ensureAllAttachmentsFolders()
    expect(subs(f.folder)).not.toContain('Mellékletek')
  })
})

describe('the Kiváltó irat folder is topped up on items provisioned before it existed', () => {
  it('an already provisioned item gets it once; a deleted one stays deleted', () => {
    const depot = mkdtempSync(join(tmpdir(), 'marveen-wb-trig-'))
    try {
      initDatabase(':memory:')
      mkdirSync(join(depot, 'Projektek', 'Iroda'), { recursive: true })
      process.env['MARVEEN_DEPOT'] = depot
      const p = createProject({ name: 'Iroda fejlesztese' })
      if (!p.ok) throw new Error('project')
      updateProject(p.project.id, { folder_path: 'Projektek/Iroda' })
      const w = createWorkItem({ project_id: p.project.id, title: 'Regi', type: 'document' })
      if (!w.ok) throw new Error('item')
      const f = ensureWorkItemFolder(w.item)
      if (!f.ok) throw new Error('folder')
      const dir = join(depot, 'Projektek', 'Iroda', getWorkItem(w.item.id)!.folder!)
      // simulate the pre-#794 state: provisioned, but no trigger folder and nothing remembered about it
      rmSync(join(dir, 'Kiváltó irat'), { recursive: true, force: true })
      getDb().prepare("DELETE FROM auto_folders_made WHERE rel LIKE '%Kiváltó irat%'").run()
      ensureAllAttachmentsFolders()
      expect(existsSync(join(dir, 'Kiváltó irat'))).toBe(true)
      rmSync(join(dir, 'Kiváltó irat'), { recursive: true, force: true })
      ensureAllAttachmentsFolders()
      expect(existsSync(join(dir, 'Kiváltó irat'))).toBe(false)
    } finally {
      rmSync(depot, { recursive: true, force: true })
      delete process.env['MARVEEN_DEPOT']
    }
  })
})

describe('an own-file item (no folder of its own) gets Kiváltó irat in its container folder too', () => {
  it('topped up once in a container that already has the standard folders; a plain group folder is left alone', () => {
    const depot = mkdtempSync(join(tmpdir(), 'marveen-wb-cont-'))
    try {
      initDatabase(':memory:')
      const proj = join(depot, 'Projektek', 'Iroda')
      mkdirSync(join(proj, 'Munkadarabok', 'AOK', 'Mellékletek'), { recursive: true })
      mkdirSync(join(proj, 'Munkadarabok', 'Csoport'), { recursive: true })
      process.env['MARVEEN_DEPOT'] = depot
      const p = createProject({ name: 'Iroda fejlesztese' })
      if (!p.ok) throw new Error('project')
      updateProject(p.project.id, { folder_path: 'Projektek/Iroda' })
      const a = createWorkItem({ project_id: p.project.id, title: 'AOK level', type: 'document' })
      const b = createWorkItem({ project_id: p.project.id, title: 'Csoportos', type: 'document' })
      if (!a.ok || !b.ok) throw new Error('item')
      const db = getDb()
      db.prepare("UPDATE work_items SET folder = NULL, container_folder = ? WHERE id = ?").run('Munkadarabok/AOK', a.item.id)
      db.prepare("UPDATE work_items SET folder = NULL, container_folder = ? WHERE id = ?").run('Munkadarabok/Csoport', b.item.id)
      ensureAllAttachmentsFolders()
      expect(existsSync(join(proj, 'Munkadarabok', 'AOK', 'Kiváltó irat'))).toBe(true)
      expect(existsSync(join(proj, 'Munkadarabok', 'Csoport', 'Kiváltó irat'))).toBe(false)
      // deleted by the user: stays deleted
      rmSync(join(proj, 'Munkadarabok', 'AOK', 'Kiváltó irat'), { recursive: true })
      ensureAllAttachmentsFolders()
      expect(existsSync(join(proj, 'Munkadarabok', 'AOK', 'Kiváltó irat'))).toBe(false)
    } finally {
      rmSync(depot, { recursive: true, force: true })
      delete process.env['MARVEEN_DEPOT']
    }
  })
})
