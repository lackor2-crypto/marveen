// A rename of a Depot folder from the Eletfa / Intezo must carry the work items' file references with it
// (TG 3115): the request PDF of a work item went "missing" after its folder got another name.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, getDb } from '../db.js'
import { ensureAnnexTables } from '../workbench-docannex.js'
import { createProject, updateProject } from '../projects.js'
import { registerAsset, listWorkItemAssets, followDepotFolderMove } from '../workbench-assets.js'
import { followFolderMove } from '../life-follow.js'
import { callWorkbench } from './helpers/workbench-route-call.js'

let dir = ''
let itemId = ''
const REL = 'Hatosagok/Wohngeld/Hianypotlas 2026-10/Kerelem/antrag.pdf'

beforeEach(async () => {
  initDatabase(':memory:')
  dir = mkdtempSync(join(tmpdir(), 'life-follow-wi-'))
  process.env['MARVEEN_DEPOT'] = dir
  const p = createProject({ name: 'Nemet' })
  if (!p.ok) throw new Error('projekt')
  if (!updateProject(p.project.id, { folder_path: 'Projektek/Nemet' }).ok) throw new Error('projektmappa')
  mkdirSync(join(dir, 'Projektek', 'Nemet'), { recursive: true })
  mkdirSync(join(dir, ...REL.split('/').slice(0, -1)), { recursive: true })
  writeFileSync(join(dir, ...REL.split('/')), 'pdf')
  const c = await callWorkbench('/api/workbench/items', 'POST', { project_id: p.project.id, type: 'document', title: 'Wohngeld' })
  itemId = c.body.item.id as string
  registerAsset(itemId, REL, 'antrag.pdf', 'x'.repeat(64), 3, null)
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }); delete process.env['MARVEEN_DEPOT'] })

const asset = () => listWorkItemAssets(itemId).find((a) => a.name === 'antrag.pdf')!

describe('Depot folder rename follows the work items', () => {
  it('without the follow-up the attached file is missing, with it the path and "present" follow', () => {
    renameSync(join(dir, 'Hatosagok/Wohngeld/Hianypotlas 2026-10'), join(dir, 'Hatosagok/Wohngeld/2026-10_uj_kerelem'))
    expect(asset().present).toBe(false)
    followFolderMove('Hatosagok/Wohngeld/Hianypotlas 2026-10', 'Hatosagok/Wohngeld/2026-10_uj_kerelem')
    expect(asset().path).toBe('Hatosagok/Wohngeld/2026-10_uj_kerelem/Kerelem/antrag.pdf')
    expect(asset().present).toBe(true)
  })

  it('a sibling folder with the same name prefix is not touched', () => {
    expect(followDepotFolderMove('Hatosagok/Wohngeld/Hianypotlas', 'Hatosagok/Wohngeld/X')).toBe(0)
    expect(asset().path).toBe(REL)
    expect(getDb()).toBeTruthy()
  })

  it('the other registries follow too: item/version source, parts, project-relative folders, annexes, saved PDF', () => {
    const db = getDb()
    ensureAnnexTables()
    const OLD = 'Projektek/Nemet/Munkadarabok/Wohngeld'
    const NEW = 'Projektek/Nemet/Munkadarabok/Wohngeld_uj'
    db.prepare('UPDATE work_items SET folder = ?, container_folder = ?, source_path = ? WHERE id = ?')
      .run('Munkadarabok/Wohngeld', 'Munkadarabok/Wohngeld', `${OLD}/Kerelem.pdf`, itemId)
    db.prepare('INSERT INTO work_item_versions (id, work_item_id, version_no, created_at, metadata_json, source_path) VALUES (?, ?, 99, 1, ?, ?)')
      .run('v1', itemId, JSON.stringify({ pdf_path: `${OLD}/Kerelem.pdf`, files: [{ path: `${OLD}/Anlage.pdf`, name: 'Anlage' }] }), `${OLD}/Kerelem.pdf`)
    db.prepare("INSERT INTO work_item_parts (id, work_item_id, position, kind, asset_path, created_at, updated_at) VALUES ('p1', ?, 0, 'image', ?, 1, 1)")
      .run(itemId, `${OLD}/kep.png`)
    db.prepare("INSERT INTO wb_doc_annexes (id, work_item_id, position, path, title, created_at) VALUES ('a1', ?, 0, 'Munkadarabok/Wohngeld/Anlage.pdf', 'Anlage', 1)").run(itemId)
    followFolderMove(OLD, NEW)
    const row = db.prepare('SELECT folder, container_folder, source_path FROM work_items WHERE id = ?').get(itemId) as Record<string, string>
    expect(row).toEqual({ folder: 'Munkadarabok/Wohngeld_uj', container_folder: 'Munkadarabok/Wohngeld_uj', source_path: `${NEW}/Kerelem.pdf` })
    expect((db.prepare("SELECT source_path FROM work_item_versions WHERE id = 'v1'").get() as any).source_path).toBe(`${NEW}/Kerelem.pdf`)
    const meta = JSON.parse((db.prepare("SELECT metadata_json FROM work_item_versions WHERE id = 'v1'").get() as any).metadata_json)
    expect(meta.pdf_path).toBe(`${NEW}/Kerelem.pdf`)
    expect(meta.files[0].path).toBe(`${NEW}/Anlage.pdf`)
    expect((db.prepare("SELECT asset_path FROM work_item_parts WHERE id = 'p1'").get() as any).asset_path).toBe(`${NEW}/kep.png`)
    expect((db.prepare("SELECT path FROM wb_doc_annexes WHERE id = 'a1'").get() as any).path).toBe('Munkadarabok/Wohngeld_uj/Anlage.pdf')
  })

  it('renaming the project folder itself keeps the project-relative folders, only the Depot paths move', () => {
    const db = getDb()
    db.prepare('UPDATE work_items SET folder = ? WHERE id = ?').run('Munkadarabok/Wohngeld', itemId)
    registerAsset(itemId, 'Projektek/Nemet/Munkadarabok/Wohngeld/b.pdf', 'b.pdf', 'y'.repeat(64), 3, null)
    followFolderMove('Projektek/Nemet', 'Projektek/Nemet_uj')
    expect((db.prepare('SELECT folder FROM work_items WHERE id = ?').get(itemId) as any).folder).toBe('Munkadarabok/Wohngeld')
    expect(listWorkItemAssets(itemId).find((a) => a.name === 'b.pdf')!.path).toBe('Projektek/Nemet_uj/Munkadarabok/Wohngeld/b.pdf')
  })
})
