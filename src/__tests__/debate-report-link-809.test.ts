// #809 (Boss TG 4506/4532): the debate report is STORED once, in the project's shared Debate folder; the Debate folder of the
// work item the debate was started from holds only a LINK row (not a copy, not a file). Regression: before the fix the report
// itself was filed under the origin item and no link existed.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../workbench-assets.js', () => ({
  makeWorkFolder: (_p: unknown, parent: string, name: string) => ({ ok: true, folder: `${parent || 'Box'}/${name}`, created: true }),
  assignWorkItemFolder: () => {},
  ensureWorkItemFolder: (i: { folder?: string | null }) => i.folder ? { ok: true, folder: i.folder, created: false } : { ok: false, code: 'not_found' },
  folderNameFromTitle: (t: string) => t,
  findWorkItemsBox: () => 'Box',
}))
vi.mock('../workbench-docmirror.js', () => ({ scheduleOutlineMirror: () => {} }))

import { initDatabase, getDb } from '../db.js'
import { createProject } from '../projects.js'
import { createWorkItem, setWorkItemDeleted } from '../workbench.js'
import { createReportDocument } from '../debate-export-doc.js'
import { listFolderLinks, addFolderLink, removeFolderLink, foldersLinkedTo } from '../workbench-folder-links.js'

const report = { title: 'Vitáztatás jelentés: teszt', sections: [{ title: 'Összegzés', paragraphs: ['Szöveg.'] }] } as never

describe('debate report link in the work item Debate folder (#809)', () => {
  let pid = ''
  let origin = ''
  beforeEach(() => {
    initDatabase(':memory:')
    const p = createProject({ name: 'Iroda' })
    if (!p.ok) throw new Error('project')
    pid = p.project.id
    const w = createWorkItem({ project_id: pid, title: 'Wohngeld 2026', type: 'document' })
    if (!w.ok) throw new Error('item')
    origin = w.item.id
    getDb().prepare('UPDATE work_items SET folder = ? WHERE id = ?').run('Box/Wohngeld 2026', origin)
  })

  it('the report is linked into the origin Debate folder, and its own home is the shared Debate folder', () => {
    const r = createReportDocument(pid, report, null, { originItem: origin, lang: 'hu' })
    if (!r.ok) throw new Error('report')
    expect(listFolderLinks(pid)['Box/Wohngeld 2026/Vitáztatás']).toEqual([r.item.id])
    expect(r.item.folder ?? r.item.container_folder).not.toContain('Wohngeld 2026')
  })
  it('no origin: no link row', () => {
    createReportDocument(pid, report, null, { originItem: null, lang: 'hu' })
    expect(listFolderLinks(pid)).toEqual({})
  })
  it('a report in the trash disappears from the link list; removing a link never deletes the report', () => {
    const r = createReportDocument(pid, report, null, { originItem: origin, lang: 'hu' })
    if (!r.ok) throw new Error('report')
    expect(removeFolderLink(r.item.id, 'Box/Wohngeld 2026/Vitáztatás')).toBe(true)
    expect(foldersLinkedTo(r.item.id)).toEqual([])
    expect(addFolderLink(r.item.id, 'Box/Wohngeld 2026/Vitáztatás')).toBe(true)
    setWorkItemDeleted(r.item.id, true)
    expect(listFolderLinks(pid)).toEqual({})
  })
  it('an item is never linked into the folder it lives in', () => {
    expect(addFolderLink(origin, 'Box/Wohngeld 2026')).toBe(false)
  })
})
