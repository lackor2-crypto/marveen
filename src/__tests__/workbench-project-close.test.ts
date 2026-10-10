// #530, phase 5: what is still open before a project is closed (reported, not forbidden),
// and the projects a project belongs with.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, getDb } from '../db.js'
import { createProject, updateProject } from '../projects.js'
import { createWorkItem, createWorkItemVersion, getWorkItem, type WorkItemRow } from '../workbench.js'
import { addSection, addBlock } from '../workbench-docmodel.js'
import { contentHash } from '../workbench-docfinal.js'
import { fileOfficialCopy, recordSent } from '../workbench-docsent.js'
import { addProjectDoc } from '../workbench-doc-links.js'
import { addRelatedProject, listRelatedProjects, projectCloseCheck, relatableProjects, removeRelatedProject } from '../workbench-project-close.js'

describe('before closing a project', () => {
  let depot = ''
  let pid = ''
  let other = ''
  let item: WorkItemRow
  const abs = (rel: string) => join(depot, ...rel.split('/'))
  const check = () => Object.fromEntries(projectCloseCheck(pid).items.map((i) => [i.key, [i.ok, i.n, i.total]]))

  function finalise(): void {
    writeFileSync(abs('Projektek/Ügy/F.pdf'), 'FINAL')
    const v = createWorkItemVersion(item.id, { metadata_json: JSON.stringify({ final: true, label: 'Végleges', content_hash: contentHash(item), pdf_path: 'F.pdf', pdf_name: 'F.pdf', files: [{ path: 'F.pdf', name: 'F.pdf', role: 'main' }], accepted_by: 'o', accepted_at: 1, accepted_text: '', reviewed_at: 1, reviewed_by: 'o', check: [] }) })
    if (!v.ok) throw new Error('version')
    item = getWorkItem(item.id) as WorkItemRow
  }

  beforeEach(() => {
    initDatabase(':memory:')
    depot = mkdtempSync(join(tmpdir(), 'marveen-close-'))
    process.env['MARVEEN_DEPOT'] = depot
    mkdirSync(abs('Projektek/Ügy'), { recursive: true })
    mkdirSync(abs('Család/Kimenő'), { recursive: true })
    const p = createProject({ name: 'Jobcenter ügy' }); const o = createProject({ name: 'Bírósági ügy' })
    if (!p.ok || !o.ok) throw new Error('project')
    pid = p.project.id; other = o.project.id
    updateProject(pid, { folder_path: 'Projektek/Ügy' })
    const w = createWorkItem({ project_id: pid, title: 'Fellebbezés', type: 'document' })
    if (!w.ok) throw new Error('item')
    const s = addSection(w.item.id, '1.', { status: 'done' })
    if (!s.ok) throw new Error('section')
    addBlock(w.item.id, s.section.id, { text: 'Szöveg.', author: 'owner' })
    item = getWorkItem(w.item.id) as WorkItemRow
  })
  afterEach(() => { rmSync(depot, { recursive: true, force: true }); delete process.env['MARVEEN_DEPOT'] })

  it('walks from "nothing final" to "everything in order", one step at a time', async () => {
    expect(check()['finals']).toEqual([false, 0, 1])
    expect(projectCloseCheck(pid).ready).toBe(false)
    finalise()
    let c = check()
    expect([c['finals'], c['unsent'], c['unfiled']]).toEqual([[true, 1, 1], [false, 1, undefined], [true, 0, undefined]])
    const s = recordSent(item, { date: '2026-10-08', recipient: 'Jobcenter' }, 'o')
    if (!s.ok) throw new Error('sent')
    c = check()
    expect([c['unsent'], c['unfiled']]).toEqual([[true, 0, undefined], [false, 1, undefined]])
    expect((await fileOfficialCopy(item, s.id, 'Család/Kimenő', 'o')).ok).toBe(true)
    c = check()
    expect([c['unsent'], c['unfiled'], c['missing_docs']]).toEqual([[true, 0, undefined], [true, 0, undefined], [true, 0, undefined]])
    // The work item itself is still a draft: said, and it alone keeps "ready" false.
    expect(c['open_items']).toEqual([false, 1, 1])
    getDb().prepare("UPDATE work_items SET status = 'done' WHERE id = ?").run(item.id)
    expect(projectCloseCheck(pid).ready).toBe(true)
  })

  it('a final the text has moved on from is reported as stale, and is not counted as final', () => {
    finalise()
    addSection(item.id, '2.', { status: 'done' })
    const c = check()
    expect(c['finals']).toEqual([false, 0, 1])
    expect(c['stale_finals']).toEqual([false, 1, undefined])
  })

  it('a linked document that is not at its place, and an open kanban card, are counted', async () => {
    writeFileSync(abs('Család/irat.pdf'), 'x')
    expect((await addProjectDoc(pid, 'Család/irat.pdf', {}, 'o')).ok).toBe(true)
    expect(check()['missing_docs']).toEqual([true, 0, undefined])
    rmSync(abs('Család/irat.pdf'))
    expect(check()['missing_docs']).toEqual([false, 1, undefined])
    // No kanban table on a fresh install: that is "no open card", not an error.
    expect(check()['open_cards']![0]).toBe(true)
  })

  it('a project without documents is not asked about finals at all', () => {
    const c = Object.fromEntries(projectCloseCheck(other).items.map((i) => [i.key, i.ok]))
    expect(Object.keys(c).sort()).toEqual(['missing_docs', 'open_cards', 'open_items'])
    expect(projectCloseCheck(other).ready).toBe(true)
  })

  it('related projects: one fact for both sides, no self link, no duplicate, removal touches nothing else', () => {
    expect(relatableProjects(pid).map((p) => p.name)).toEqual(['Bírósági ügy'])
    expect(addRelatedProject(pid, other, 'o').ok).toBe(true)
    expect(listRelatedProjects(pid).map((p) => p.name)).toEqual(['Bírósági ügy'])
    expect(listRelatedProjects(other).map((p) => p.name)).toEqual(['Jobcenter ügy'])
    expect(relatableProjects(pid)).toEqual([])
    const dup = addRelatedProject(other, pid, 'o')
    expect(dup.ok === false && dup.code).toBe('duplicate')
    const self = addRelatedProject(pid, pid, 'o')
    expect(self.ok === false && self.code).toBe('same_project')
    const none = addRelatedProject(pid, 'nincs', 'o')
    expect(none.ok === false && none.code).toBe('not_found')
    expect(removeRelatedProject(other, pid).ok).toBe(true)
    expect(removeRelatedProject(other, pid).ok).toBe(false)
    expect(listRelatedProjects(pid)).toEqual([])
  })
})
