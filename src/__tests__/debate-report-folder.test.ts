// Boss TG 3623: a debate report is filed inside the folder of the work item the debate was started from, in a
// "Debate report" folder, never as a folder of its own among the work items.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const made: { parent: unknown; name: unknown; opts: unknown }[] = []
vi.mock('../workbench-assets.js', () => ({
  makeWorkFolder: (_p: unknown, parent: unknown, name: unknown, opts: unknown) => { made.push({ parent, name, opts }); return { ok: true, folder: `${parent || 'Box'}/${name}`, created: true } },
  assignWorkItemFolder: () => {},
  folderNameFromTitle: (t: string) => t,
}))
vi.mock('../workbench-docmirror.js', () => ({ scheduleOutlineMirror: () => {} }))

import { initDatabase, getDb } from '../db.js'
import { createProject } from '../projects.js'
import { createWorkItem } from '../workbench.js'
import { createReportDocument, reportFolderName } from '../debate-export-doc.js'

const report = { title: 'Vitáztatás jelentés: teszt', sections: [{ title: 'Összegzés', paragraphs: ['Szöveg.'] }] } as never

describe('debate report folder', () => {
  let pid = ''
  let origin = ''
  beforeEach(() => {
    made.length = 0
    initDatabase(':memory:')
    const p = createProject({ name: 'Iroda' })
    if (!p.ok) throw new Error('project')
    pid = p.project.id
    const w = createWorkItem({ project_id: pid, title: 'Wohngeld 2026', type: 'document' })
    if (!w.ok) throw new Error('item')
    origin = w.item.id
    getDb().prepare('UPDATE work_items SET folder = ? WHERE id = ?').run('Munkadarabok/Wohngeld 2026', origin)
  })

  it('goes under the originating work item folder', () => {
    const r = createReportDocument(pid, report, null, { originItem: origin, lang: 'hu' })
    expect(r.ok).toBe(true)
    expect(made[0].parent).toBe('Munkadarabok/Wohngeld 2026')
    expect(made[0].name).toBe('Vitáztatás jelentés')
    expect((made[0].opts as { own?: boolean } | undefined)?.own).toBeFalsy()
  })
  it('English installs get the English folder name', () => {
    expect(reportFolderName('en')).toBe('Debate report')
  })
  it('an unknown origin never makes a folder of the report title at the box level', () => {
    createReportDocument(pid, report, null, { originItem: 'nope', lang: 'hu' })
    expect(made[0].parent).toBe('')
    expect(made[0].name).toBe('Vitáztatás jelentés')
  })
})
