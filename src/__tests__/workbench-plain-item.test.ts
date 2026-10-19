// #717 (Boss TG 3759): "Munkadarabba tétel" on a file that already exists makes a PLAIN item: the file stays where it is and
// nothing is generated (no folder, no context file, no to-do file). A brand new item keeps its folder and files.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase } from '../db.js'
import { createProject, updateProject } from '../projects.js'
import { getWorkItem } from '../workbench.js'
import { sweepItemContexts, readItemContext, isPlainItem } from '../workbench-item-context.js'
import { callWorkbench } from './helpers/workbench-route-call.js'

let dir = ''
let pid = ''
let projDir = ''
beforeEach(() => {
  initDatabase(':memory:')
  dir = mkdtempSync(join(tmpdir(), 'wb-plain-'))
  process.env['MARVEEN_DEPOT'] = dir
  const p = createProject({ name: 'Plain' })
  if (!p.ok) throw new Error('projekt')
  pid = p.project.id
  if (!updateProject(pid, { folder_path: 'Projektek/Plain' }).ok) throw new Error('projektmappa')
  projDir = join(dir, 'Projektek', 'Plain')
  mkdirSync(projDir, { recursive: true })
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }); delete process.env['MARVEEN_DEPOT'] })

describe('an item made from an existing file is plain', () => {
  it('points at the file in place and generates no folder, context or to-do file, even after a sweep', async () => {
    writeFileSync(join(projDir, 'Antrag.docx'), 'x')
    const before = readdirSync(projDir)
    const c = await callWorkbench('/api/workbench/items', 'POST', { project_id: pid, type: 'document', title: 'Antrag', source_path: 'Projektek/Plain/Antrag.docx', folder: 'Projektek/Plain' })
    expect(c.status).toBe(201)
    const id = c.body.item.id as string
    expect(getWorkItem(id)!.source_path).toBe('Projektek/Plain/Antrag.docx')
    expect(isPlainItem(id)).toBe(true)
    await sweepItemContexts()
    expect(readdirSync(projDir)).toEqual(before)
    expect(readItemContext(getWorkItem(id)!)).toBeNull()
  })

  it('a brand new item still gets its own folder (unchanged behaviour)', async () => {
    const c = await callWorkbench('/api/workbench/items', 'POST', { project_id: pid, type: 'document', title: 'Uj dokumentum' })
    expect(c.status).toBe(201)
    expect(isPlainItem(c.body.item.id as string)).toBe(false)
    expect(readdirSync(projDir).length).toBeGreaterThan(0)
  })
})
