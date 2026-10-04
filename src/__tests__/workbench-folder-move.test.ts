// Moving a folder of the work items box with everything in it (Boss TG 2472/2478).
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, readFileSync as rd } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase } from '../db.js'
import { createProject, updateProject, getProject } from '../projects.js'
import { createWorkItem } from '../workbench.js'
import { makeWorkFolder, moveWorkFolder, listWorkFolders } from '../workbench-assets.js'

let pid = ''
let dir = ''
const proj = () => getProject(pid)!

beforeEach(() => {
  initDatabase(':memory:')
  dir = mkdtempSync(join(tmpdir(), 'wb-fmove-'))
  process.env['MARVEEN_DEPOT'] = dir
  const p = createProject({ name: 'Robotok' })
  if (!p.ok) throw new Error('projekt')
  pid = p.project.id
  updateProject(pid, { folder_path: 'Projektek/Robotok' })
  mkdirSync(join(dir, 'Projektek', 'Robotok'), { recursive: true })
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }); delete process.env['MARVEEN_DEPOT'] })

describe('moveWorkFolder', () => {
  it('moves a non-empty folder with its items into another folder', () => {
    const a = makeWorkFolder(proj(), '', 'A'); if (!a.ok) throw new Error('a')
    const b = makeWorkFolder(proj(), '', 'B'); if (!b.ok) throw new Error('b')
    const it = createWorkItem({ project_id: pid, title: 'Jegyzet', type: 'note', container_folder: a.folder })
    expect(it.ok).toBe(true)
    const r = moveWorkFolder(proj(), a.folder, b.folder)
    expect(r).toMatchObject({ ok: true, moved: true, folder: `${b.folder}/A` })
    const fl = listWorkFolders(proj()).folders
    expect(fl).toContain(`${b.folder}/A`)
    expect(fl).not.toContain(a.folder)
  })

  it('refuses: into itself, into its own subfolder, name clash, the box', () => {
    const a = makeWorkFolder(proj(), '', 'A'); if (!a.ok) throw new Error('a')
    const s = makeWorkFolder(proj(), a.folder, 'S'); if (!s.ok) throw new Error('s')
    const b = makeWorkFolder(proj(), '', 'B'); if (!b.ok) throw new Error('b')
    const a2 = makeWorkFolder(proj(), b.folder, 'A'); if (!a2.ok) throw new Error('a2')
    expect(moveWorkFolder(proj(), a.folder, a.folder)).toMatchObject({ ok: false, code: 'folder_into_itself' })
    expect(moveWorkFolder(proj(), a.folder, s.folder)).toMatchObject({ ok: false, code: 'folder_into_itself' })
    expect(moveWorkFolder(proj(), a.folder, b.folder)).toMatchObject({ ok: false, code: 'folder_exists' })
    const box = a.folder.slice(0, a.folder.lastIndexOf('/'))
    expect(moveWorkFolder(proj(), box, b.folder)).toMatchObject({ ok: false, code: 'folder_is_box' })
  })

  it('the same parent is a no-op, and the box root is a valid target', () => {
    const a = makeWorkFolder(proj(), '', 'A'); if (!a.ok) throw new Error('a')
    const s = makeWorkFolder(proj(), a.folder, 'S'); if (!s.ok) throw new Error('s')
    expect(moveWorkFolder(proj(), s.folder, a.folder)).toMatchObject({ ok: true, moved: false })
    const box = a.folder.slice(0, a.folder.lastIndexOf('/'))
    const r = moveWorkFolder(proj(), s.folder, box)
    expect(r).toMatchObject({ ok: true, moved: true, folder: `${box}/S` })
  })
})

describe('folder move UI wiring', () => {
  const js = rd(join(__dirname, '../../web/workbench.js'), 'utf8')
  it('has the menu select, the drag source and the drop handler', () => {
    expect(js).toContain('data-wb-move-folder')
    expect(js).toContain('data-wb-drag-folder')
    expect(js).toContain("/api/workbench/folders/move")
  })
})
