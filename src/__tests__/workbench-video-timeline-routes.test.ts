// Video timeline over HTTP: the working copy, undo, versions, and the render.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, readdirSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase } from '../db.js'
import { createProject, updateProject } from '../projects.js'
import { createWorkItem } from '../workbench.js'
import { callWorkbench } from './helpers/workbench-route-call.js'

const HAVE_FFMPEG = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0

describe('video timeline: the routes', () => {
  let depot = ''
  let pid = ''
  let itemId = ''
  const dir = () => join(depot, 'Projektek', 'teszt')
  const url = (tail = '') => `/api/workbench/items/${itemId}/timeline${tail}`

  beforeEach(() => {
    initDatabase(':memory:')
    depot = mkdtempSync(join(tmpdir(), 'marveen-wb-tl-'))
    mkdirSync(dir(), { recursive: true })
    process.env['MARVEEN_DEPOT'] = depot
    const p = createProject({ name: 'Kovács ház' })
    if (!p.ok) throw new Error('project')
    pid = p.project.id
    if (!updateProject(pid, { folder_path: 'Projektek/teszt' }).ok) throw new Error('folder')
    const w = createWorkItem({ project_id: pid, title: 'Nyári reklám', type: 'video' })
    if (!w.ok) throw new Error('item')
    itemId = w.item.id
  })

  afterEach(() => {
    rmSync(depot, { recursive: true, force: true })
    delete process.env['MARVEEN_DEPOT']
  })

  const ops = (list: unknown[], extra: Record<string, unknown> = {}) => callWorkbench(url('/ops'), 'POST', JSON.stringify({ ops: list, ...extra }), { 'content-type': 'application/json' })

  it('a fresh video item has an empty timeline (not an error); the first edit creates the file and version 1', async () => {
    const g = await callWorkbench(url(), 'GET')
    expect(g.status).toBe(200)
    expect(g.body).toMatchObject({ exists: false, timeline: { clips: [] }, last_render: null })
    const r = await ops([{ op: 'addClip', src: 'Projektek/teszt/a.mp4', start: 0, end: 3 }])
    expect(r.status).toBe(201)
    expect(r.body.created).toBe(true)
    expect(readdirSync(dir())).toEqual(['nyari-reklam.timeline.json'])
    const r2 = await ops([{ op: 'addSubtitle', text: 'Szia', start: 0, end: 2 }])
    expect(r2.status).toBe(200)
    expect(r2.body.created).toBe(false)
    expect(r2.body.history.can_undo).toBe(true)
    expect(readdirSync(dir())).toEqual(['nyari-reklam.timeline.json'])
  })

  it('undo and redo replay the step; the version button names a milestone', async () => {
    await ops([{ op: 'addClip', src: 'Projektek/teszt/a.mp4', start: 0, end: 3 }])
    await ops([{ op: 'addSubtitle', text: 'Szia', start: 0, end: 2 }])
    const u = await callWorkbench(url('/undo'), 'POST')
    expect(u.status).toBe(200)
    expect(u.body.timeline.subtitles).toEqual([])
    const re = await callWorkbench(url('/redo'), 'POST')
    expect(re.body.timeline.subtitles).toHaveLength(1)
    const v = await callWorkbench(url('/version'), 'POST', JSON.stringify({ label: 'első vágás' }), { 'content-type': 'application/json' })
    expect(v.status).toBe(201)
    expect(v.body.versions.length).toBe(3)
    // Undo survives a version (the version only freezes a milestone), and runs out at the start.
    expect((await callWorkbench(url('/undo'), 'POST')).status).toBe(200)
    expect((await callWorkbench(url('/undo'), 'POST')).status).toBe(200)
    const none = await callWorkbench(url('/undo'), 'POST')
    expect(none.status).toBe(409)
    expect(none.body.message).toMatch(/Nincs mit visszavonni/)
  })

  it('bad operations are 400 with a human sentence; a non-video item has no timeline', async () => {
    const bad = await ops([{ op: 'addClip', src: '../x.mp4', start: 0, end: 1 }])
    expect(bad.status).toBe(400)
    expect(bad.body.message).toMatch(/Klipnek videót/)
    const w = createWorkItem({ project_id: pid, title: 'Levél', type: 'document' })
    if (!w.ok) throw new Error('item')
    const r = await callWorkbench(`/api/workbench/items/${w.item.id}/timeline`, 'GET')
    expect(r.status).toBe(409)
    expect(r.body.error).toBe('timeline_not_video')
  })

  it('render without clips says so in words', async () => {
    const r = await callWorkbench(url('/render'), 'POST')
    expect(r.status).toBe(400)
    expect(r.body.error).toBe('render_empty')
    expect(r.body.message).toMatch(/nincs klip/)
  })

  it.skipIf(!HAVE_FFMPEG)('render makes a NEW mp4 next to the timeline, records it on the version, and a missing file is named', async () => {
    const ff = (args: string[]) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'pipe' })
    ff(['-f', 'lavfi', '-i', 'testsrc=duration=3:size=320x180:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', join(dir(), 'a.mp4')])
    const missing = await ops([{ op: 'addClip', src: 'Projektek/teszt/nincs.mp4', start: 0, end: 1 }])
    expect(missing.status).toBe(201)
    const miss = await callWorkbench(url('/render'), 'POST')
    expect(miss.status).toBe(400)
    expect(miss.body.error).toBe('render_source_missing')
    expect(miss.body.detail).toContain('nincs.mp4')
    const clip = (await callWorkbench(url(), 'GET')).body.timeline.clips[0].id
    await ops([{ op: 'removeClip', id: clip }, { op: 'addClip', src: 'Projektek/teszt/a.mp4', start: 0.5, end: 2.5 }, { op: 'setAspect', aspect: '9:16' }])
    const r = await callWorkbench(url('/render'), 'POST')
    expect(r.status).toBe(201)
    expect(r.body.file.name).toBe('Nyári reklám.mp4')
    expect(r.body.seconds).toBe(2)
    expect(readdirSync(dir()).sort()).toEqual(['Nyári reklám.mp4', 'a.mp4', 'nyari-reklam.timeline.json', 'nyari-reklam.timeline (2).json'].sort())
    expect(r.body.last_render).toMatchObject({ name: 'Nyári reklám.mp4', current: true })
    const g = await callWorkbench(url(), 'GET')
    expect(g.body.last_render.current).toBe(true)
    // An edit after the render makes the picture stale, and a second render never overwrites.
    await ops([{ op: 'setClipVolume', volume: 0.5 }])
    expect((await callWorkbench(url(), 'GET')).body.last_render.current).toBe(false)
    const again = await callWorkbench(url('/render'), 'POST')
    expect(again.body.file.name).toBe('Nyári reklám (2).mp4')
    expect(readdirSync(dir()).filter((n) => n.endsWith('.mp4')).sort()).toEqual(['a.mp4', 'Nyári reklám (2).mp4', 'Nyári reklám.mp4'].sort())
  })
})

import { runTool } from '../workbench-agent/execute.js'
import { getTool } from '../workbench-agent/tools.js'

describe('video timeline: the Workbench agent', () => {
  let depot = ''
  let pid = ''
  let itemId = ''
  const dir = () => join(depot, 'Projektek', 'teszt')
  const ctx = () => ({ projectId: pid, workItemId: itemId, lang: 'en' as const })

  beforeEach(() => {
    initDatabase(':memory:')
    depot = mkdtempSync(join(tmpdir(), 'marveen-wb-tla-'))
    mkdirSync(dir(), { recursive: true })
    process.env['MARVEEN_DEPOT'] = depot
    const p = createProject({ name: 'Kovács ház' })
    if (!p.ok) throw new Error('project')
    pid = p.project.id
    updateProject(pid, { folder_path: 'Projektek/teszt' })
    const w = createWorkItem({ project_id: pid, title: 'Reklám', type: 'video' })
    if (!w.ok) throw new Error('item')
    itemId = w.item.id
  })
  afterEach(() => {
    rmSync(depot, { recursive: true, force: true })
    delete process.env['MARVEEN_DEPOT']
  })

  it('the tools exist: read is free, edit and render are file writes', () => {
    expect(getTool('timeline.get')?.autonomyCategory).toBeNull()
    expect(getTool('timeline.edit')?.autonomyCategory).toBe('workbench_file_write')
    expect(getTool('timeline.render')?.autonomyCategory).toBe('workbench_file_write')
  })

  it('get on a fresh item says there is no timeline yet; edit then get shows the clip; one request is one undo step', async () => {
    const g: any = await runTool('timeline.get', {}, ctx())
    expect(g.ok).toBe(true)
    expect(g.data.exists).toBe(false)
    expect(g.data.note).toMatch(/no timeline yet/)
    const e: any = await runTool('timeline.edit', { ops: [
      { op: 'addClip', src: 'Projektek/teszt/a.mp4', start: 0, end: 4 },
      { op: 'addSubtitle', text: 'Hello', start: 0, end: 2 },
      { op: 'setAspect', aspect: '9:16' },
    ] }, { ...ctx(), turnId: 't1' })
    expect(e.ok).toBe(true)
    expect(e.data.summary).toContain('1 clips (4s)')
    const g2: any = await runTool('timeline.get', {}, ctx())
    expect(g2.data.timeline.aspect).toBe('9:16')
    const u = await callWorkbench(`/api/workbench/items/${itemId}/timeline/undo`, 'POST')
    expect(u.status).toBe(200)
    expect(u.body.timeline.clips).toHaveLength(0)
  })

  it('a bad operation is a code and a reason, and changes nothing; a non-video item is refused', async () => {
    const bad: any = await runTool('timeline.edit', { ops: [{ op: 'addClip', src: '../x.mp4', start: 0, end: 1 }] }, ctx())
    expect(bad).toMatchObject({ ok: false, code: 'timeline_bad_media' })
    const w = createWorkItem({ project_id: pid, title: 'Levél', type: 'document' })
    if (!w.ok) throw new Error('item')
    expect(await runTool('timeline.get', { id: w.item.id }, ctx())).toMatchObject({ ok: false, code: 'bad_input' })
  })

  it('render with no clips is a plain failure, with a code', async () => {
    expect(await runTool('timeline.render', {}, ctx())).toMatchObject({ ok: false, code: 'render_empty' })
  })
})
