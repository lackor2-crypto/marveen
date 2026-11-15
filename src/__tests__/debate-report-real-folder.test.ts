// Boss TG 3623 (#648), run on the real folder code (no mocks of the asset module): the debate report is STORED in the project's
// shared Debate/jelentés folder (#809) and only LINKED into the Debate folder of the work item the debate was started from
// -- also when that item has no folder yet (it is made lazily).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
vi.mock('../workbench-docmirror.js', () => ({ scheduleOutlineMirror: () => {} }))
import { initDatabase } from '../db.js'
import { createProject, updateProject } from '../projects.js'
import { createWorkItem, getWorkItem } from '../workbench.js'
import { ensureWorkItemFolder } from '../workbench-assets.js'
import { createReportDocument } from '../debate-export-doc.js'
import { listFolderLinks } from '../workbench-folder-links.js'

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

describe('debate report folder, real folders (#809: stored centrally, linked from the item)', () => {
  it('an origin item that has no folder yet gets its folder and a link folder; the report sits in the shared folder', () => {
    const o = origin('Wohngeld 2026')
    expect(getWorkItem(o)!.folder).toBeFalsy()
    const r = createReportDocument(pid, report, null, { originItem: o, lang: 'hu' })
    if (!r.ok) throw new Error(r.code)
    const of = getWorkItem(o)!.folder
    expect(of).toBeTruthy()
    expect(r.item.folder!.startsWith(of!)).toBe(false)
    expect(r.item.folder!.endsWith('/Vitáztatás/jelentés')).toBe(true)
    expect(existsSync(join(dir, 'P', 'Hivatal', r.item.folder!))).toBe(true)
    expect(listFolderLinks(pid)[`${of}/Vitáztatás`]).toEqual([r.item.id])
  })
  it('a second report is stored in the same shared folder and linked into the same item Debate folder (no twin folder)', () => {
    const o = origin('Wohngeld 2026')
    const first = createReportDocument(pid, report, null, { originItem: o, lang: 'hu' })
    const second = createReportDocument(pid, report, null, { originItem: o, lang: 'en' })
    if (!first.ok || !second.ok) throw new Error('report')
    const of = getWorkItem(o)!.folder
    expect(second.item.folder).toBe(first.item.folder)
    expect(listFolderLinks(pid)[`${of}/Vitáztatás`]).toEqual([first.item.id, second.item.id])
  })
  it('no origin: one shared Debate report folder of the box, never one per report, and no link', () => {
    const a = createReportDocument(pid, report, null, { originItem: null, lang: 'hu' })
    const b = createReportDocument(pid, report, null, { originItem: null, lang: 'hu' })
    if (!a.ok || !b.ok) throw new Error('report')
    expect(a.item.folder).toBe(b.item.folder)
    expect(a.item.folder!.endsWith('/Vitáztatás/jelentés')).toBe(true)
    expect(listFolderLinks(pid)).toEqual({})
  })
})

describe('#699/#809: the link lives in the Debate folder itself', () => {
  it('the Debate folder of the item exists and holds the link; no report file or jelentés folder inside it', () => {
    const o = origin('Wohngeld 2026')
    const r = createReportDocument(pid, report, null, { originItem: o, lang: 'hu' })
    if (!r.ok) throw new Error(r.code)
    const of = getWorkItem(o)!.folder!
    expect(existsSync(join(dir, 'P', 'Hivatal', of, 'Vitáztatás'))).toBe(true)
    expect(existsSync(join(dir, 'P', 'Hivatal', of, 'Vitáztatás', 'jelentés'))).toBe(false)
  })
  it('a Debate folder the owner deleted is not made again: the report is still stored centrally, no link', () => {
    const o = origin('Wohngeld 2026')
    const first = createReportDocument(pid, report, null, { originItem: o, lang: 'hu' })
    if (!first.ok) throw new Error(first.code)
    const of = getWorkItem(o)!.folder!
    rmSync(join(dir, 'P', 'Hivatal', of, 'Vitáztatás'), { recursive: true, force: true })
    const second = createReportDocument(pid, report, null, { originItem: o, lang: 'hu' })
    if (!second.ok) throw new Error(second.code)
    expect(second.item.folder).toBe(first.item.folder)
    expect(existsSync(join(dir, 'P', 'Hivatal', of, 'Vitáztatás'))).toBe(false)
    expect(listFolderLinks(pid)[`${of}/Vitáztatás`]).toEqual([first.item.id])
  })
  it('an item that only has the old-name folder gets the link there', () => {
    const o = origin('Wohngeld 2026')
    const f = ensureWorkItemFolder(getWorkItem(o)!)
    if (!f.ok) throw new Error('folder')
    const base = join(dir, 'P', 'Hivatal', f.folder)
    rmSync(join(base, 'Vitáztatás'), { recursive: true, force: true })
    mkdirSync(join(base, 'Vitáztatás jelentés'), { recursive: true })
    const r = createReportDocument(pid, report, null, { originItem: o, lang: 'hu' })
    if (!r.ok) throw new Error(r.code)
    expect(listFolderLinks(pid)[`${f.folder}/Vitáztatás jelentés`]).toEqual([r.item.id])
    expect(existsSync(join(base, 'Vitáztatás jelentés', 'jelentés'))).toBe(false)
  })
})
