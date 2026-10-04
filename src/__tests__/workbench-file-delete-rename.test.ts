// #483: loose files can be deleted (never one the registry names) and renamed in place (never overwriting).
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, getDb } from '../db.js'
import { createProject, updateProject, getProject, type ProjectRow } from '../projects.js'
import { createWorkItem } from '../workbench.js'
import { trashRelPath } from '../life-tree.js'
import { makeWorkFolder, listWorkFolders, deleteLooseFiles, renameLooseFile } from '../workbench-assets.js'

let pid = ''
let dir = ''
const root = () => join(dir, 'Projektek', 'Robotok')
const proj = (): ProjectRow => getProject(pid) as ProjectRow
const abs = (rel: string) => join(root(), ...rel.split('/'))

beforeEach(() => {
  initDatabase(':memory:')
  dir = mkdtempSync(join(tmpdir(), 'wb-dr-'))
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
function loose(folder: string, name: string, body = 'x'): string {
  writeFileSync(join(abs(folder), name), body)
  const f = (listWorkFolders(proj()).files[folder] ?? []).find((x) => x.name === name)
  if (!f) throw new Error('not listed: ' + name)
  return f.rel
}

describe('deleteLooseFiles', () => {
  it('deletes the chosen loose files and nothing else', () => {
    const a = group('Forras')
    const r1 = loose(a, 'S01.png')
    const r2 = loose(a, 'S02.png')
    const keep = loose(a, 'S03.png')
    const r = deleteLooseFiles(proj(), [r1, r2])
    expect(r).toEqual({ ok: true, deleted: ['S01.png', 'S02.png'], skipped: [] })
    expect(existsSync(join(abs(a), 'S01.png'))).toBe(false)
    expect(existsSync(join(abs(a), 'S02.png'))).toBe(false)
    expect(existsSync(join(abs(a), 'S03.png'))).toBe(true)
    expect(keep).toContain('S03.png')
  })

  it('#492: a deleted file goes to the Kuka (restorable), its content intact, not into oblivion', () => {
    const a = group('Forras')
    loose(a, 'S01.png', 'PIXELS')
    const rel = listWorkFolders(proj()).files[a]![0]!.rel
    expect(deleteLooseFiles(proj(), [rel])).toEqual({ ok: true, deleted: ['S01.png'], skipped: [] })
    expect(existsSync(join(abs(a), 'S01.png'))).toBe(false)
    const kuka = join(dir, trashRelPath())
    const stamps = readdirSync(kuka)
    expect(stamps).toHaveLength(1)
    expect(readFileSync(join(kuka, stamps[0]!, 'S01.png'), 'utf8')).toBe('PIXELS')
  })

  it('never deletes a file a work item references (a deck picture): it is reported as in_use', () => {
    const db = getDb()
    db.exec('CREATE TABLE IF NOT EXISTS work_item_deck_drafts (work_item_id TEXT, doc TEXT)')
    const a = group('Forras')
    const rel = loose(a, 's01.png')
    const it = createWorkItem({ project_id: pid, title: 'Prezi', type: 'note', container_folder: a })
    if (!it.ok) throw new Error('item')
    db.prepare('INSERT INTO work_item_deck_drafts (work_item_id, doc) VALUES (?, ?)').run(it.item.id, JSON.stringify({ src: rel }))
    const r = deleteLooseFiles(proj(), [rel])
    expect(r).toEqual({ ok: true, deleted: [], skipped: [{ name: 's01.png', reason: 'in_use' }] })
    expect(existsSync(join(abs(a), 's01.png'))).toBe(true)
  })

  it('#488: in a folder that also holds a work item, a now-visible picture the deck uses is still never deleted, and the item snapshot is never a loose file', () => {
    const db = getDb()
    db.exec('CREATE TABLE IF NOT EXISTS work_item_deck_drafts (work_item_id TEXT, doc TEXT)')
    const a = group('Prezentacio')
    // a flattened work item sits directly in the folder (its snapshot), next to the slide pictures
    writeFileSync(join(abs(a), 'marveen-item.json'), JSON.stringify({ format: 1, id: 'x', item: { id: 'x' } }))
    const used = loose(a, 's01.png')
    const free = loose(a, 'jegyzet.txt')
    const it = createWorkItem({ project_id: pid, title: 'Prezi', type: 'note', container_folder: a })
    if (!it.ok) throw new Error('item')
    db.prepare('INSERT INTO work_item_deck_drafts (work_item_id, doc) VALUES (?, ?)').run(it.item.id, JSON.stringify({ src: used }))
    const snap = `${used.slice(0, used.lastIndexOf('/'))}/marveen-item.json`
    const r = deleteLooseFiles(proj(), [used, free, snap])
    expect(r).toEqual({ ok: true, deleted: ['jegyzet.txt'], skipped: [{ name: 's01.png', reason: 'in_use' }, { name: 'marveen-item.json', reason: 'not_loose' }] })
    expect(existsSync(join(abs(a), 's01.png'))).toBe(true)
    expect(existsSync(join(abs(a), 'marveen-item.json'))).toBe(true)
    expect(renameLooseFile(proj(), snap, 'mas.json')).toEqual({ ok: false, code: 'file_not_loose' })
    expect(existsSync(join(abs(a), 'marveen-item.json'))).toBe(true)
  })

  it('unknown or outside paths are skipped, and an empty list is refused', () => {
    const a = group('Forras')
    loose(a, 'S01.png')
    expect(deleteLooseFiles(proj(), [])).toEqual({ ok: false, code: 'no_files' })
    const r = deleteLooseFiles(proj(), ['Projektek/Robotok/nincs.png', '../kint.txt'])
    expect(r).toMatchObject({ ok: true, deleted: [] })
    expect((r as { skipped: { reason: string }[] }).skipped.map((s) => s.reason)).toEqual(['not_loose', 'not_loose'])
    expect(existsSync(join(abs(a), 'S01.png'))).toBe(true)
  })
})

describe('renameLooseFile', () => {
  it('renames in place', () => {
    const a = group('Forras')
    const rel = loose(a, 'S01.png', 'x')
    expect(renameLooseFile(proj(), rel, 'Kep 1.png')).toEqual({ ok: true, name: 'Kep 1.png', renamed: true })
    expect(existsSync(join(abs(a), 'S01.png'))).toBe(false)
    expect(readFileSync(join(abs(a), 'Kep 1.png'), 'utf8')).toBe('x')
  })

  it('never overwrites: a taken name is refused and both files stay', () => {
    const a = group('Forras')
    const rel = loose(a, 'S01.png', 'uj')
    writeFileSync(join(abs(a), 'S02.png'), 'regi')
    expect(renameLooseFile(proj(), rel, 'S02.png')).toEqual({ ok: false, code: 'file_name_taken' })
    expect(readFileSync(join(abs(a), 'S02.png'), 'utf8')).toBe('regi')
    expect(readFileSync(join(abs(a), 'S01.png'), 'utf8')).toBe('uj')
  })

  it('refuses bad names and unknown files', () => {
    const a = group('Forras')
    const rel = loose(a, 'S01.png')
    for (const bad of ['', '  ', '../x.png', 'a/b.png', 'a\\b.png', '.rejtett', 'a:b.png', 'x'.repeat(130)]) {
      expect(renameLooseFile(proj(), rel, bad)).toEqual({ ok: false, code: 'file_name' })
    }
    expect(renameLooseFile(proj(), 'Projektek/Robotok/nincs.png', 'x.png')).toEqual({ ok: false, code: 'file_not_loose' })
    expect(existsSync(join(abs(a), 'S01.png'))).toBe(true)
  })

  it('the same name is a no-op', () => {
    const a = group('Forras')
    const rel = loose(a, 'S01.png')
    expect(renameLooseFile(proj(), rel, 'S01.png')).toEqual({ ok: true, name: 'S01.png', renamed: false })
  })

  it('a deck picture is renamed too and the deck JSON path follows (no dead link)', () => {
    const db = getDb()
    db.exec('CREATE TABLE IF NOT EXISTS work_item_deck_drafts (work_item_id TEXT, doc TEXT)')
    const a = group('Forras')
    const rel = loose(a, 's01.png')
    const it = createWorkItem({ project_id: pid, title: 'Prezi', type: 'note', container_folder: a })
    if (!it.ok) throw new Error('item')
    db.prepare('INSERT INTO work_item_deck_drafts (work_item_id, doc) VALUES (?, ?)').run(it.item.id, JSON.stringify({ src: rel }))
    expect(renameLooseFile(proj(), rel, 'cim.png')).toEqual({ ok: true, name: 'cim.png', renamed: true })
    const newRel = (listWorkFolders(proj()).files[a] ?? []).find((x) => x.name === 'cim.png')!.rel
    const doc = (db.prepare('SELECT doc FROM work_item_deck_drafts WHERE work_item_id = ?').get(it.item.id) as { doc: string }).doc
    expect(JSON.parse(doc).src).toBe(newRel)
    expect(existsSync(join(abs(a), 'cim.png'))).toBe(true)
  })
})
