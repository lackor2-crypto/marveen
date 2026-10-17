// Boss TG 3623 (#648), run on the real folder code (no mocks of the asset module): the debate report goes under the
// folder of the work item the debate was started from -- also when that item has no folder yet (it is made lazily).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
vi.mock('../workbench-docmirror.js', () => ({ scheduleOutlineMirror: () => {} }))
import { initDatabase } from '../db.js'
import { createProject, updateProject } from '../projects.js'
import { createWorkItem, getWorkItem } from '../workbench.js'
import { createReportDocument } from '../debate-export-doc.js'

const report = { title: 'Vitáztatás jelentés: teszt', sections: [{ title: 'Összegzés', paragraphs: ['Szöveg.'] }] } as never

let dir = ''
let pid = ''
beforeEach(() => {
  initDatabase(':memory:')
  dir = mkdtempSync(join(tmpdir(), 'wb-648-'))
  process.env['MARVEEN_DEPOT'] = dir
  const p = createProject({ name: 'Hivatal' })
  if (!p.ok) throw new Error('projekt')
  pid = p.project.id
  updateProject(pid, { folder_path: 'P/Hivatal' })
  mkdirSync(join(dir, 'P', 'Hivatal'), { recursive: true })
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }); delete process.env['MARVEEN_DEPOT'] })

function origin(title: string): string {
  const w = createWorkItem({ project_id: pid, title, type: 'document' })
  if (!w.ok) throw new Error(w.code)
  return w.item.id
}

describe('debate report folder, real folders', () => {
  it('an origin item that has no folder yet still gets the report under its own folder', () => {
    const o = origin('Wohngeld 2026')
    expect(getWorkItem(o)!.folder).toBeFalsy()
    const r = createReportDocument(pid, report, null, { originItem: o, lang: 'hu' })
    if (!r.ok) throw new Error(r.code)
    const of = getWorkItem(o)!.folder
    expect(of).toBeTruthy()
    expect(r.item.folder).toBe(`${of}/Vitáztatás jelentés`)
    expect(existsSync(join(dir, 'P', 'Hivatal', r.item.folder!))).toBe(true)
  })
  it('a second report goes into the same item folder (English name on an English install)', () => {
    const o = origin('Wohngeld 2026')
    const first = createReportDocument(pid, report, null, { originItem: o, lang: 'hu' })
    const second = createReportDocument(pid, report, null, { originItem: o, lang: 'en' })
    if (!first.ok || !second.ok) throw new Error('report')
    const of = getWorkItem(o)!.folder
    expect(second.item.folder).toBe(`${of}/Debate report`)
  })
  it('no origin: one shared Debate report folder of the box, never one per report', () => {
    const a = createReportDocument(pid, report, null, { originItem: null, lang: 'hu' })
    const b = createReportDocument(pid, report, null, { originItem: null, lang: 'hu' })
    if (!a.ok || !b.ok) throw new Error('report')
    expect(a.item.folder).toBe(b.item.folder)
    expect(a.item.folder!.endsWith('/Vitáztatás jelentés')).toBe(true)
  })
})
