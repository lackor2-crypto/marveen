// A folder renamed in the Eletfa must carry the work item's OWN folder (project-relative columns), its context file row and the
// document model's file paths with it -- not only the Depot-relative file paths (bug sweep, #589).
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, renameSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase } from '../db.js'
import { createProject, updateProject, getProject } from '../projects.js'
import { getWorkItem } from '../workbench.js'
import { assignWorkItemFolder } from '../workbench-assets.js'
import { followFolderMove } from '../life-follow.js'
import { sweepItemContexts, readItemContext } from '../workbench-item-context.js'
import { callWorkbench } from './helpers/workbench-route-call.js'

let dir = ''
let itemId = ''
beforeEach(async () => {
  initDatabase(':memory:')
  dir = mkdtempSync(join(tmpdir(), 'life-follow-folder-'))
  process.env['MARVEEN_DEPOT'] = dir
  const p = createProject({ name: 'Nemet' })
  if (!p.ok) throw new Error('projekt')
  if (!updateProject(p.project.id, { folder_path: 'Projektek/Nemet' }).ok) throw new Error('projektmappa')
  mkdirSync(join(dir, 'Projektek', 'Nemet', 'Kerelem'), { recursive: true })
  const c = await callWorkbench('/api/workbench/items', 'POST', { project_id: p.project.id, type: 'document', title: 'Wohngeld' })
  itemId = c.body.item.id as string
  assignWorkItemFolder(itemId, 'Kerelem')
  await sweepItemContexts()
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }); delete process.env['MARVEEN_DEPOT'] })

describe('Eletfa rename of the item folder', () => {
  it('the item folder, the context file and the next sweep stay on the renamed folder', async () => {
    const before = readItemContext(getWorkItem(itemId)!)!
    expect(before.rel.startsWith('Projektek/Nemet/Kerelem/')).toBe(true)
    renameSync(join(dir, 'Projektek/Nemet/Kerelem'), join(dir, 'Projektek/Nemet/2026-10_uj_kerelem'))
    followFolderMove('Projektek/Nemet/Kerelem', 'Projektek/Nemet/2026-10_uj_kerelem')
    const it = getWorkItem(itemId)!
    expect(String(it.folder ?? '')).not.toBe('Kerelem')
    await sweepItemContexts()
    expect(existsSync(join(dir, 'Projektek/Nemet/Kerelem'))).toBe(false) // no phantom folder under the old name
    const after = readItemContext(getWorkItem(itemId)!)!
    expect(after.rel.startsWith('Projektek/Nemet/2026-10_uj_kerelem/')).toBe(true)
    expect(getProject(it.project_id)).toBeTruthy()
  })
})
