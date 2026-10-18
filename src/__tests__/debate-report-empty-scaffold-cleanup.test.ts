// #656: empty standard subfolders a debate report made before the fix are removed once; anything with content stays, and
// a report that shares its origin item's folder (fallback) never loses the item's own subfolders.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, getDb } from '../db.js'
import { createProject, updateProject } from '../projects.js'
import { createWorkItem } from '../workbench.js'
import { removeEmptyReportScaffoldFolders } from '../debate-export-doc.js'

let dir = ''
let pid = ''
const BOX = 'Munkadarabok'
beforeEach(() => {
  initDatabase(':memory:')
  dir = mkdtempSync(join(tmpdir(), 'wb-scaf-'))
  process.env['MARVEEN_DEPOT'] = dir
  const p = createProject({ name: 'Nemet' })
  if (!p.ok) throw new Error('projekt')
  pid = p.project.id
  if (!updateProject(pid, { folder_path: 'Projektek/Nemet' }).ok) throw new Error('projektmappa')
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }); delete process.env['MARVEEN_DEPOT'] })

const mk = (rel: string): void => mkdirSync(join(dir, 'Projektek', 'Nemet', ...rel.split('/')), { recursive: true })
const has = (rel: string): boolean => existsSync(join(dir, 'Projektek', 'Nemet', ...rel.split('/')))
const item = (title: string, folder: string): void => {
  const r = createWorkItem({ project_id: pid, type: 'document', title })
  if (!r.ok) throw new Error('munkadarab')
  getDb().prepare('UPDATE work_items SET folder = ? WHERE id = ?').run(folder, r.item.id)
}

describe('empty scaffold folders of a debate report', () => {
  it('removes the empty standard subfolders, keeps the ones with content', () => {
    const f = `${BOX}/Wohngeld/Vitáztatás/jelentés`
    for (const n of ['Elkészített iratok', 'Feltöltések', 'Mellékletek', 'Agent']) mk(`${f}/${n}`)
    writeFileSync(join(dir, 'Projektek', 'Nemet', ...f.split('/'), 'Mellékletek', 'lényeg.txt'), 'x')
    item('Vitáztatás jelentés: Mennyi a lakbér?', f)
    expect(removeEmptyReportScaffoldFolders()).toBe(3)
    expect(has(`${f}/Elkészített iratok`)).toBe(false)
    expect(has(`${f}/Feltöltések`)).toBe(false)
    expect(has(`${f}/Agent`)).toBe(false)
    expect(has(`${f}/Mellékletek/lényeg.txt`)).toBe(true)
    expect(removeEmptyReportScaffoldFolders()).toBe(0)
  })
  it('works for the first folder name and the English title too', () => {
    const f = `${BOX}/Wohngeld/Vitáztatás jelentés`
    mk(`${f}/Uploads`)
    item('Debate report: How much?', f)
    expect(removeEmptyReportScaffoldFolders()).toBe(1)
    expect(has(`${f}/Uploads`)).toBe(false)
    expect(has(f)).toBe(true)
  })
  it('never touches a report that shares its origin item folder', () => {
    const f = `${BOX}/Wohngeld`
    mk(`${f}/Feltöltések`)
    item('Vitáztatás jelentés: Mennyi a lakbér?', f)
    expect(removeEmptyReportScaffoldFolders()).toBe(0)
    expect(has(`${f}/Feltöltések`)).toBe(true)
  })
  it('never touches an ordinary work item', () => {
    const f = `${BOX}/Vitáztatás`
    mk(`${f}/Feltöltések`)
    item('Wohngeld', f)
    expect(removeEmptyReportScaffoldFolders()).toBe(0)
    expect(has(`${f}/Feltöltések`)).toBe(true)
  })
  it('a folder holding only a hidden file is not empty', () => {
    const f = `${BOX}/Wohngeld/Vitáztatás/jelentés`
    mk(`${f}/Feltöltések`)
    writeFileSync(join(dir, 'Projektek', 'Nemet', ...f.split('/'), 'Feltöltések', '.marveen-id'), 'x')
    item('Vitáztatás jelentés: Q', f)
    expect(removeEmptyReportScaffoldFolders()).toBe(0)
    expect(has(`${f}/Feltöltések`)).toBe(true)
  })
})
