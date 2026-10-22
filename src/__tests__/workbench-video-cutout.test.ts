// #669 phase C: background removal for a timeline clip: the replaceClipSource op, the input checks, the progress lines, the job store.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { applyTimelineOps, emptyTimeline, type TimelineDoc } from '../workbench-video-timeline.js'
import { cutoutProgress, cutoutClip, CUTOUT_MAX_SECONDS } from '../workbench-video-cutout.js'
import { createJobStore } from '../workbench-video-jobs.js'
import { _setVideoDeps } from '../workbench-video.js'
import type { ProjectRow } from '../projects.js'

const state = vi.hoisted(() => ({ installed: true }))
vi.mock('../web/routes/voice.js', async (orig) => ({
  ...(await orig<typeof import('../web/routes/voice.js')>()),
  isCutoutInstalled: () => state.installed,
}))

function ok(d: TimelineDoc, ops: unknown[]): TimelineDoc {
  const r = applyTimelineOps(d, ops)
  if (!r.ok) throw new Error(`${r.code}: ${r.detail}`)
  return r.doc
}
const doc = (end = 4): TimelineDoc => ok(emptyTimeline(), [{ op: 'addClip', src: 'P/a.mp4', start: 1, end: 1 + end }])

describe('replaceClipSource', () => {
  it('points the clip at the processed file, from 0 to its length, keeping the id', () => {
    const d = ok(doc(), [{ op: 'replaceClipSource', id: 'c1', src: 'P/a (hatter nelkul).mp4', end: 4 }])
    expect(d.clips[0]).toMatchObject({ id: 'c1', src: 'P/a (hatter nelkul).mp4', start: 0, end: 4 })
  })
  it('refuses a non-video file, a missing clip and a bad length', () => {
    const code = (op: Record<string, unknown>): string => { const r = applyTimelineOps(doc(), [op]); return r.ok ? 'ok' : r.code }
    expect(code({ op: 'replaceClipSource', id: 'c1', src: 'P/x.wav', end: 4 })).toBe('timeline_bad_media')
    expect(code({ op: 'replaceClipSource', id: 'c9', src: 'P/x.mp4', end: 4 })).toBe('timeline_not_found')
    expect(code({ op: 'replaceClipSource', id: 'c1', src: 'P/x.mp4', end: 0 })).not.toBe('ok')
  })
})

describe('cutoutProgress', () => {
  it('takes the last progress line of a chunk and ignores other text', () => {
    expect(cutoutProgress('progress=0.1000\nprogress=0.2500\n')).toBe(0.25)
    expect(cutoutProgress('some warning\n')).toBeNull()
  })
})

describe('cutoutClip: input checks before anything is made', () => {
  const project = { id: 'p', folder_path: 'P' } as unknown as ProjectRow
  const item = { id: 'i1', folder: null, container_folder: null, source_path: null }
  beforeEach(() => { state.installed = true; _setVideoDeps() })
  it('names a bad mode, a bad colour and an unknown clip', async () => {
    expect(await cutoutClip(project, item, doc(), { clipId: 'c1', mode: 'alpha' })).toMatchObject({ ok: false, code: 'cutout_bad_mode' })
    expect(await cutoutClip(project, item, doc(), { clipId: 'c1', color: 'zöld' })).toMatchObject({ ok: false, code: 'cutout_bad_color' })
    expect(await cutoutClip(project, item, doc(), { clipId: 'c9' })).toMatchObject({ ok: false, code: 'cutout_clip_missing' })
  })
  it('refuses a clip longer than the limit', async () => {
    expect(await cutoutClip(project, item, doc(CUTOUT_MAX_SECONDS + 1), { clipId: 'c1' })).toMatchObject({ ok: false, code: 'cutout_too_long' })
  })
  it('says so when the tool is not installed', async () => {
    state.installed = false
    expect(await cutoutClip(project, item, doc(), { clipId: 'c1' })).toMatchObject({ ok: false, code: 'cutout_not_installed' })
  })
  it('without ffmpeg it names that, and a source outside the project is refused', async () => {
    _setVideoDeps({ tool: async () => ({ state: 'missing', path: null, detail: null }) })
    expect(await cutoutClip(project, item, doc(), { clipId: 'c1' })).toMatchObject({ ok: false, code: 'cutout_no_ffmpeg' })
    _setVideoDeps({ tool: async () => ({ state: 'ok', path: '/usr/bin/ffmpeg', detail: null }) })
    const other = ok(emptyTimeline(), [{ op: 'addClip', src: 'Q/a.mp4', start: 0, end: 2 }])
    expect(await cutoutClip(project, item, other, { clipId: 'c1' })).toMatchObject({ ok: false, code: 'render_source_outside' })
  })
})

describe('job store', () => {
  it('runs one job per item, reports progress, keeps the result, and a second store is independent', async () => {
    const a = createJobStore()
    const b = createJobStore()
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const job = a.start('i1', async (p) => { p(0.4); await gate; return { n: 1 } })!
    expect(job.state).toBe('running')
    expect(a.start('i1', async () => 1)).toBeNull()
    expect(b.get('i1')).toBeNull()
    expect(b.start('i1', async () => 2)).not.toBeNull()
    release()
    await new Promise((r) => setTimeout(r, 10))
    expect(a.get('i1')).toMatchObject({ state: 'done', progress: 1, result: { n: 1 } })
  })
  it('a thrown failure becomes the job error', async () => {
    const s = createJobStore()
    s.start('i2', async () => { throw { status: 409, code: 'video_busy', detail: null } })
    await new Promise((r) => setTimeout(r, 10))
    expect(s.get('i2')).toMatchObject({ state: 'error', error: { status: 409, code: 'video_busy' } })
  })
})
