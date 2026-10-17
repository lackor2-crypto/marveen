// #492 (Boss TG 7948): in the Workbench list a file lying in a work item's own folder belongs to that item:
// it can be copied elsewhere but never moved away; a folder whose content another work item shows is not
// deleted without saying so first.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, getDb } from '../db.js'
import { createProject, updateProject, getProject, type ProjectRow } from '../projects.js'
import { createWorkItem, setWorkItemDeleted, createWorkItemVersion } from '../workbench.js'
import { ensureAnnexTables } from '../workbench-docannex.js'
import { makeWorkFolder, ensureWorkItemFolder, listWorkFolders, moveLooseFiles, copyLooseFiles, deleteWorkFolder } from '../workbench-assets.js'
import { trashRelPath } from '../life-tree.js'
import { callWorkbench } from './helpers/workbench-route-call.js'

let pid = ''
let dir = ''
const base = 'Projektek/Robotok'
const root = () => join(dir, 'Projektek', 'Robotok')
const proj = (): ProjectRow => getProject(pid) as ProjectRow
const abs = (rel: string) => join(root(), ...rel.split('/'))

beforeEach(() => {
  initDatabase(':memory:')
  dir = mkdtempSync(join(tmpdir(), 'wb-itemcopy-'))
  process.env['MARVEEN_DEPOT'] = dir
  const p = createProject({ name: 'Robotok' })
  if (!p.ok) throw new Error('projekt')
  pid = p.project.id
  if (!updateProject(pid, { folder_path: base }).ok) throw new Error('projektmappa')
  mkdirSync(root(), { recursive: true })
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env['MARVEEN_DEPOT']
})

/** A group folder holding a work item (with its own folder and a picture) and a loose file, plus an empty target. */
function setup() {
  const g = makeWorkFolder(proj(), '', 'Kampany')
  const cel = makeWorkFolder(proj(), '', 'Cel')
  if (!g.ok || !cel.ok) throw new Error('mk')
  const it = createWorkItem({ project_id: pid, title: 'Poszt', type: 'note', container_folder: g.folder })
  if (!it.ok) throw new Error('item')
  const f = ensureWorkItemFolder(it.item)
  if (!f.ok) throw new Error('folder')
  writeFileSync(join(abs(f.folder), 'kep.png'), 'PIXELS')
  writeFileSync(join(abs(g.folder), 'laza.txt'), 'hello')
  return {
    group: g.folder, target: cel.folder, itemId: it.item.id, itemFolder: f.folder,
    itemFile: `${base}/${f.folder}/kep.png`, looseFile: `${base}/${g.folder}/laza.txt`,
  }
}

describe('#492 the Workbench marks a work item\'s own files', () => {
  it('a file in the item\'s own folder is marked `item`, a loose file of the group is not', () => {
    const x = setup()
    const wf = listWorkFolders(proj())
    expect(wf.files[x.itemFolder]).toEqual([expect.objectContaining({ name: 'kep.png', rel: x.itemFile, item: true })])
    expect(wf.files[x.group]?.find((f) => f.name === 'laza.txt')?.item).toBeUndefined()
  })

  it('once the item is in the Workbench trash its file is plain again (and can move)', () => {
    const x = setup()
    setWorkItemDeleted(x.itemId, true)
    expect(listWorkFolders(proj()).files[x.itemFolder]?.[0]?.item).toBeUndefined()
    expect(moveLooseFiles(proj(), [x.itemFile], x.target)).toEqual({ ok: true, moved: ['kep.png'], skipped: [] })
  })
})

describe('#492 moveLooseFiles never takes a file away from its work item', () => {
  it('the item\'s file is skipped as item_file and stays; a loose file in the same call still moves', () => {
    const x = setup()
    const r = moveLooseFiles(proj(), [x.itemFile, x.looseFile], x.target)
    expect(r).toEqual({ ok: true, moved: ['laza.txt'], skipped: [{ name: 'kep.png', reason: 'item_file' }] })
    expect(readFileSync(join(abs(x.itemFolder), 'kep.png'), 'utf8')).toBe('PIXELS')
    expect(existsSync(join(abs(x.target), 'kep.png'))).toBe(false)
    expect(existsSync(join(abs(x.target), 'laza.txt'))).toBe(true)
  })

  it('Boss TG 3001: with allowItem the owner moves an unregistered file out of the item folder', () => {
    const x = setup()
    const r = moveLooseFiles(proj(), [x.itemFile], x.target, { allowItem: true })
    expect(r).toEqual({ ok: true, moved: ['kep.png'], skipped: [] })
    expect(existsSync(join(abs(x.itemFolder), 'kep.png'))).toBe(false)
    expect(existsSync(join(abs(x.target), 'kep.png'))).toBe(true)
  })

  it('Boss TG 3016: a file the item names as a material moves too, and the material row follows it', () => {
    const x = setup()
    getDb().prepare('INSERT INTO work_item_assets (id, work_item_id, path, name, support, sha256, bytes, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run('as1', x.itemId, x.itemFile, 'kep.png', 'image', 'h', 6, 1)
    expect(moveLooseFiles(proj(), [x.itemFile], x.target)).toEqual({ ok: true, moved: [], skipped: [{ name: 'kep.png', reason: 'item_file' }] })
    const r = moveLooseFiles(proj(), [x.itemFile], x.target, { allowItem: true })
    expect(r).toEqual({ ok: true, moved: ['kep.png'], skipped: [] })
    const row = getDb().prepare('SELECT path FROM work_item_assets WHERE id = ?').get('as1') as { path: string }
    expect(row.path).toBe(x.itemFile.replace(`/${x.itemFolder}/kep.png`, `/${x.target}/kep.png`))
  })

  it('#639: a file only the finalised version names (pdf_path / files[].path) moves and the metadata follows', () => {
    const x = setup()
    const meta = { final: true, content_hash: 'h', pdf_path: x.itemFile, pdf_name: 'kep.png', files: [{ path: x.itemFile, name: 'kep.png', role: 'main' }] }
    const v = createWorkItemVersion(x.itemId, { metadata_json: JSON.stringify(meta) })
    if (!v.ok) throw new Error('version')
    expect(moveLooseFiles(proj(), [x.itemFile], x.target, { allowItem: true })).toEqual({ ok: true, moved: ['kep.png'], skipped: [] })
    const row = getDb().prepare('SELECT metadata_json FROM work_item_versions WHERE id = ?').get(v.version.id) as { metadata_json: string }
    const m = JSON.parse(row.metadata_json) as typeof meta
    const to = `${base}/${x.target}/kep.png`
    expect(m.pdf_path).toBe(to)
    expect(m.files[0]!.path).toBe(to)
  })

  it('#639: an annex and a source the document names by project-relative path follow the moved file', () => {
    const x = setup()
    ensureAnnexTables()
    const db = getDb()
    db.prepare('INSERT INTO wb_doc_annexes (id, work_item_id, position, path, title, created_at) VALUES (?,?,?,?,?,?)')
      .run('an1', x.itemId, 0, `${x.itemFolder}/kep.png`, 'Kep', 1)
    db.prepare('INSERT INTO wb_doc_claims (id, work_item_id, block_id, text, created_at) VALUES (?,?,?,?,?)').run('cl1', x.itemId, 'b1', 'T', 1)
    db.prepare('INSERT INTO wb_doc_sources (id, claim_id, kind, path, verdict, created_at) VALUES (?,?,?,?,?,?)')
      .run('so1', 'cl1', 'document', `${x.itemFolder}/kep.png`, 'verified', 1)
    expect(moveLooseFiles(proj(), [x.itemFile], x.target, { allowItem: true })).toEqual({ ok: true, moved: ['kep.png'], skipped: [] })
    expect((db.prepare('SELECT path FROM wb_doc_annexes WHERE id = ?').get('an1') as { path: string }).path).toBe(`${x.target}/kep.png`)
    expect((db.prepare('SELECT path FROM wb_doc_sources WHERE id = ?').get('so1') as { path: string }).path).toBe(`${x.target}/kep.png`)
  })

  it('a loose file can still be moved INTO a work item\'s folder (next to it)', () => {
    const x = setup()
    expect(moveLooseFiles(proj(), [x.looseFile], x.itemFolder)).toEqual({ ok: true, moved: ['laza.txt'], skipped: [] })
    expect(existsSync(join(abs(x.itemFolder), 'laza.txt'))).toBe(true)
  })
})

describe('#492 copyLooseFiles makes an independent copy', () => {
  it('the original stays with its item; the copy is a separate file in the target', async () => {
    const x = setup()
    const r = await copyLooseFiles(proj(), [x.itemFile], x.target, 'hu')
    expect(r).toEqual({ ok: true, copied: ['kep.png'], skipped: [] })
    expect(readFileSync(join(abs(x.itemFolder), 'kep.png'), 'utf8')).toBe('PIXELS')
    writeFileSync(join(abs(x.target), 'kep.png'), 'CHANGED')
    expect(readFileSync(join(abs(x.itemFolder), 'kep.png'), 'utf8')).toBe('PIXELS')
    // the copy lies in a plain folder: it belongs to nobody, so it can be moved on freely
    expect(listWorkFolders(proj()).files[x.target]?.[0]).toMatchObject({ name: 'kep.png' })
    expect(listWorkFolders(proj()).files[x.target]?.[0]?.item).toBeUndefined()
  })

  it('never overwrites: a taken name gets a free copy name, the file already there is untouched', async () => {
    const x = setup()
    writeFileSync(join(abs(x.target), 'kep.png'), 'OTHER')
    const r = await copyLooseFiles(proj(), [x.itemFile], x.target, 'hu')
    expect(r.ok).toBe(true)
    const copied = (r as { copied: string[] }).copied
    expect(copied).toHaveLength(1)
    expect(copied[0]).not.toBe('kep.png')
    expect(readFileSync(join(abs(x.target), 'kep.png'), 'utf8')).toBe('OTHER')
    expect(readFileSync(join(abs(x.target), copied[0]!), 'utf8')).toBe('PIXELS')
  })

  it('same place and unknown paths are skipped; no files and a folder outside the box are refused', async () => {
    const x = setup()
    const r = await copyLooseFiles(proj(), [x.itemFile, `${base}/nincs.png`], x.itemFolder, 'hu')
    expect(r).toMatchObject({ ok: true, copied: [] })
    expect((r as { skipped: { reason: string }[] }).skipped.map((s) => s.reason)).toEqual(['same_place', 'not_loose'])
    expect(await copyLooseFiles(proj(), [], x.target, 'hu')).toEqual({ ok: false, code: 'no_files' })
    expect(await copyLooseFiles(proj(), [x.itemFile], '../kint', 'hu')).toMatchObject({ ok: false })
  })

  it('POST /api/workbench/files-copy copies and returns the fresh lists', async () => {
    const x = setup()
    const r = await callWorkbench('/api/workbench/files-copy?lang=en', 'POST', { project_id: pid, rels: [x.itemFile], folder: x.target })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ ok: true, copied: ['kep.png'], skipped: [] })
    expect(r.body.work_folders.files[x.target][0]).toMatchObject({ name: 'kep.png' })
    expect(existsSync(join(abs(x.itemFolder), 'kep.png'))).toBe(true)
  })
})

describe('#492 deleting a folder whose content another work item uses', () => {
  function deckElsewhere(x: ReturnType<typeof setup>): void {
    const db = getDb()
    db.exec('CREATE TABLE IF NOT EXISTS work_item_deck_drafts (work_item_id TEXT, doc TEXT)')
    const deck = createWorkItem({ project_id: pid, title: 'Prezi', type: 'note', container_folder: x.target })
    if (!deck.ok) throw new Error('deck')
    db.prepare('INSERT INTO work_item_deck_drafts (work_item_id, doc) VALUES (?, ?)')
      .run(deck.item.id, JSON.stringify({ slides: [{ canvas: { objects: [{ op: 'picture', src: x.itemFile }] } }] }))
  }

  it('stops with folder_used_elsewhere and the item title; nothing moves', () => {
    const x = setup()
    deckElsewhere(x)
    expect(deleteWorkFolder(proj(), x.group, { trash: true })).toEqual({ ok: false, code: 'folder_used_elsewhere', users: ['Prezi'] })
    expect(existsSync(abs(x.group))).toBe(true)
  })

  it('with force (the owner said yes) the folder goes to the Kuka', () => {
    const x = setup()
    deckElsewhere(x)
    expect(deleteWorkFolder(proj(), x.group, { trash: true, force: true })).toMatchObject({ ok: true, trashed: { items: 1 } })
    expect(existsSync(abs(x.group))).toBe(false)
    const kuka = join(dir, trashRelPath())
    expect(existsSync(join(kuka, readdirSync(kuka)[0]!, 'Kampany', 'laza.txt'))).toBe(true)
  })

  it('the route answers 409 with a sentence in the asked language naming the item', async () => {
    const x = setup()
    deckElsewhere(x)
    const en = await callWorkbench('/api/workbench/folders?lang=en', 'DELETE', { project_id: pid, folder: x.group, trash: true })
    expect(en.status).toBe(409)
    expect(en.body).toMatchObject({ error: 'folder_used_elsewhere', users: ['Prezi'] })
    expect(en.body.message).toContain('"Prezi"')
    const hu = await callWorkbench('/api/workbench/folders?lang=hu', 'DELETE', { project_id: pid, folder: x.group, trash: true })
    expect(hu.body.message).toContain('„Prezi”')
    expect(hu.body.message).toContain('Kukából')
    const ok = await callWorkbench('/api/workbench/folders?lang=hu', 'DELETE', { project_id: pid, folder: x.group, trash: true, force: true })
    expect(ok.status).toBe(200)
    expect(existsSync(abs(x.group))).toBe(false)
  })

  it('a folder only its own work items use is deleted without the extra question', () => {
    const x = setup()
    expect(deleteWorkFolder(proj(), x.group, { trash: true })).toMatchObject({ ok: true, trashed: { items: 1 } })
  })
})
