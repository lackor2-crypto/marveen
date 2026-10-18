// #669: a cut may never run past the real (ffprobe) end of its file: the browser mis-measures a variable-frame-rate
// phone video and a dragged edge can overshoot. The server pulls it back.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase } from '../db.js'
import { createProject, updateProject, getProject, type ProjectRow } from '../projects.js'
import { _setVideoDeps } from '../workbench-video.js'
import { clampClipLengths, _setRenderDeps } from '../workbench-video-render.js'
import { applyTimelineOps, emptyTimeline } from '../workbench-video-timeline.js'

let dir = ''
let project: ProjectRow

beforeEach(() => {
  initDatabase(':memory:')
  dir = mkdtempSync(join(tmpdir(), 'wb-clamp-'))
  process.env['MARVEEN_DEPOT'] = dir
  const p = createProject({ name: 'Klip' })
  if (!p.ok) throw new Error('projekt')
  updateProject(p.project.id, { folder_path: 'Projektek/Klip' })
  mkdirSync(join(dir, 'Projektek', 'Klip'), { recursive: true })
  writeFileSync(join(dir, 'Projektek', 'Klip', '153.MP4'), 'x')
  writeFileSync(join(dir, 'Projektek', 'Klip', 'b.MP4'), 'xx')
  project = getProject(p.project.id) as ProjectRow
  _setVideoDeps({ tool: async () => ({ state: 'ok', path: '/fake/ffmpeg', detail: null }) })
  _setRenderDeps({ probe: async (_f, abs) => ({ audio: true, duration: abs.endsWith('153.MP4') ? 9.387 : 29.094 }), filters: async () => true })
})
afterEach(() => { _setVideoDeps(); _setRenderDeps(); rmSync(dir, { recursive: true, force: true }); delete process.env['MARVEEN_DEPOT'] })

const doc = (clips: { src: string; start: number; end: number }[]) => {
  const r = applyTimelineOps(emptyTimeline(), clips.map((c) => ({ op: 'addClip', ...c })))
  if (!r.ok) throw new Error(r.detail)
  return r.doc
}

describe('clampClipLengths', () => {
  it('pulls a cut that ends past the real length back to it, leaves correct clips alone', async () => {
    const d = doc([{ src: 'Projektek/Klip/153.MP4', start: 0, end: 11.5 }, { src: 'Projektek/Klip/b.MP4', start: 1, end: 29.094 }])
    const r = await clampClipLengths(project, d)
    expect(r.changed).toBe(1)
    expect(r.doc.clips[0]).toMatchObject({ start: 0, end: 9.387 })
    expect(r.doc.clips[1]).toMatchObject({ start: 1, end: 29.094 })
    expect(d.clips[0]!.end).toBe(11.5) // the input is not mutated
  })

  it('keeps a minimal piece when the whole cut lay past the end', async () => {
    const r = await clampClipLengths(project, doc([{ src: 'Projektek/Klip/153.MP4', start: 10, end: 11.5 }]))
    expect(r.doc.clips[0]!.end).toBe(9.387)
    expect(r.doc.clips[0]!.start).toBeLessThan(9.387)
    expect(9.387 - r.doc.clips[0]!.start).toBeGreaterThanOrEqual(0.099)
  })

  it('does nothing when the file cannot be measured', async () => {
    _setRenderDeps({ probe: async () => null, filters: async () => true })
    const d = doc([{ src: 'Projektek/Klip/153.MP4', start: 0, end: 11.5 }])
    const r = await clampClipLengths(project, d)
    expect(r.changed).toBe(0)
    expect(r.doc).toBe(d)
  })
})
