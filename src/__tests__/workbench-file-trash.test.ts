// #529 (Boss TG 8585): a file deleted on the Workbench is listed in the Workbench trash and goes back to its
// place on Restore / Undo -- with the work item that named it pointing at it again.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, getDb } from '../db.js'
import { createProject, updateProject, getProject, type ProjectRow } from '../projects.js'
import { createWorkItem, getWorkItem } from '../workbench.js'
import { trashRelPath } from '../life-tree.js'
import { makeWorkFolder, listWorkFolders, deleteLooseFiles } from '../workbench-assets.js'
import { listFileTrash, purgeFileTrash, restoreFileTrash } from '../workbench-file-trash.js'

let pid = ''
let dir = ''
const root = () => join(dir, 'Projektek', 'Robotok')
const proj = (): ProjectRow => getProject(pid) as ProjectRow
const abs = (rel: string) => join(root(), ...rel.split('/'))

beforeEach(() => {
  initDatabase(':memory:')
  dir = mkdtempSync(join(tmpdir(), 'wb-ft-'))
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
function deleted(rels: string[]): string[] {
  const r = deleteLooseFiles(proj(), rels)
  if (!r.ok) throw new Error('delete: ' + r.code)
  return r.trash
}

describe('Workbench file trash (#529)', () => {
  it('a deleted file is listed with its original folder, and Restore puts it back with its content', () => {
    const a = group('Forras')
    const rel = loose(a, 'Új dokumentum.docx', 'WORD')
    const ids = deleted([rel])
    expect(ids).toHaveLength(1)
    const list = listFileTrash(pid)
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ id: ids[0], name: 'Új dokumentum.docx', orig_rel: rel })
    expect(existsSync(join(abs(a), 'Új dokumentum.docx'))).toBe(false)

    const r = restoreFileTrash(pid, ids[0]!)
    expect(r).toMatchObject({ ok: true, rel, name: 'Új dokumentum.docx', renamed: false })
    expect(readFileSync(join(abs(a), 'Új dokumentum.docx'), 'utf8')).toBe('WORD')
    expect(listFileTrash(pid)).toEqual([])
    // The empty Kuka/<stamp> folder the delete made is gone too; the Kuka itself stays.
    expect(readdirSync(join(dir, trashRelPath()))).toEqual([])
  })

  it('the work item that named the file points at it again after Restore', () => {
    const a = group('Forras')
    const rel = loose(a, 'ajanlat.docx')
    const it = createWorkItem({ project_id: pid, title: 'Ajánlat', type: 'document', container_folder: a, source_path: rel })
    if (!it.ok) throw new Error('item')
    const ids = deleted([rel])
    expect(getWorkItem(it.item.id)?.source_path).toBeNull()
    expect(restoreFileTrash(pid, ids[0]!).ok).toBe(true)
    expect(getWorkItem(it.item.id)?.source_path).toBe(rel)
  })

  it('a name taken meanwhile is never overwritten: the restored file gets a free name', () => {
    const a = group('Forras')
    const rel = loose(a, 'jegyzet.txt', 'OLD')
    const ids = deleted([rel])
    writeFileSync(join(abs(a), 'jegyzet.txt'), 'NEW')
    const r = restoreFileTrash(pid, ids[0]!)
    expect(r).toMatchObject({ ok: true, name: 'jegyzet (2).txt', renamed: true })
    expect(readFileSync(join(abs(a), 'jegyzet.txt'), 'utf8')).toBe('NEW')
    expect(readFileSync(join(abs(a), 'jegyzet (2).txt'), 'utf8')).toBe('OLD')
  })

  it('an entry whose Kuka copy is gone (emptied) leaves the list, and its restore says so', () => {
    const a = group('Forras')
    const rel = loose(a, 'kep.png')
    const ids = deleted([rel])
    rmSync(join(dir, trashRelPath()), { recursive: true, force: true })
    expect(restoreFileTrash(pid, ids[0]!)).toEqual({ ok: false, code: 'file_trash_gone' })
    expect(listFileTrash(pid)).toEqual([])
  })

  it('another project cannot restore (or see) this project\'s deleted file', () => {
    const a = group('Forras')
    const ids = deleted([loose(a, 'titok.txt')])
    const other = createProject({ name: 'Masik' })
    if (!other.ok) throw new Error('projekt')
    expect(listFileTrash(other.project.id)).toEqual([])
    expect(restoreFileTrash(other.project.id, ids[0]!)).toEqual({ ok: false, code: 'file_trash_missing' })
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM wb_file_trash').get()).toEqual({ n: 1 })
  })

  // #548: "Delete permanently" on a file row forgets the entry only; the Life tree's Kuka keeps the file.
  it('purge forgets the row but leaves the file in the Kuka untouched (nothing is deleted from the Life tree)', () => {
    const a = group('Forras')
    const rel = loose(a, 'Új dokumentum.docx', 'WORD')
    const ids = deleted([rel])
    const row = getDb().prepare('SELECT trash_rel FROM wb_file_trash WHERE id = ?').get(ids[0]) as { trash_rel: string }
    const kukaAbs = join(dir, ...row.trash_rel.split('/'))
    expect(existsSync(kukaAbs)).toBe(true)
    expect(purgeFileTrash(pid, ids[0]!)).toEqual({ ok: true, name: 'Új dokumentum.docx' })
    expect(listFileTrash(pid)).toEqual([])
    expect(existsSync(kukaAbs)).toBe(true)
    expect(readFileSync(kukaAbs, 'utf8')).toBe('WORD')
    // It cannot be restored from the Workbench any more.
    expect(restoreFileTrash(pid, ids[0]!)).toEqual({ ok: false, code: 'file_trash_missing' })
  })

  it('purge refuses an unknown id and another project\'s entry', () => {
    const a = group('Forras')
    const ids = deleted([loose(a, 'titok.txt')])
    const other = createProject({ name: 'Masik' })
    if (!other.ok) throw new Error('projekt')
    expect(purgeFileTrash(pid, 'nincs-ilyen')).toEqual({ ok: false, code: 'file_trash_missing' })
    expect(purgeFileTrash(other.project.id, ids[0]!)).toEqual({ ok: false, code: 'file_trash_missing' })
    expect(listFileTrash(pid)).toHaveLength(1)
  })
})
