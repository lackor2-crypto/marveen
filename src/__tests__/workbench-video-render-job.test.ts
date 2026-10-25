// #669: the render as a background job -- the editor starts it, polls how far it is, and gets the same body the waiting call returns.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDb, initDatabase } from '../db.js'
import { createProject, updateProject } from '../projects.js'
import { createWorkItem } from '../workbench.js'
import { callWorkbench } from './helpers/workbench-route-call.js'
import { progressSeconds } from '../workbench-video-render.js'
import { startRenderJob, getRenderJob, jobStatus, _clearRenderJobs } from '../workbench-video-jobs.js'

const HAVE_FFMPEG = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0

describe('render progress parsing', () => {
  it('reads the last out_time_us / out_time_ms line (both are microseconds)', () => {
    expect(progressSeconds('frame=10\nout_time_us=1500000\nprogress=continue\nout_time_us=2500000\nprogress=continue\n')).toBe(2.5)
    expect(progressSeconds('out_time_ms=3000000\n')).toBe(3)
    expect(progressSeconds('frame=1\nspeed=1x\n')).toBeNull()
    expect(progressSeconds('out_time=00:00:02.5\n')).toBeNull()
  })
})

describe('render jobs', () => {
  beforeEach(() => _clearRenderJobs())

  it('runs in the background, reports progress, keeps the result, and refuses a second job of the same item', async () => {
    let finish: (v: unknown) => void = () => {}
    const job = startRenderJob('i1', (progress) => new Promise((resolve) => { progress(0.4); finish = resolve }))
    expect(job).not.toBeNull()
    expect(startRenderJob('i1', async () => 1)).toBeNull()
    expect(jobStatus(getRenderJob('i1'))).toMatchObject({ state: 'running', progress: 0.4 })
    finish({ ok: true })
    await new Promise((r) => setTimeout(r, 10))
    expect(jobStatus(getRenderJob('i1'))).toMatchObject({ state: 'done', progress: 1 })
    expect(getRenderJob('i1')!.result).toEqual({ ok: true })
    expect(startRenderJob('i1', async () => 2)).not.toBeNull()
  })

  it('a failure is kept as state error with its code', async () => {
    startRenderJob('i2', async () => { throw { status: 400, code: 'render_source_missing', detail: 'x.mp4' } })
    await new Promise((r) => setTimeout(r, 10))
    expect(jobStatus(getRenderJob('i2'))).toMatchObject({ state: 'error', error: { status: 400, code: 'render_source_missing', detail: 'x.mp4' } })
  })

  it('progress never goes backwards and stays within 0..1', async () => {
    let tick: (f: number) => void = () => {}
    let finish: (v: unknown) => void = () => {}
    startRenderJob('i3', (progress) => new Promise((resolve) => { tick = progress; finish = resolve }))
    tick(0.6); tick(0.3); tick(5)
    expect(getRenderJob('i3')!.progress).toBe(1)
    finish(1)
  })
})

describe('video render over HTTP, as a job', () => {
  let depot = ''
  let pid = ''
  let itemId = ''
  const dir = () => join(depot, 'Projektek', 'teszt')
  const url = (tail = '') => `/api/workbench/items/${itemId}/timeline${tail}`
  const json = { 'content-type': 'application/json' }

  beforeEach(() => {
    _clearRenderJobs()
    initDatabase(':memory:')
    depot = mkdtempSync(join(tmpdir(), 'marveen-wb-job-'))
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

  it('an empty timeline is refused at once, as in the waiting call', async () => {
    const r = await callWorkbench(url('/render'), 'POST', JSON.stringify({ async: true }), json)
    expect(r.status).toBe(400)
    expect(r.body.error).toBe('render_empty')
  })

  it('#789: a failed job carries the person-readable sentence, not only its code', async () => {
    startRenderJob(itemId, async () => { throw { status: 503, code: 'render_no_ffprobe', detail: '/x/ffprobe' } })
    await new Promise((r) => setTimeout(r, 10))
    const r = await callWorkbench(url('/render-status'), 'GET')
    expect(r.body.job.error).toMatchObject({ code: 'render_no_ffprobe', detail: '/x/ffprobe' })
    expect(r.body.job.error.message).toMatch(/ffprobe/)
    expect(r.body.job.error.message).not.toBe('render_no_ffprobe')
  })

  it('status of an item that never rendered: no job', async () => {
    const r = await callWorkbench(url('/render-status'), 'GET')
    expect(r.status).toBe(200)
    expect(r.body.job).toBeNull()
  })

  it.skipIf(!HAVE_FFMPEG)('async render answers 202, then the status moves to done with the same body as the waiting call', async () => {
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=duration=3:size=320x180:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', join(dir(), 'a.mp4')], { stdio: 'pipe' })
    const ops = await callWorkbench(url('/ops'), 'POST', JSON.stringify({ ops: [{ op: 'addClip', src: 'Projektek/teszt/a.mp4', start: 0, end: 2.5 }] }), json)
    expect(ops.status).toBe(201)
    const start = await callWorkbench(url('/render'), 'POST', JSON.stringify({ async: true }), json)
    expect(start.status).toBe(202)
    expect(start.body.job.state).toBe('running')
    // a second start while it runs is refused
    const again = await callWorkbench(url('/render'), 'POST', JSON.stringify({ async: true }), json)
    expect([409, 202]).toContain(again.status)
    let body: any = null
    // A deadline, not a fixed count: under a loaded full suite (load ~11) the ffmpeg render took longer than the old
    // 100 x 200 ms and the test went red with nothing wrong (#772, measured 2026-10-25).
    const until = Date.now() + 75_000
    while (Date.now() < until) {
      const st = await callWorkbench(url('/render-status'), 'GET')
      if (st.body.job && st.body.job.state !== 'running') { body = st.body; break }
      await new Promise((r) => setTimeout(r, 200))
    }
    expect(body).not.toBeNull()
    expect(body.job.state).toBe('done')
    expect(body.result.file.name).toBe('Nyári reklám.mp4')
    expect(body.result.last_render).toMatchObject({ name: 'Nyári reklám.mp4', current: true })
  }, 90_000)
  it.skipIf(!HAVE_FFMPEG)('#786: an edit made while it renders stays in the working copy; the mp4 is recorded on the timeline it was made from', async () => {
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=duration=3:size=320x180:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', join(dir(), 'a.mp4')], { stdio: 'pipe' })
    const ops = await callWorkbench(url('/ops'), 'POST', JSON.stringify({ ops: [{ op: 'addClip', src: 'Projektek/teszt/a.mp4', start: 0, end: 2.5 }] }), json)
    expect(ops.status).toBe(201)
    const start = await callWorkbench(url('/render'), 'POST', JSON.stringify({ async: true }), json)
    expect(start.status).toBe(202)
    // the owner keeps editing while ffmpeg runs: a second clip
    const edit = await callWorkbench(url('/ops'), 'POST', JSON.stringify({ ops: [{ op: 'addClip', src: 'Projektek/teszt/a.mp4', start: 0, end: 1 }] }), json)
    expect([200, 201]).toContain(edit.status)
    let body: any = null
    for (let i = 0; i < 100; i += 1) {
      const st = await callWorkbench(url('/render-status'), 'GET')
      if (st.body.job && st.body.job.state !== 'running') { body = st.body; break }
      await new Promise((r) => setTimeout(r, 200))
    }
    expect(body?.job.state).toBe('done')
    // the render's version holds ONE clip (what was rendered); the working copy holds two
    const versionId = body.result.last_render.version_id as string
    // the version's own file (the timeline it holds), not the working copy standing on it
    const row = getDb().prepare('SELECT source_path FROM work_item_versions WHERE id = ?').get(versionId) as { source_path: string }
    const saved = JSON.parse(readFileSync(join(depot, row.source_path), 'utf-8')) as { clips: unknown[] }
    expect(saved.clips).toHaveLength(1)
    const now = await callWorkbench(url(), 'GET')
    expect(now.body.timeline.clips).toHaveLength(2)
    // and the answer does not claim the video shows the current timeline
    expect(body.result.last_render.current).toBe(false)
    expect(now.body.last_render.current).toBe(false)
  })
  it.skipIf(!HAVE_FFMPEG)('#788: rendering an unchanged timeline again gives the same video back (no "(2).mp4"); a changed one makes a new file', async () => {
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=duration=3:size=320x180:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', join(dir(), 'a.mp4')], { stdio: 'pipe' })
    const ops = await callWorkbench(url('/ops'), 'POST', JSON.stringify({ ops: [{ op: 'addClip', src: 'Projektek/teszt/a.mp4', start: 0, end: 2.5 }] }), json)
    expect(ops.status).toBe(201)
    const mp4s = (): string[] => {
      const out: string[] = []
      const walk = (d: string): void => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.mp4$/i.test(e.name) && e.name !== 'a.mp4') out.push(e.name) } }
      walk(dir())
      return out.sort()
    }
    const first = await callWorkbench(url('/render'), 'POST', JSON.stringify({}), json)
    expect(first.status).toBe(201)
    expect(first.body.reused).toBe(false)
    expect(mp4s()).toEqual(['Nyári reklám.mp4'])
    // the same timeline again: no second render, no copy, said so
    const again = await callWorkbench(url('/render'), 'POST', JSON.stringify({}), json)
    expect(again.status).toBe(201)
    expect(again.body.reused).toBe(true)
    expect(again.body.file.rel).toBe(first.body.file.rel)
    expect(again.body.last_render.current).toBe(true)
    expect(String(again.body.message)).toMatch(/nem változott|has not changed/)
    expect(mp4s()).toEqual(['Nyári reklám.mp4'])
    // a changed timeline: a new file, the earlier version's video stays
    const edit = await callWorkbench(url('/ops'), 'POST', JSON.stringify({ ops: [{ op: 'setAspect', aspect: '9:16' }] }), json)
    expect([200, 201]).toContain(edit.status)
    const third = await callWorkbench(url('/render'), 'POST', JSON.stringify({}), json)
    expect(third.status).toBe(201)
    expect(third.body.reused).toBe(false)
    expect(mp4s()).toEqual(['Nyári reklám (2).mp4', 'Nyári reklám.mp4'])
  })
})

