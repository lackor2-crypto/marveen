// #481: the work item follows its registration file (marveen-item.json) when the owner moves it in the
// file manager -- a cross-project move re-homes the item, a drop into a non-project folder warns and
// leaves the item put, and the same file in two projects warns without re-homing anything.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase } from '../db.js'
import { createProject, updateProject, getProject } from '../projects.js'
import { createWorkItem, getWorkItem } from '../workbench.js'
import { ensureWorkItemFolder } from '../workbench-assets.js'
import { SNAPSHOT_FILE, sweepSnapshots } from '../workbench-snapshot.js'

const { notifyMock } = vi.hoisted(() => ({ notifyMock: vi.fn(async () => {}) }))
vi.mock('../notify.js', () => ({ notifyChannel: notifyMock }))

// Imported after the mock is registered.
const { reconcileItemLocations } = await import('../workbench-relocate.js')

let dir = ''
let pidA = ''
let pidB = ''
let dirA = ''
let dirB = ''

beforeEach(() => {
  initDatabase(':memory:')
  notifyMock.mockClear()
  dir = mkdtempSync(join(tmpdir(), 'wb-reloc-'))
  process.env['MARVEEN_DEPOT'] = dir
  const a = createProject({ name: 'Akta' })
  const b = createProject({ name: 'Valoper' })
  if (!a.ok || !b.ok) throw new Error('projekt')
  pidA = a.project.id
  pidB = b.project.id
  if (!updateProject(pidA, { folder_path: 'Iroda/Akta' }).ok) throw new Error('mappaA')
  if (!updateProject(pidB, { folder_path: 'Iroda/Valoper' }).ok) throw new Error('mappaB')
  dirA = join(dir, 'Iroda', 'Akta')
  dirB = join(dir, 'Iroda', 'Valoper')
  mkdirSync(dirA, { recursive: true })
  mkdirSync(dirB, { recursive: true })
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env['MARVEEN_DEPOT']
})

/** Create an item in project A with its own folder and write its snapshot; return {id, absFile}. */
function itemInA(title = 'Nevjegy'): { id: string; file: string } {
  const r = createWorkItem({ project_id: pidA, title, type: 'graphic' })
  if (!r.ok) throw new Error('create: ' + r.code)
  const item = getWorkItem(r.item.id)!
  const f = ensureWorkItemFolder(item)
  if (!f.ok) throw new Error('folder: ' + f.code)
  expect(sweepSnapshots({ force: true })).toBeGreaterThan(0)
  const folder = getWorkItem(r.item.id)!.folder!
  const absDir = join(dirA, ...folder.split('/').filter(Boolean))
  const file = join(absDir, SNAPSHOT_FILE)
  expect(existsSync(file), `no snapshot at ${absDir}: ${existsSync(absDir) ? readdirSync(absDir).join(',') : 'missing'}`).toBe(true)
  return { id: r.item.id, file }
}

describe('workbench-relocate', () => {
  it('re-homes a work item whose file was moved into another PROJECT folder', async () => {
    const { id, file } = itemInA()
    expect(getWorkItem(id)!.project_id).toBe(pidA)
    // Move (not copy) the file into project B, in a sub-folder.
    const target = join(dirB, 'athozott')
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, SNAPSHOT_FILE), readFileSync(file, 'utf8'))
    unlinkSync(file)

    await reconcileItemLocations()

    const after = getWorkItem(id)!
    expect(after.project_id).toBe(pidB)
    expect(after.folder).toBe('athozott')
    expect(notifyMock).toHaveBeenCalledTimes(1)
    expect(String(notifyMock.mock.calls[0][0])).toMatch(/Valoper|project/)
  })

  it('leaves the item put and warns when the file lands in a NON-project folder', async () => {
    const { id, file } = itemInA()
    // A neutral folder that is not any project (e.g. "Korpas Laszlo media/Fotok").
    const neutral = join(dir, 'Korpas Laszlo media', 'Fotok')
    mkdirSync(neutral, { recursive: true })
    writeFileSync(join(neutral, SNAPSHOT_FILE), readFileSync(file, 'utf8'))
    unlinkSync(file)

    await reconcileItemLocations()

    expect(getWorkItem(id)!.project_id).toBe(pidA) // never silently moved into a non-project place
    expect(notifyMock).toHaveBeenCalledTimes(1)
    const msg = String(notifyMock.mock.calls[0][0])
    expect(msg).toMatch(/nem egy projekt mappája|not a project folder/)
  })

  it('warns once per place, not every pass, for an unresolved neutral drop', async () => {
    const { id, file } = itemInA()
    const neutral = join(dir, 'semleges')
    mkdirSync(neutral, { recursive: true })
    writeFileSync(join(neutral, SNAPSHOT_FILE), readFileSync(file, 'utf8'))
    unlinkSync(file)

    await reconcileItemLocations()
    await reconcileItemLocations()
    expect(notifyMock).toHaveBeenCalledTimes(1)
    expect(getWorkItem(id)!.project_id).toBe(pidA)
  })

  it('does NOT re-home and warns when the same file appears in two projects (a copy)', async () => {
    const { id, file } = itemInA()
    const target = join(dirB, 'masolat')
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, SNAPSHOT_FILE), readFileSync(file, 'utf8')) // copy, original stays in A

    await reconcileItemLocations()

    expect(getWorkItem(id)!.project_id).toBe(pidA)
    expect(notifyMock).toHaveBeenCalledTimes(1)
    expect(String(notifyMock.mock.calls[0][0])).toMatch(/több projekt|more than one project/)
  })

  it('does nothing for an item already at home', async () => {
    const { id } = itemInA()
    await reconcileItemLocations()
    expect(getWorkItem(id)!.project_id).toBe(pidA)
    expect(notifyMock).not.toHaveBeenCalled()
  })

  it('leaves a project that still exists untouched when its file never moved (guards getProject)', async () => {
    const { id } = itemInA()
    expect(getProject(pidA)).toBeTruthy()
    await reconcileItemLocations()
    expect(getWorkItem(id)!.project_id).toBe(pidA)
  })
})
