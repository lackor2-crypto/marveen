// Boss TG 2752: a new document must have ONE folder named after it, not the same name twice nested.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase } from '../db.js'
import { createProject, updateProject } from '../projects.js'
import { callWorkbench } from './helpers/workbench-route-call.js'
import { mirrorOutlineToFile } from '../workbench-docmirror.js'

let pid = ''
let dir = ''
beforeEach(() => {
  initDatabase(':memory:')
  dir = mkdtempSync(join(tmpdir(), 'wb-df-'))
  process.env['MARVEEN_DEPOT'] = dir
  const p = createProject({ name: 'Egyeb' })
  if (!p.ok) throw new Error('projekt')
  pid = p.project.id
  if (!updateProject(pid, { folder_path: 'Projektek/Egyeb' }).ok) throw new Error('projektmappa')
  mkdirSync(join(dir, 'Projektek', 'Egyeb'), { recursive: true })
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }); delete process.env['MARVEEN_DEPOT'] })

function tree(p: string, d = 0): string[] {
  return readdirSync(p, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? [`${'-'.repeat(d)}${e.name}/`, ...tree(join(p, e.name), d + 1)] : [])
}

describe('a new document gets one folder', () => {
  it('creating + mirroring does not nest a second folder of the same name', async () => {
    const c = await callWorkbench('/api/workbench/intake', 'POST', { project_id: pid, kind: 'document', title: 'Uj birosagi beadvany', text: 'birosagi beadvany' })
    expect(c.status).toBe(201)
    const id = c.body.item.id
    const { addOutlineSection } = await import('../workbench-outline.js').catch(() => ({ addOutlineSection: null as any }))
    if (addOutlineSection) addOutlineSection(id, { title: 'Fejezet' })
    await mirrorOutlineToFile(id).catch(() => null)
    const { ensureWorkItemFolder } = await import('../workbench-assets.js')
    const { getWorkItem } = await import('../workbench.js')
    ensureWorkItemFolder(getWorkItem(id)!)
    const dirs = tree(join(dir, 'Projektek', 'Egyeb'))
    expect(dirs.filter((x) => x.includes('Uj birosagi beadvany'))).toHaveLength(1)
  })
})
