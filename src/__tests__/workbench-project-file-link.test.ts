// #601: ONE file of the Life tree linked into a folder of the project (the folder right-click menu), not a whole folder.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase } from '../db.js'
import { createProject, updateProject, getProject } from '../projects.js'
import { listMounts, mountsInside, fileMountsInside, removeMount } from '../life-mounts.js'
import { listWorkFolders, deleteLooseFiles } from '../workbench-assets.js'
import { callWorkbench } from './helpers/workbench-route-call.js'

let dir = ''
let pid = ''
beforeEach(() => {
  initDatabase(':memory:')
  dir = mkdtempSync(join(tmpdir(), 'wb-flink-'))
  process.env['MARVEEN_DEPOT'] = dir
  const p = createProject({ name: 'Nemet' })
  if (!p.ok) throw new Error('projekt')
  pid = p.project.id
  if (!updateProject(pid, { folder_path: 'Projektek/Nemet' }).ok) throw new Error('projektmappa')
  mkdirSync(join(dir, 'Projektek', 'Nemet', 'Iratok'), { recursive: true })
  mkdirSync(join(dir, 'Hatosagok', 'Wohngeldbehoerde'), { recursive: true })
  writeFileSync(join(dir, 'Hatosagok', 'Wohngeldbehoerde', 'level.pdf'), 'pdf-bytes')
})
afterEach(() => {
  for (const m of listMounts()) removeMount(m.rel)
  rmSync(dir, { recursive: true, force: true }); delete process.env['MARVEEN_DEPOT']
})

const body = (extra: Record<string, unknown> = {}) => ({ project: pid, folder: 'Iratok', rel: 'Hatosagok/Wohngeldbehoerde/level.pdf', ...extra })

describe('project-file-link endpoint', () => {
  it('links one file into a project folder: a file mount, nothing copied, listed as a linked file', async () => {
    const r = await callWorkbench('/api/workbench/project-file-link', 'POST', body())
    expect(r.status).toBe(201)
    expect(r.body.rel).toBe('Projektek/Nemet/Iratok/level.pdf')
    expect(existsSync(join(dir, 'Projektek', 'Nemet', 'Iratok', 'level.pdf'))).toBe(false)
    expect(fileMountsInside('Projektek/Nemet/Iratok').map((m) => m.rel)).toEqual(['Projektek/Nemet/Iratok/level.pdf'])
    // folder lists never carry a linked file as a folder
    expect(mountsInside('Projektek/Nemet/Iratok')).toEqual([])
    const wf = listWorkFolders(getProject(pid)!)
    const f = (wf.outside.files['Iratok'] || []).find((x) => x.name === 'level.pdf')
    expect(f?.linked).toBe(true)
    expect(f?.size).toBe(9)
  })
  it('refuses a second link with the same name, a folder instead of a file and a missing file', async () => {
    expect((await callWorkbench('/api/workbench/project-file-link', 'POST', body())).status).toBe(201)
    expect((await callWorkbench('/api/workbench/project-file-link', 'POST', body())).status).toBe(409)
    expect((await callWorkbench('/api/workbench/project-file-link', 'POST', body({ rel: 'Hatosagok/Wohngeldbehoerde' }))).status).toBe(404)
    expect((await callWorkbench('/api/workbench/project-file-link', 'POST', body({ rel: 'Hatosagok/nincs.pdf' }))).status).toBe(404)
    expect((await callWorkbench('/api/workbench/project-file-link', 'POST', body({ folder: 'Nincs' }))).status).toBe(404)
  })
  it('deleting a linked file takes the link off; the original is never touched', async () => {
    await callWorkbench('/api/workbench/project-file-link', 'POST', body())
    const r = deleteLooseFiles(getProject(pid)!, ['Projektek/Nemet/Iratok/level.pdf'])
    expect(r.ok && r.deleted).toEqual(['level.pdf'])
    expect(r.ok && r.trash).toEqual([])
    expect(fileMountsInside('Projektek/Nemet/Iratok')).toEqual([])
    expect(readFileSync(join(dir, 'Hatosagok', 'Wohngeldbehoerde', 'level.pdf'), 'utf8')).toBe('pdf-bytes')
  })
})

describe('folder menu (source contract)', () => {
  const js = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.js'), 'utf8')
  it('the folder menu offers the file link and the action posts to the endpoint', () => {
    expect(js).toContain('data-wb-act="folder-link-file"')
    expect(js).toContain("a === 'folder-link-file'")
    expect(js).toContain('/api/workbench/project-file-link')
  })
})
