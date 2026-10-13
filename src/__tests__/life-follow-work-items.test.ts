// A rename of a Depot folder from the Eletfa / Intezo must carry the work items' file references with it
// (TG 3115): the request PDF of a work item went "missing" after its folder got another name.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, getDb } from '../db.js'
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
})
