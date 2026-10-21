// A work item made from a file has no folder, only its source file: the "move to the Life tree" list offers that one
// file (every document has the button), and the item follows the file to its new place.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase } from '../db.js'
import { createProject, updateProject, getProject, type ProjectRow } from '../projects.js'
import { createWorkItem, getWorkItem } from '../workbench.js'
import { markSentManually } from '../workbench-docsent.js'
import { lifeMoveCandidates, moveItemFilesToLife } from '../workbench-life-move.js'

describe('Eletfa-koltoztetes: fajlbol keszult munkadarab', () => {
  let depot = ''
  let project: ProjectRow
  let pid = ''

  beforeEach(() => {
    initDatabase(':memory:')
    depot = mkdtempSync(join(tmpdir(), 'marveen-own-file-move-'))
    mkdirSync(join(depot, 'Projektek', 'Iroda', 'Munkadarabok'), { recursive: true })
    mkdirSync(join(depot, 'Cel'), { recursive: true })
    process.env['MARVEEN_DEPOT'] = depot
    const p = createProject({ name: 'Iroda fejlesztese' })
    if (!p.ok) throw new Error('projekt')
    pid = p.project.id
    updateProject(pid, { folder_path: 'Projektek/Iroda' })
    project = getProject(pid) as ProjectRow
  })

  afterEach(() => {
    rmSync(depot, { recursive: true, force: true })
    delete process.env['MARVEEN_DEPOT']
  })

  it('a mappa nelkuli munkadarab egyetlen jeloltje a forrasfajl, a felolt-lista (only) nem ajanlja', () => {
    writeFileSync(join(depot, 'Projektek', 'Iroda', 'Munkadarabok', 'level.docx'), 'x')
    const w = createWorkItem({ project_id: pid, title: 'Level', type: 'document', source_path: 'Projektek/Iroda/Munkadarabok/level.docx' } as any)
    if (!w.ok) throw new Error('munkadarab')
    const item = getWorkItem(w.item.id) as any
    expect(item.folder).toBeFalsy()
    const c = lifeMoveCandidates(project, item, 'include')
    expect(c.ok && c.files.map((f) => f.name)).toEqual(['level.docx'])
    expect(lifeMoveCandidates(project, item, 'only').ok).toBe(false)
  })

  it('nincs mappa es nincs fajl: nincs lista; jovahagyott athelyezes: a munkadarab kovet', () => {
    const none = createWorkItem({ project_id: pid, title: 'Ures', type: 'note' })
    if (!none.ok) throw new Error('munkadarab')
    expect(lifeMoveCandidates(project, getWorkItem(none.item.id) as any, 'include').ok).toBe(false)

    writeFileSync(join(depot, 'Projektek', 'Iroda', 'Munkadarabok', 'level.docx'), 'x')
    const w = createWorkItem({ project_id: pid, title: 'Level', type: 'document', source_path: 'Projektek/Iroda/Munkadarabok/level.docx' } as any)
    if (!w.ok) throw new Error('munkadarab')
    const item = getWorkItem(w.item.id) as any
    const rel = 'Projektek/Iroda/Munkadarabok/level.docx'
    // Only a sent document moves: it is blocked until it is marked as sent.
    const blocked = moveItemFilesToLife(project, item, [{ rel, target: 'Cel' }], 'hu', 'include')
    expect(blocked.ok && blocked.results[0].ok).toBe(false)
    markSentManually(item.id, null)
    const r = moveItemFilesToLife(project, item, [{ rel, target: 'Cel' }, { rel: 'Mas/fajl.docx', target: 'Cel' }], 'hu', 'include')
    expect(r.ok && r.results.map((x) => x.ok)).toEqual([true, false])
    expect(existsSync(join(depot, 'Cel', 'level.docx'))).toBe(true)
    expect((getWorkItem(w.item.id) as any).source_path).toBe('Cel/level.docx')
  })
})
