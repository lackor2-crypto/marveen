// Card #481 (#477/D): a folder renamed or moved OUTSIDE Marvin is found again by the hidden id inside it.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, renameSync, cpSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, getDb } from '../db.js'
import { createProject, updateProject, getProject, type ProjectRow } from '../projects.js'
import { createWorkItem, getWorkItem } from '../workbench.js'
import {
  makeWorkFolder, ensureWorkItemFolder, reconcileFolderMarkers, forgetLostFolder, resetFolderReconcileThrottleForTests, deleteWorkFolder, FOLDER_MARKER,
} from '../workbench-assets.js'

let pid = ''
let dir = ''
const root = () => join(dir, 'Projektek', 'Robotok')
const proj = (): ProjectRow => getProject(pid) as ProjectRow
const recon = () => { resetFolderReconcileThrottleForTests(); return reconcileFolderMarkers(proj()) }

beforeEach(() => {
  initDatabase(':memory:')
  resetFolderReconcileThrottleForTests()
  dir = mkdtempSync(join(tmpdir(), 'wb-ids-'))
  process.env['MARVEEN_DEPOT'] = dir
  const p = createProject({ name: 'Robotok' })
  if (!p.ok) throw new Error('projekt')
  pid = p.project.id
  if (!updateProject(pid, { folder_path: 'Projektek/Robotok' }).ok) throw new Error('projektmappa')
  mkdirSync(root(), { recursive: true })
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env['MARVEEN_DEPOT']
})

function group(name: string): string {
  const g = makeWorkFolder(proj(), '', name)
  if (!g.ok) throw new Error('mk: ' + g.code)
  return g.folder
}
function itemIn(folder: string, title: string) {
  const r = createWorkItem({ project_id: pid, title, type: 'note', container_folder: folder })
  if (!r.ok) throw new Error('item: ' + r.code)
  const f = ensureWorkItemFolder(r.item)
  if (!f.ok) throw new Error('folder: ' + f.code)
  return { id: r.item.id, folder: f.folder }
}
const abs = (rel: string) => join(root(), ...rel.split('/'))

describe('folder ids (.marveen-id)', () => {
  it('stamps every folder of the box once and keeps the id stable', () => {
    const g = group('birosagi')
    const first = recon()
    expect(first).toEqual({ moved: [], lost: [] })
    const id = readFileSync(join(abs(g), FOLDER_MARKER), 'utf8').trim()
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
    recon()
    expect(readFileSync(join(abs(g), FOLDER_MARKER), 'utf8').trim()).toBe(id)
  })

  it('a group renamed outside Marvin is found again by id and the item paths follow it', () => {
    const g = group('birosagi')
    const it1 = itemIn(g, 'Beadvany')
    recon()
    const box = g.slice(0, g.lastIndexOf('/'))
    renameSync(abs(g), abs(`${box}/hatosagi`))
    const r = recon()
    expect(r.lost).toEqual([])
    expect(r.moved.some((m) => m.from === g && m.to === `${box}/hatosagi`)).toBe(true)
    const row = getWorkItem(it1.id)!
    expect(row.container_folder).toBe(`${box}/hatosagi`)
    expect(row.folder).toBe(`${box}/hatosagi/${it1.folder.slice(g.length + 1)}`)
    expect(existsSync(abs(row.folder as string))).toBe(true)
  })

  it('a group moved into another folder outside Marvin is found again too', () => {
    const a = group('A')
    const b = group('B')
    const it1 = itemIn(a, 'Egy')
    recon()
    renameSync(abs(a), abs(`${b}/A`))
    const r = recon()
    expect(r.moved.some((m) => m.to === `${b}/A`)).toBe(true)
    expect(getWorkItem(it1.id)!.container_folder).toBe(`${b}/A`)
  })

  it('a folder that is gone is reported once but NOT forgotten until the owner confirms', () => {
    const g = group('eltunt')
    recon()
    rmSync(abs(g), { recursive: true, force: true })
    const r = recon()
    expect(r.lost).toEqual([g])
    expect(recon().lost).toEqual([]) // reported once per process
    const rows = () => (getDb().prepare('SELECT 1 FROM work_folder_ids WHERE project_id = ? AND path = ?').all(proj().id, g) as unknown[]).length
    expect(rows()).toBe(1) // the row is kept (it may be an unmounted disk)
    expect(forgetLostFolder(proj(), g)).toBe(true)
    expect(rows()).toBe(0)
  })

  it('forgetLostFolder refuses a folder that is still on disk', () => {
    const g = group('megvan')
    recon()
    expect(forgetLostFolder(proj(), g)).toBe(false)
  })

  it('a copy of a folder gets a fresh id, the original keeps its own', () => {
    const g = group('eredeti')
    recon()
    const box = g.slice(0, g.lastIndexOf('/'))
    cpSync(abs(g), abs(`${box}/masolat`), { recursive: true })
    recon()
    const a = readFileSync(join(abs(g), FOLDER_MARKER), 'utf8')
    const b = readFileSync(join(abs(`${box}/masolat`), FOLDER_MARKER), 'utf8')
    expect(a).not.toBe(b)
  })

  it('a deleted marker is written back to a folder that is still there (no false "lost")', () => {
    const g = group('marad')
    recon()
    rmSync(join(abs(g), FOLDER_MARKER))
    expect(recon()).toEqual({ moved: [], lost: [] })
    expect(existsSync(join(abs(g), FOLDER_MARKER))).toBe(true)
  })

  it('deleting an empty group through the app is not "lost" (the marker does not make it non-empty)', () => {
    const g = group('ures')
    recon()
    expect(deleteWorkFolder(proj(), g)).toMatchObject({ ok: true })
    expect(existsSync(abs(g))).toBe(false)
    expect(recon().lost).toEqual([])
  })

  it('the throttle skips a second walk inside the gap', () => {
    group('x')
    reconcileFolderMarkers(proj())
    writeFileSync(join(root(), 'noop.txt'), '')
    expect(reconcileFolderMarkers(proj())).toEqual({ moved: [], lost: [] })
    expect(readdirSync(root()).includes('noop.txt')).toBe(true)
  })
})
