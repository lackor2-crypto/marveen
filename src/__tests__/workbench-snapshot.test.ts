// #461: every work item keeps a lossless snapshot file in its project folder, and the missing rows can be
// rebuilt from those files. Nothing is overwritten, nothing is deleted, a permanently deleted item is never revived.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDb, initDatabase } from '../db.js'
import { createProject, updateProject } from '../projects.js'
import { createWorkItem, getWorkItem, purgeWorkItem, setWorkItemDeleted } from '../workbench.js'
import { addBlock, addSection, documentOutline } from '../workbench-docmodel.js'
import { ensureWorkItemFolder } from '../workbench-assets.js'
import { SNAPSHOT_FILE, restoreFromFolders, sweepSnapshots, tombstoneSnapshot } from '../workbench-snapshot.js'

let pid = ''
let dir = ''
let projDir = ''

beforeEach(() => {
  initDatabase(':memory:')
  dir = mkdtempSync(join(tmpdir(), 'wb-snap-'))
  process.env['MARVEEN_DEPOT'] = dir
  const p = createProject({ name: 'Robotok' })
  if (!p.ok) throw new Error('projekt')
  pid = p.project.id
  if (!updateProject(pid, { folder_path: 'Projektek/Robotok' }).ok) throw new Error('projektmappa')
  projDir = join(dir, 'Projektek', 'Robotok')
  mkdirSync(projDir, { recursive: true })
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env['MARVEEN_DEPOT']
})

function docItem(title = 'Ajanlat'): string {
  const r = createWorkItem({ project_id: pid, title, type: 'document' })
  if (!r.ok) throw new Error('create: ' + r.code)
  const item = getWorkItem(r.item.id)!
  const f = ensureWorkItemFolder(item)
  if (!f.ok) throw new Error('folder: ' + f.code)
  const s = addSection(item.id, 'Bevezeto')
  if (!s.ok) throw new Error('section')
  if (!addBlock(item.id, s.section.id, { kind: 'paragraph', text: 'Elso szoveg', author: 'owner' }).ok) throw new Error('block')
  return item.id
}

describe('snapshot sweep', () => {
  it('writes marveen-item.json into the item folder with the outline inside', () => {
    const id = docItem()
    expect(sweepSnapshots({ force: true })).toBeGreaterThan(0)
    const folder = getWorkItem(id)!.folder!
    const abs = join(dir, 'Projektek', 'Robotok', ...folder.split('/').filter(Boolean))
    const file = existsSync(join(abs, SNAPSHOT_FILE)) ? join(abs, SNAPSHOT_FILE) : null
    expect(file, `no snapshot in ${abs}: ${existsSync(abs) ? readdirSync(abs).join(',') : 'missing'}`).not.toBeNull()
    const snap = JSON.parse(readFileSync(file!, 'utf8'))
    expect(snap.format).toBe(1)
    expect(snap.item.id).toBe(id)
    expect(JSON.stringify(snap.tables)).toContain('Elso szoveg')
  })

  it('writes only when the content changed', () => {
    docItem()
    expect(sweepSnapshots({ force: true })).toBeGreaterThan(0)
    expect(sweepSnapshots({ force: true })).toBe(0)
  })

  it('an item without its own folder goes to .marveen-items/<id>.json', () => {
    const r = createWorkItem({ project_id: pid, title: 'Jegyzet', type: 'note' })
    if (!r.ok) throw new Error('create')
    sweepSnapshots({ force: true })
    expect(existsSync(join(projDir, '.marveen-items', `${r.item.id}.json`))).toBe(true)
  })

  it('keeps secrets out of the file', () => {
    const id = docItem()
    getDb().exec('CREATE TABLE IF NOT EXISTS wb_test_secret (work_item_id TEXT, note TEXT, api_token TEXT)')
    getDb().prepare('INSERT INTO wb_test_secret VALUES (?, ?, ?)').run(id, 'ok', 'SUPERSECRET')
    sweepSnapshots({ force: true })
    const folder = getWorkItem(id)!.folder!
    const abs = join(dir, 'Projektek', 'Robotok', ...folder.split('/').filter(Boolean))
    const text = readFileSync(join(abs, SNAPSHOT_FILE), 'utf8')
    expect(text).toContain('wb_test_secret')
    expect(text).not.toContain('SUPERSECRET')
  })
})

describe('rebuild from the folders', () => {
  it('round trip: an emptied database gets its project, item and outline back', async () => {
    const id = docItem('Prezentacio')
    sweepSnapshots({ force: true })
    const db = getDb()
    for (const t of ['work_items', 'work_item_versions', 'work_item_parts', 'wb_doc_sections', 'wb_doc_blocks', 'projects']) db.exec(`DELETE FROM ${t}`)
    expect(getWorkItem(id)).toBeUndefined()
    const r = await restoreFromFolders()
    expect(r.restored).toBe(1)
    expect(r.projectsRebuilt).toBe(1)
    const back = getWorkItem(id)!
    expect(back.title).toBe('Prezentacio')
    expect(JSON.stringify(documentOutline(id))).toContain('Elso szoveg')
  })

  it('never overwrites an existing row', async () => {
    const id = docItem()
    sweepSnapshots({ force: true })
    getDb().prepare('UPDATE work_items SET title = ? WHERE id = ?').run('Atnevezve', id)
    const r = await restoreFromFolders()
    expect(r.restored).toBe(0)
    expect(r.alreadyThere).toBe(1)
    expect(getWorkItem(id)!.title).toBe('Atnevezve')
  })

  it('a permanently deleted item gets a tombstone and is not revived', async () => {
    const id = docItem()
    sweepSnapshots({ force: true })
    expect(setWorkItemDeleted(id, true)).toBeTruthy()
    tombstoneSnapshot(getWorkItem(id)!)
    expect(purgeWorkItem(id).ok).toBe(true)
    const r = await restoreFromFolders()
    expect(r.restored).toBe(0)
    expect(r.tombstoned).toBe(1)
    expect(getWorkItem(id)).toBeUndefined()
  })

  it('an item in the trash keeps deleted_at in the snapshot and comes back as a trash item', async () => {
    const id = docItem()
    setWorkItemDeleted(id, true)
    sweepSnapshots({ force: true })
    getDb().exec('DELETE FROM work_items')
    expect((await restoreFromFolders()).restored).toBe(1)
    expect(getWorkItem(id)!.deleted_at).not.toBeNull()
  })

  it('the owner button adopts .deck.json files no work item points to, once', async () => {
    writeFileSync(join(projDir, 'uj-nevjegykartya.deck.json'), '{"version":1,"size":"card-eu","slides":[]}')
    expect((await restoreFromFolders()).adopted).toBe(0) // not at startup
    expect((await restoreFromFolders({ adoptOrphans: true })).adopted).toBe(1)
    expect((await restoreFromFolders({ adoptOrphans: true })).adopted).toBe(0)
  })

  // #490: the startup rebuild walks every project folder; on the slow 9p depot the synchronous walk froze the
  // whole dashboard for ~45-55 s after every restart. Other work must get turns while it walks.
  it('the folder walk lets the event loop run in between (does not freeze the dashboard)', async () => {
    let deep = projDir
    for (let i = 0; i < 8; i++) { deep = join(deep, `szint${i}`); mkdirSync(deep) }
    const order: string[] = []
    const run = restoreFromFolders().then(() => { order.push('walk done') })
    setImmediate(() => { order.push('other work') })
    await run
    expect(order).toEqual(['other work', 'walk done'])
  })

  it('nothing to rebuild on a fresh install is not an error', async () => {
    const r = await restoreFromFolders()
    expect(r).toMatchObject({ restored: 0, failed: 0 })
  })
})
