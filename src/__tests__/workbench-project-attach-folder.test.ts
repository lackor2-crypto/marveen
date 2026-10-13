// TG 3120: every project offers "attach a folder from the Explorer" next to Open, and the "hide finalized work"
// switch is there in EVERY project (also a new one with nothing finalized yet), not only after the first finalize.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase } from '../db.js'
import { createProject, updateProject } from '../projects.js'
import { listMounts, removeMount } from '../life-mounts.js'
import { callWorkbench } from './helpers/workbench-route-call.js'

let dir = ''
let pid = ''
beforeEach(() => {
  initDatabase(':memory:')
  dir = mkdtempSync(join(tmpdir(), 'wb-attach-'))
  process.env['MARVEEN_DEPOT'] = dir
  const p = createProject({ name: 'Nemet' })
  if (!p.ok) throw new Error('projekt')
  pid = p.project.id
  if (!updateProject(pid, { folder_path: 'Projektek/Nemet' }).ok) throw new Error('projektmappa')
  mkdirSync(join(dir, 'Projektek', 'Nemet'), { recursive: true })
  mkdirSync(join(dir, 'Hatosagok', 'Wohngeldbehoerde'), { recursive: true })
})
afterEach(() => {
  removeMount('Projektek/Nemet/Wohngeldbehoerde')
  rmSync(dir, { recursive: true, force: true }); delete process.env['MARVEEN_DEPOT']
})

describe('project-mount endpoint', () => {
  it('attaches a Life folder under the project (a mount, nothing copied) and refuses a second time', async () => {
    const r = await callWorkbench('/api/workbench/project-mount', 'POST', { project: pid, rel: 'Hatosagok/Wohngeldbehoerde' })
    expect(r.status).toBe(201)
    expect(r.body.rel).toBe('Projektek/Nemet/Wohngeldbehoerde')
    expect(listMounts().some((m) => m.rel === 'Projektek/Nemet/Wohngeldbehoerde' && m.target === 'Hatosagok/Wohngeldbehoerde')).toBe(true)
    const again = await callWorkbench('/api/workbench/project-mount', 'POST', { project: pid, rel: 'Hatosagok/Wohngeldbehoerde' })
    expect(again.status).toBe(409)
  })
  it('a folder that is not there is refused', async () => {
    const r = await callWorkbench('/api/workbench/project-mount', 'POST', { project: pid, rel: 'Hatosagok/Nincs' })
    expect(r.status).toBe(404)
  })
})

describe('project panel (source contract)', () => {
  const js = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.js'), 'utf8')
  it('the attach button sits in the panel head and the hide switch no longer depends on finalized items', () => {
    expect(js).toContain('data-wb-act="attach-folder"')
    expect(js).toContain("a === 'attach-folder'")
    expect(js).not.toContain("if (!h.on && !h.done) return ''")
  })
})
