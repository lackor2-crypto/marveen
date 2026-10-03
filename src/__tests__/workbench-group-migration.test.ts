// Card #480 (#477/C): the group model (a folder is a named group, a work item owns a folder only
// when it has one) must not touch data that already exists. An old-schema database -- the work
// items table as it was before the folder/container/number columns -- opens with every row intact,
// every stored path unchanged, and each shape still working: own folder (a one-member group),
// filed in a shared group, and no folder at all.
import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { ensureWorkbenchTables, listWorkItems, getWorkItem } from '../workbench.js'

const BOX = 'Projektek/X/Munkadarabok'

function oldRow(id: string, title: string, created: number, folder: string | null) {
  getDb().prepare(
    `INSERT INTO work_items (id, project_id, type, title, status, source_path, editor_type, current_version_id, created_at, updated_at, created_by${folder === undefined ? '' : ', folder'})
     VALUES (?, 'p1', 'note', ?, 'draft', NULL, 'text', NULL, ?, ?, 'owner'${folder === undefined ? '' : ', ?'})`,
  ).run(...(folder === undefined ? [id, title, created, created] : [id, title, created, created, folder]))
}

beforeEach(() => {
  initDatabase(':memory:')
})

describe('old-schema work items open unchanged under the group model', () => {
  it('a base-schema table (no folder, container, number columns) keeps every row and gets the new columns', () => {
    getDb().exec(`CREATE TABLE work_items (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, type TEXT NOT NULL, title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft', source_path TEXT, editor_type TEXT NOT NULL DEFAULT 'text',
      current_version_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, created_by TEXT)`)
    oldRow('a', 'Alap', 100, undefined as unknown as null)
    oldRow('b', 'Masik', 200, undefined as unknown as null)
    ensureWorkbenchTables()
    const items = listWorkItems('p1')
    expect(items.map((i) => i.id).sort()).toEqual(['a', 'b'])
    expect(items.every((i) => i.folder == null && i.container_folder == null)).toBe(true)
    // numbered in creation order, nothing renamed
    expect(getWorkItem('a')!.seq).toBe(1)
    expect(getWorkItem('b')!.seq).toBe(2)
    expect(getWorkItem('a')!.title).toBe('Alap')
  })

  it('own-folder, grouped and folder-less items keep their stored paths value for value', () => {
    getDb().exec(`CREATE TABLE work_items (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, type TEXT NOT NULL, title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft', source_path TEXT, editor_type TEXT NOT NULL DEFAULT 'text',
      current_version_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, created_by TEXT,
      folder TEXT, container_folder TEXT)`)
    const ins = getDb().prepare(
      `INSERT INTO work_items (id, project_id, type, title, status, editor_type, created_at, updated_at, folder, container_folder)
       VALUES (?, 'p1', 'note', ?, 'draft', 'text', ?, ?, ?, ?)`,
    )
    ins.run('own', 'Sajat mappas', 1, 1, `${BOX}/Sajat`, BOX)
    ins.run('grp', 'Csoportban', 2, 2, null, `${BOX}/birosagi`)
    ins.run('none', 'Mappa nelkul', 3, 3, null, null)
    ensureWorkbenchTables()
    const by = Object.fromEntries(listWorkItems('p1').map((i) => [i.id, i]))
    expect(Object.keys(by).sort()).toEqual(['grp', 'none', 'own'])
    expect([by.own.folder, by.own.container_folder]).toEqual([`${BOX}/Sajat`, BOX])
    expect([by.grp.folder, by.grp.container_folder]).toEqual([null, `${BOX}/birosagi`])
    expect([by.none.folder, by.none.container_folder]).toEqual([null, null])
    // running the open again changes nothing (idempotent)
    ensureWorkbenchTables()
    expect(listWorkItems('p1')).toHaveLength(3)
  })
})
