// #530 (Boss TG 2833/2845): files lying in a project's work item folders are its documents too -- computed
// from the disk, once each, without dotfiles, and not again when they are linked as documents/attachments.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, getDb } from '../db.js'
import { createProject, updateProject, getProject, type ProjectRow } from '../projects.js'
import { createWorkItem } from '../workbench.js'
import { addProjectDoc } from '../workbench-doc-links.js'
import { projectItemFiles, isItemInternalFile } from '../project-item-files.js'

describe('work item folder files', () => {
  let depot = ''
  let project: ProjectRow
  let itemId = ''
  const abs = (rel: string) => join(depot, ...rel.split('/'))
  const put = (rel: string) => { mkdirSync(join(abs(rel), '..'), { recursive: true }); writeFileSync(abs(rel), 'x') }

  beforeEach(() => {
    initDatabase(':memory:')
    depot = mkdtempSync(join(tmpdir(), 'marveen-itemfiles-'))
    process.env['MARVEEN_DEPOT'] = depot
    mkdirSync(abs('Projektek/Ügy'), { recursive: true })
    const p = createProject({ name: 'Ügy' })
    if (!p.ok) throw new Error('project')
    updateProject(p.project.id, { folder_path: 'Projektek/Ügy' })
    project = getProject(p.project.id) as ProjectRow
    const w = createWorkItem({ project_id: project.id, title: 'Beadvány', type: 'document' })
    if (!w.ok) throw new Error('item')
    itemId = w.item.id
    mkdirSync(abs('Projektek/Ügy/Munkadarabok/Beadvány'), { recursive: true })
    getDb().prepare('UPDATE work_items SET folder = ? WHERE id = ?').run('Munkadarabok/Beadvány', itemId)
  })
  afterEach(() => {
    rmSync(depot, { recursive: true, force: true })
    delete process.env['MARVEEN_DEPOT']
  })

  it('an empty folder lists nothing', () => {
    expect(projectItemFiles(project.id)).toEqual({ files: [], truncated: false })
  })

  it('lists the files and the sub-folder ones, skips dotfiles', () => {
    const base = 'Projektek/Ügy/Munkadarabok/Beadvány'
    put(base + '/beadvany.docx'); put(base + '/beadvany_DE.docx'); put(base + '/Mellékletek/a.pdf'); put(base + '/.tmp')
    const r = projectItemFiles(project.id)
    expect(r.files.map((f) => [f.name, f.sub, f.item]).sort()).toEqual([
      ['a.pdf', 'Mellékletek', 'Beadvány'],
      ['beadvany.docx', '', 'Beadvány'],
      ['beadvany_DE.docx', '', 'Beadvány'],
    ])
    expect(r.files.every((f) => f.item_id === itemId && f.size === 1)).toBe(true)
  })

  it('a file that is already a linked document is not listed twice', async () => {
    const base = 'Projektek/Ügy/Munkadarabok/Beadvány'
    put(base + '/beadvany.docx'); put(base + '/masik.pdf')
    expect((await addProjectDoc(project.id, base + '/beadvany.docx', { role: 'source' }, 't')).ok).toBe(true)
    expect(projectItemFiles(project.id).files.map((f) => f.name)).toEqual(['masik.pdf'])
  })

  it('the program\'s own files (registration file, canvas/deck/timeline models) are never listed', () => {
    const base = 'Projektek/Ügy/Munkadarabok/Beadvány'
    put(base + '/marveen-item.json'); put(base + '/diak.deck.json'); put(base + '/plakat.canvas.json'); put(base + '/reklam.timeline.json')
    put(base + '/Verziók/marveen-item.json'); put(base + '/.marveen-id'); put(base + '/beadvany.docx')
    expect(projectItemFiles(project.id).files.map((f) => f.name)).toEqual(['beadvany.docx'])
  })

  it('the internal-name rule: own names out, a user file called like a model but plain stays', () => {
    for (const n of ['marveen-item.json', 'marveen-brand.json', 'x.deck.json', 'X.CANVAS.JSON', 'a.timeline.json']) expect(isItemInternalFile(n)).toBe(true)
    for (const n of ['adatok.json', 'beadvany.docx', 'deck.pdf', 'marveen.docx']) expect(isItemInternalFile(n)).toBe(false)
  })

  it('#539: two work items sharing one folder both own its files (opening either finds them)', () => {
    const base = 'Projektek/Ügy/Munkadarabok/Beadvány'
    const w2 = createWorkItem({ project_id: project.id, title: 'Másik', type: 'document' })
    if (!w2.ok) throw new Error('item2')
    getDb().prepare('UPDATE work_items SET folder = ? WHERE id = ?').run('Munkadarabok/Beadvány', w2.item.id)
    put(base + '/kozos.docx')
    const r = projectItemFiles(project.id)
    expect(r.files.length).toBe(1)
    expect([...r.files[0].item_ids].sort()).toEqual([itemId, w2.item.id].sort())
  })
})
