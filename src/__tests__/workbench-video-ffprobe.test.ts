// #789: an ffmpeg without its ffprobe renders nothing (every clip is measured with ffprobe). The render says so in plain
// words (and where it looked), and the Capabilities panel / the self-check measure ffmpeg TOGETHER with ffprobe.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase } from '../db.js'
import { createProject, updateProject, getProject, type ProjectRow } from '../projects.js'
import { _setVideoDeps } from '../workbench-video.js'
import { _setRenderDeps, fillClipEnds, renderTimeline, ffprobeBeside } from '../workbench-video-render.js'
import { applyTimelineOps, emptyTimeline } from '../workbench-video-timeline.js'
import { probeVideoTools } from '../workbench-capabilities.js'

const isWin = process.platform === 'win32'

describe('#789 render without ffprobe', () => {
  let dir = ''
  let project: ProjectRow
  beforeEach(() => {
    initDatabase(':memory:')
    dir = mkdtempSync(join(tmpdir(), 'wb-ffprobe-'))
    process.env['MARVEEN_DEPOT'] = dir
    const p = createProject({ name: 'Klip' })
    if (!p.ok) throw new Error('projekt')
    updateProject(p.project.id, { folder_path: 'Projektek/Klip' })
    mkdirSync(join(dir, 'Projektek', 'Klip'), { recursive: true })
    writeFileSync(join(dir, 'Projektek', 'Klip', 'a.mp4'), 'x')
    project = getProject(p.project.id) as ProjectRow
    _setVideoDeps({ tool: async () => ({ state: 'ok', path: '/opt/video/bin/ffmpeg', detail: null }) })
  })
  afterEach(() => { _setVideoDeps(); _setRenderDeps(); rmSync(dir, { recursive: true, force: true }); delete process.env['MARVEEN_DEPOT'] })

  const doc = () => {
    const r = applyTimelineOps(emptyTimeline(), [{ op: 'addClip', src: 'Projektek/Klip/a.mp4', start: 0, end: 2 }])
    if (!r.ok) throw new Error(r.detail)
    return r.doc
  }

  it('ffprobe missing: its own code with the place it was looked for (not "ffprobe did not answer")', async () => {
    _setRenderDeps({ probe: async () => null, filters: async () => true, ffprobeMissing: async () => true })
    const r = await renderTimeline(project, 'i1', 'Klip', doc())
    expect(r).toEqual({ ok: false, code: 'render_no_ffprobe', detail: ffprobeBeside('/opt/video/bin/ffmpeg') })
    expect(ffprobeBeside('/opt/video/bin/ffmpeg')).toBe(join('/opt/video/bin', 'ffprobe'))
    expect(ffprobeBeside('C:\\ffmpeg\\bin\\ffmpeg.exe'.replace(/\\/g, '/'))).toMatch(/ffprobe\.exe$/)
    // adding a clip without an end (its length is measured) says the same
    const f = await fillClipEnds(project, [{ op: 'addClip', src: 'Projektek/Klip/a.mp4', start: 0 }])
    expect(f).toMatchObject({ ok: false, code: 'render_no_ffprobe' })
  })

  it('ffprobe there but one file unreadable: still the per-file code with the file', async () => {
    _setRenderDeps({ probe: async () => null, filters: async () => true, ffprobeMissing: async () => false })
    const r = await renderTimeline(project, 'i2', 'Klip', doc())
    expect(r).toEqual({ ok: false, code: 'render_probe_failed', detail: 'Projektek/Klip/a.mp4' })
  })
})

describe.skipIf(isWin)('#789 the capability check measures ffmpeg together with ffprobe', () => {
  let bin = ''
  beforeEach(() => {
    initDatabase(':memory:')
    bin = mkdtempSync(join(tmpdir(), 'wb-ffbin-'))
    const sh = (name: string, line: string): void => { const p = join(bin, name); writeFileSync(p, `#!/bin/sh\necho "${line}"\n`); chmodSync(p, 0o755) }
    sh('ffmpeg', 'ffmpeg version 9.9-test')
    process.env['MARVEEN_FFMPEG'] = join(bin, 'ffmpeg')
  })
  afterEach(() => { delete process.env['MARVEEN_FFMPEG']; rmSync(bin, { recursive: true, force: true }) })

  it('ffmpeg without ffprobe beside it: not "ok", and the detail names ffprobe and where it was looked for', async () => {
    const p = await probeVideoTools({ force: true })
    expect(p.reason).toBe('not_installed')
    expect(p.available).toBe(false)
    expect(p.detail).toContain('ffprobe')
    expect(p.detail).toContain(join(bin, 'ffprobe'))
  })

  it('with ffprobe beside it: ok', async () => {
    const p2 = join(bin, 'ffprobe')
    writeFileSync(p2, '#!/bin/sh\necho "ffprobe version 9.9-test"\n'); chmodSync(p2, 0o755)
    const p = await probeVideoTools({ force: true })
    expect(p.reason).toBe('ok')
    expect(p.path).toBe(join(bin, 'ffmpeg'))
  })
})
