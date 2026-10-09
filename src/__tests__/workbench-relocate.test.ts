// #481: the work item follows its registration file (marveen-item.json) when the owner moves it in the
// file manager -- a cross-project move re-homes the item, a drop into a non-project folder warns and
// leaves the item put, a copy into one other project counts as a move, and two other projects warn.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, unlinkSync, readdirSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, getDb } from '../db.js'
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

  it('a registration file in the Kuka (trash) is deliberate: no warning (Boss, TG 2874)', async () => {
    const { file } = itemInA()
    const trash = join(dir, 'Kuka', '2026-10-06_20-06-34', 'Iroda')
    mkdirSync(trash, { recursive: true })
    writeFileSync(join(trash, SNAPSHOT_FILE), readFileSync(file, 'utf8'))
    unlinkSync(file)

    await reconcileItemLocations()

    expect(notifyMock).not.toHaveBeenCalled()
  })

  it('the sent warning is persisted, so a restart does not send it again (Boss, TG 2874)', async () => {
    const { file } = itemInA()
    const neutral = join(dir, 'semleges2')
    mkdirSync(neutral, { recursive: true })
    writeFileSync(join(neutral, SNAPSHOT_FILE), readFileSync(file, 'utf8'))
    unlinkSync(file)

    await reconcileItemLocations()
    const rows = getDb().prepare('SELECT key FROM workbench_relocate_warned').all() as { key: string }[]
    expect(rows.some((r) => r.key.startsWith('N|'))).toBe(true)
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

  it('treats a COPY into exactly one other project as a move: old home file removed first, then re-homed', async () => {
    const { id, file } = itemInA()
    const target = join(dirB, 'masolat')
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, SNAPSHOT_FILE), readFileSync(file, 'utf8')) // copy, original stays in A

    await reconcileItemLocations()

    expect(existsSync(file)).toBe(false) // the old home registration file is gone
    const after = getWorkItem(id)!
    expect(after.project_id).toBe(pidB)
    expect(after.folder).toBe('masolat')
    expect(notifyMock).toHaveBeenCalledTimes(1)
    await reconcileItemLocations() // no bounce back on the next pass
    expect(getWorkItem(id)!.project_id).toBe(pidB)
  })

  it('does NOT re-home and warns when the file appears in TWO other projects', async () => {
    const { id, file } = itemInA()
    const c = createProject({ name: 'Harmadik' })
    if (!c.ok) throw new Error('projekt')
    if (!updateProject(c.project.id, { folder_path: 'Iroda/Harmadik' }).ok) throw new Error('mappaC')
    const dirC = join(dir, 'Iroda', 'Harmadik')
    mkdirSync(dirC, { recursive: true })
    for (const d of [join(dirB, 'x'), join(dirC, 'y')]) {
      mkdirSync(d, { recursive: true })
      writeFileSync(join(d, SNAPSHOT_FILE), readFileSync(file, 'utf8'))
    }
    unlinkSync(file)

    await reconcileItemLocations()

    expect(getWorkItem(id)!.project_id).toBe(pidA)
    expect(notifyMock).toHaveBeenCalledTimes(1)
    expect(String(notifyMock.mock.calls[0][0])).toMatch(/több projekt|more than one project/)
  })

  it('rewrites EVERY registry path to the new project prefix on a cross-project move', async () => {
    const { id, file } = itemInA()
    const db = getDb()
    const item = getWorkItem(id)!
    const oldPrefix = `Iroda/Akta/${item.folder}/`
    db.prepare('UPDATE work_items SET source_path = ? WHERE id = ?').run(`${oldPrefix}terv.md`, id)
    db.prepare("INSERT INTO work_item_assets (id, work_item_id, path, name, support, sha256, bytes, created_at) VALUES ('as1', ?, ?, 'kep.png', 'image', 'h', 1, 1)").run(id, `${oldPrefix}kep.png`)
    const target = join(dirB, 'athozott')
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, SNAPSHOT_FILE), readFileSync(file, 'utf8'))
    unlinkSync(file)

    await reconcileItemLocations()

    const after = getWorkItem(id)!
    expect(after.project_id).toBe(pidB)
    expect(after.source_path).toBe('Iroda/Valoper/athozott/terv.md')
    const a = db.prepare("SELECT path FROM work_item_assets WHERE id = 'as1'").get() as { path: string }
    expect(a.path).toBe('Iroda/Valoper/athozott/kep.png')
  })

  it('does nothing for an item already at home', async () => {
    const { id } = itemInA()
    const folderBefore = getWorkItem(id)!.folder
    await reconcileItemLocations()
    expect(getWorkItem(id)!.project_id).toBe(pidA)
    expect(getWorkItem(id)!.folder).toBe(folderBefore) // no churn: folder untouched
    expect(notifyMock).not.toHaveBeenCalled()
  })

  it('a call made while a pass is running waits for that pass instead of returning at once', async () => {
    const { id, file } = itemInA()
    const target = join(dirB, 'athozott')
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, SNAPSHOT_FILE), readFileSync(file, 'utf8'))
    unlinkSync(file)

    const first = reconcileItemLocations() // e.g. the file-manager move route's fire-and-forget pass
    await reconcileItemLocations() // overlaps it: used to resolve before the first pass had written anything
    expect(getWorkItem(id)!.project_id).toBe(pidB)
    await first
  })

  it('leaves a project that still exists untouched when its file never moved (guards getProject)', async () => {
    const { id } = itemInA()
    expect(getProject(pidA)).toBeTruthy()
    await reconcileItemLocations()
    expect(getWorkItem(id)!.project_id).toBe(pidA)
  })
  describe('self-heal of stale pointers (inside one project)', () => {
    const srcOf = (id: string): string | null => getWorkItem(id)!.source_path ?? null

    it('follows a folder that was moved/renamed BEFORE folder ids existed, rewriting every path', async () => {
      const { id } = itemInA()
      const db = getDb()
      const folder = getWorkItem(id)!.folder!
      const oldAbs = join(dirA, ...folder.split('/'))
      writeFileSync(join(oldAbs, 'terv.md'), 'x')
      db.prepare('UPDATE work_items SET source_path = ? WHERE id = ?').run(`Iroda/Akta/${folder}/terv.md`, id)
      db.prepare("INSERT INTO work_item_assets (id, work_item_id, path, name, support, sha256, bytes, created_at) VALUES ('as2', ?, ?, 'terv.md', 'text', 'h', 1, 1)").run(id, `Iroda/Akta/${folder}/terv.md`)
      const newFolder = 'Uj hely/Atnevezett'
      mkdirSync(join(dirA, 'Uj hely'), { recursive: true })
      renameSync(oldAbs, join(dirA, ...newFolder.split('/')))

      await reconcileItemLocations()

      const after = getWorkItem(id)!
      expect(after.project_id).toBe(pidA)
      expect(after.folder).toBe(newFolder)
      expect(after.source_path).toBe(`Iroda/Akta/${newFolder}/terv.md`)
      expect((db.prepare("SELECT path FROM work_item_assets WHERE id = 'as2'").get() as { path: string }).path).toBe(`Iroda/Akta/${newFolder}/terv.md`)
      expect(notifyMock).not.toHaveBeenCalled()
      await reconcileItemLocations() // idempotent
      expect(getWorkItem(id)!.folder).toBe(newFolder)
    })

    it('points a missing source_path (item and version) at the ONE same-named file in the real folder', async () => {
      const { id } = itemInA()
      const db = getDb()
      const folder = getWorkItem(id)!.folder!
      writeFileSync(join(dirA, ...folder.split('/'), 'deck.pptx'), 'x') // moved from the project root into the folder
      db.prepare('UPDATE work_items SET source_path = ? WHERE id = ?').run('Iroda/Akta/deck.pptx', id)
      db.prepare("INSERT INTO work_item_versions (id, work_item_id, version_no, source_path, created_at) VALUES ('v1', ?, 99, 'Iroda/Akta/deck.pptx', 1)").run(id)

      await reconcileItemLocations()

      expect(srcOf(id)).toBe(`Iroda/Akta/${folder}/deck.pptx`)
      expect((db.prepare("SELECT source_path FROM work_item_versions WHERE id = 'v1'").get() as { source_path: string }).source_path).toBe(`Iroda/Akta/${folder}/deck.pptx`)
    })

    it('never writes when the target does not exist, or when there is no candidate', async () => {
      const { id } = itemInA()
      const db = getDb()
      db.prepare('UPDATE work_items SET source_path = ? WHERE id = ?').run('Iroda/Akta/nincs.pptx', id)
      await reconcileItemLocations()
      expect(srcOf(id)).toBe('Iroda/Akta/nincs.pptx') // zero matches: left alone
    })

    it('leaves a pointer that already matches the disk untouched (no churn)', async () => {
      const { id } = itemInA()
      const folder = getWorkItem(id)!.folder!
      writeFileSync(join(dirA, ...folder.split('/'), 'jo.md'), 'x')
      getDb().prepare('UPDATE work_items SET source_path = ?, updated_at = 5 WHERE id = ?').run(`Iroda/Akta/${folder}/jo.md`, id)
      await reconcileItemLocations()
      expect(srcOf(id)).toBe(`Iroda/Akta/${folder}/jo.md`)
      expect(getWorkItem(id)!.updated_at).toBe(5)
    })
  })
})
