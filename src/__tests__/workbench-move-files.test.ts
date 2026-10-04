// Ticked loose files can be moved into another folder of the Workbench box (Boss, TG 2395).
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, getDb } from '../db.js'
import { createProject, updateProject, getProject, type ProjectRow } from '../projects.js'
import { createWorkItem } from '../workbench.js'
import { makeWorkFolder, listWorkFolders, moveLooseFiles } from '../workbench-assets.js'

let pid = ''
let dir = ''
const root = () => join(dir, 'Projektek', 'Robotok')
const proj = (): ProjectRow => getProject(pid) as ProjectRow
const abs = (rel: string) => join(root(), ...rel.split('/'))

beforeEach(() => {
  initDatabase(':memory:')
  dir = mkdtempSync(join(tmpdir(), 'wb-mvf-'))
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

describe('moveLooseFiles', () => {
  it('moves the ticked files into the chosen folder', () => {
    const a = group('Forras')
    const b = group('Cel')
    const r1 = loose(a, 'S01.png')
    const r2 = loose(a, 'S02.png')
    const r = moveLooseFiles(proj(), [r1, r2], b)
    expect(r).toEqual({ ok: true, moved: ['S01.png', 'S02.png'], skipped: [] })
    expect(existsSync(join(abs(b), 'S01.png'))).toBe(true)
    expect(existsSync(join(abs(a), 'S01.png'))).toBe(false)
  })

  it('moves into a folder that already holds a (flattened) work item (#486)', () => {
    const a = group('Forras')
    const b = group('Prezentacio')
    // the group folder also holds a flattened work item: its snapshot sits directly in it
    writeFileSync(join(abs(b), 'marveen-item.json'), JSON.stringify({ format: 1, id: 'x', item: { id: 'x' } }))
    const r1 = loose(a, 'S01.png')
    const r = moveLooseFiles(proj(), [r1], b)
    expect(r).toEqual({ ok: true, moved: ['S01.png'], skipped: [] })
    expect(existsSync(join(abs(b), 'S01.png'))).toBe(true)
    expect(existsSync(join(abs(a), 'S01.png'))).toBe(false)
    // the item's snapshot is untouched
    expect(existsSync(join(abs(b), 'marveen-item.json'))).toBe(true)
  })

  it('never overwrites: a taken name is skipped and both files stay', () => {
    const a = group('Forras')
    const b = group('Cel')
    const r1 = loose(a, 'S01.png', 'uj')
    writeFileSync(join(abs(b), 'S01.png'), 'regi')
    const r = moveLooseFiles(proj(), [r1], b)
    expect(r).toEqual({ ok: true, moved: [], skipped: [{ name: 'S01.png', reason: 'name_taken' }] })
    expect(readFileSync(join(abs(b), 'S01.png'), 'utf8')).toBe('regi')
    expect(readFileSync(join(abs(a), 'S01.png'), 'utf8')).toBe('uj')
  })

  it('a file the registry names (a work item source) is not moved', () => {
    const a = group('Forras')
    const b = group('Cel')
    const rel = loose(a, 'doc.md')
    const it = createWorkItem({ project_id: pid, title: 'Jegyzet', type: 'note', container_folder: a })
    if (!it.ok) throw new Error('item')
    getDb().prepare('UPDATE work_items SET source_path = ? WHERE id = ?').run(rel, it.item.id)
    const r = moveLooseFiles(proj(), [rel], b)
    expect(r).toEqual({ ok: true, moved: [], skipped: [{ name: 'doc.md', reason: 'in_use' }] })
    expect(existsSync(join(abs(a), 'doc.md'))).toBe(true)
  })

  it('same place and unknown paths are skipped, not moved', () => {
    const a = group('Forras')
    const rel = loose(a, 'S01.png')
    const r = moveLooseFiles(proj(), [rel, 'Projektek/Robotok/nincs.png'], a)
    expect(r).toMatchObject({ ok: true, moved: [] })
    expect((r as { skipped: { reason: string }[] }).skipped.map((s) => s.reason)).toEqual(['same_place', 'not_loose'])
  })

  it('refuses without files, and into a folder outside the box', () => {
    const a = group('Forras')
    expect(moveLooseFiles(proj(), [], a)).toEqual({ ok: false, code: 'no_files' })
    const rel = loose(a, 'S01.png')
    expect(moveLooseFiles(proj(), [rel], '../kint')).toMatchObject({ ok: false })
    expect(existsSync(join(abs(a), 'S01.png'))).toBe(true)
  })
})
