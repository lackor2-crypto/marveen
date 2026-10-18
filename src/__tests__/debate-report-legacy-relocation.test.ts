// Boss TG 3636: a debate report saved before the folder fix (#1144) sat in a folder of its own at the box level and
// stayed there. It now moves into the "Debate report" folder of the work item its debate was started from.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const moves: { item: string; folder: unknown }[] = []
const made: { parent: unknown; name: unknown }[] = []
let origins: { question: string; project: string; workItem: string | null; files: string[] }[] = []
vi.mock('../workbench-assets.js', () => ({
  findWorkItemsBox: () => 'Munkadarabok',
  makeWorkFolder: (_p: unknown, parent: unknown, name: unknown) => { made.push({ parent, name }); return { ok: true, folder: `${parent}/${name}`, created: true } },
  assignWorkItemFolder: () => {},
  moveWorkItemToFolder: (item: { id: string }, folder: unknown) => { moves.push({ item: item.id, folder }); return { ok: true, moved: true, folder } },
}))
vi.mock('../workbench-docmirror.js', () => ({ scheduleOutlineMirror: () => {} }))
vi.mock('../debate-run.js', () => ({ listDebateOrigins: () => origins }))

import { initDatabase, getDb } from '../db.js'
import { createProject } from '../projects.js'
import { createWorkItem } from '../workbench.js'
import { relocateLegacyReports } from '../debate-export-doc.js'
import { reportTitle } from '../debate-export.js'

const QUESTION = 'Vizsgáljátok át ezt a munkadarabot, beadható-e így, ahogy van?'

describe('legacy debate report relocation', () => {
  let pid = ''
  let origin = ''
  let legacy = ''
  const setFolder = (id: string, f: string) => getDb().prepare('UPDATE work_items SET folder = ? WHERE id = ?').run(f, id)
  beforeEach(() => {
    moves.length = 0; made.length = 0; origins = []
    initDatabase(':memory:')
    const p = createProject({ name: 'Iroda' })
    if (!p.ok) throw new Error('project')
    pid = p.project.id
    const o = createWorkItem({ project_id: pid, title: 'Wohngeld 2026', type: 'document' })
    const l = createWorkItem({ project_id: pid, title: reportTitle(QUESTION, 'hu'), type: 'document' })
    if (!o.ok || !l.ok) throw new Error('item')
    origin = o.item.id; legacy = l.item.id
    setFolder(origin, 'Munkadarabok/Wohngeld 2026')
    setFolder(legacy, 'Munkadarabok/Vitáztatás jelentés Vizsgáljátok át')
    origins = [{ question: QUESTION, project: pid, workItem: origin, files: [] }]
  })

  it('moves a box-level report into the Debate report folder of its origin item', () => {
    expect(relocateLegacyReports()).toBe(1)
    expect(made[0]).toEqual({ parent: 'Munkadarabok/Wohngeld 2026', name: 'Vitáztatás' })
    expect(moves).toEqual([{ item: legacy, folder: 'Munkadarabok/Wohngeld 2026/Vitáztatás/jelentés' }])
  })
  it('leaves a report whose debate is not in the log where it is', () => {
    origins = []
    expect(relocateLegacyReports()).toBe(0)
    expect(moves).toEqual([])
  })
  it('finds the origin of an older debate (no recorded work item) from the work item it attached', () => {
    origins = [{ question: QUESTION, project: pid, workItem: null, files: ['Wohngeld 2026'] }]
    expect(relocateLegacyReports()).toBe(1)
    expect(moves[0].folder).toBe('Munkadarabok/Wohngeld 2026/Vitáztatás/jelentés')
  })
  it('does not guess when two work items carry the attached file name', () => {
    const t = createWorkItem({ project_id: pid, title: 'Wohngeld 2026', type: 'document' })
    if (!t.ok) throw new Error('item')
    setFolder(t.item.id, 'Munkadarabok/Masik')
    origins = [{ question: QUESTION, project: pid, workItem: null, files: ['Wohngeld 2026'] }]
    expect(relocateLegacyReports()).toBe(0)
  })
  it('leaves a report that is already inside a work item folder', () => {
    setFolder(legacy, 'Munkadarabok/Wohngeld 2026/Vitáztatás jelentés')
    expect(relocateLegacyReports()).toBe(0)
  })
  it('leaves the report alone when the origin has no folder', () => {
    setFolder(origin, '')
    getDb().prepare('UPDATE work_items SET folder = NULL WHERE id = ?').run(origin)
    expect(relocateLegacyReports()).toBe(0)
  })
})
