// #670: the CapCut bridge. The button exists only where CapCut does, and it never claims to have passed the file
// (measured: CapCut ignores a file argument on start).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const found = vi.hoisted(() => ({ value: null as null | { kind: 'windows' | 'macos'; path: string } }))
vi.mock('../open-in-capcut.js', async (orig) => {
  const real = await orig<typeof import('../open-in-capcut.js')>()
  return { ...real, findCapcut: () => found.value, openInCapcut: vi.fn(async () => ({ ok: true as const, file_passed: false as const })) }
})

import { initDatabase } from '../db.js'
import { createProject, updateProject } from '../projects.js'
import { createWorkItem } from '../workbench.js'
import { capcutLaunchScript } from '../open-in-capcut.js'
import { callWorkbench } from './helpers/workbench-route-call.js'

describe('open in CapCut', () => {
  let depot = ''
  let pid = ''
  beforeEach(() => {
    initDatabase(':memory:')
    depot = mkdtempSync(join(tmpdir(), 'marveen-capcut-'))
    process.env['MARVEEN_DEPOT'] = depot
    const p = createProject({ name: 'Iroda fejlesztese' })
    if (!p.ok) throw new Error('project')
    pid = p.project.id
    if (!updateProject(pid, { folder_path: 'Projektek/Iroda' }).ok) throw new Error('folder')
    found.value = null
  })
  afterEach(() => { rmSync(depot, { recursive: true, force: true }); delete process.env['MARVEEN_DEPOT'] })

  it('the probe says unavailable where there is no CapCut (fresh / server install)', async () => {
    const r = await callWorkbench('/api/workbench/capcut', 'GET')
    expect(r.status).toBe(200)
    expect(r.body.available).toBe(false)
  })

  it('the probe says available when CapCut is found', async () => {
    found.value = { kind: 'windows', path: '/mnt/c/x/CapCut.exe' }
    expect((await callWorkbench('/api/workbench/capcut', 'GET')).body.available).toBe(true)
  })

  it('opening without CapCut is a plain 409 with a human sentence', async () => {
    const w = createWorkItem({ project_id: pid, title: 'Reklám', type: 'video' })
    if (!w.ok) throw new Error('item')
    const r = await callWorkbench(`/api/workbench/items/${w.item.id}/open-in-capcut`, 'POST', '{}', { 'content-type': 'application/json' })
    expect(r.status).toBe(409)
    expect(r.body.error).toBe('capcut_no_capcut')
    expect(r.body.message).toMatch(/CapCut/)
  })

  it('with CapCut but no finished video, it asks to render first', async () => {
    found.value = { kind: 'windows', path: '/mnt/c/x/CapCut.exe' }
    const w = createWorkItem({ project_id: pid, title: 'Reklám', type: 'video' })
    if (!w.ok) throw new Error('item')
    const r = await callWorkbench(`/api/workbench/items/${w.item.id}/open-in-capcut`, 'POST', '{}', { 'content-type': 'application/json' })
    expect(r.status).toBe(409)
    expect(r.body.error).toBe('capcut_no_render')
  })

  it('only a video work item can be opened in CapCut', async () => {
    found.value = { kind: 'windows', path: '/mnt/c/x/CapCut.exe' }
    const w = createWorkItem({ project_id: pid, title: 'Jegyzet', type: 'document' })
    if (!w.ok) throw new Error('item')
    const r = await callWorkbench(`/api/workbench/items/${w.item.id}/open-in-capcut`, 'POST', '{}', { 'content-type': 'application/json' })
    expect(r.body.error).toBe('capcut_not_video')
  })

  it('the launch script starts the program with NO file argument and reports the real exception', () => {
    const s = capcutLaunchScript("C:\\Users\\O'Neil\\CapCut.exe", 'C:\\Users\\Public\\r.txt')
    expect(s).toContain("O''Neil")
    expect(s).toContain('Start-Process -FilePath $e -PassThru')
    expect(s).not.toContain('-ArgumentList')
    expect(s).toContain('fail :: $($_.Exception.Message)')
  })
})
