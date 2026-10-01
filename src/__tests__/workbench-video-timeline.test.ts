// v4 spec phase 5 (video): the timeline model, its operations, the render
// arguments, and a real ffmpeg render when ffmpeg is installed.
import { describe, it, expect } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  emptyTimeline, parseTimeline, applyTimelineOps, timelineDuration, clipOffsets, timelineKind, timelineSummary, isMediaPath,
  type TimelineDoc,
} from '../workbench-video-timeline.js'
import { buildRender, buildAss } from '../workbench-video-render.js'

function ok(doc: TimelineDoc, ops: unknown[]): TimelineDoc {
  const r = applyTimelineOps(doc, ops)
  if (!r.ok) throw new Error(`${r.code}: ${r.detail}`)
  return r.doc
}
const base = (): TimelineDoc => ok(emptyTimeline(), [
  { op: 'addClip', src: 'P/a.mp4', start: 1, end: 4 },
  { op: 'addClip', src: 'P/b.mp4', start: 0, end: 2 },
])

describe('timeline: operations', () => {
  it('clips play in order; duration and offsets follow', () => {
    const d = base()
    expect(d.clips.map((c) => c.id)).toEqual(['c1', 'c2'])
    expect(timelineDuration(d)).toBe(5)
    expect(clipOffsets(d)).toEqual([0, 3])
  })

  it('trim, move, split, remove', () => {
    let d = ok(base(), [{ op: 'trimClip', id: 'c1', start: 2, end: 3.5 }])
    expect(d.clips[0]).toMatchObject({ start: 2, end: 3.5 })
    d = ok(d, [{ op: 'moveClip', id: 'c2', to: 1 }])
    expect(d.clips.map((c) => c.id)).toEqual(['c2', 'c1'])
    d = ok(d, [{ op: 'splitClip', id: 'c1', at: 3 }])
    expect(d.clips.map((c) => [c.id, c.start, c.end])).toEqual([['c2', 0, 2], ['c1', 2, 3], ['c3', 3, 3.5]])
    d = ok(d, [{ op: 'removeClip', id: 'c2' }])
    expect(d.clips.map((c) => c.id)).toEqual(['c1', 'c3'])
  })

  it('addClip can insert at a position', () => {
    const d = ok(base(), [{ op: 'addClip', src: 'P/c.mov', start: 0, end: 1, at: 0 }])
    expect(d.clips.map((c) => c.src)).toEqual(['P/c.mov', 'P/a.mp4', 'P/b.mp4'])
  })

  it('all or nothing: one bad operation changes nothing', () => {
    const d = base()
    const r = applyTimelineOps(d, [{ op: 'removeClip', id: 'c1' }, { op: 'trimClip', id: 'zzz', start: 0, end: 1 }])
    expect(r).toMatchObject({ ok: false, code: 'timeline_not_found' })
    expect(d.clips).toHaveLength(2)
  })

  it('refuses bad times, bad media, unknown operations, with a code', () => {
    const d = base()
    expect(applyTimelineOps(d, [{ op: 'trimClip', id: 'c1', start: 3, end: 3.05 }])).toMatchObject({ code: 'timeline_bad_time' })
    expect(applyTimelineOps(d, [{ op: 'splitClip', id: 'c1', at: 1.01 }])).toMatchObject({ code: 'timeline_bad_time' })
    expect(applyTimelineOps(d, [{ op: 'addClip', src: '../x.mp4', start: 0, end: 1 }])).toMatchObject({ code: 'timeline_bad_media' })
    expect(applyTimelineOps(d, [{ op: 'addClip', src: 'P/notes.txt', start: 0, end: 1 }])).toMatchObject({ code: 'timeline_bad_media' })
    expect(applyTimelineOps(d, [{ op: 'explode' }])).toMatchObject({ code: 'timeline_bad_op' })
    expect(applyTimelineOps(d, [])).toMatchObject({ code: 'timeline_bad_op' })
    expect(applyTimelineOps(d, [{ op: 'setAspect', aspect: '4:3' }])).toMatchObject({ code: 'timeline_bad_aspect' })
  })

  it('subtitles stay sorted by time; text is required and limited', () => {
    let d = ok(base(), [
      { op: 'addSubtitle', text: 'second', start: 3, end: 4 },
      { op: 'addSubtitle', text: 'first', start: 0, end: 2 },
    ])
    expect(d.subtitles.map((s) => s.text)).toEqual(['first', 'second'])
    d = ok(d, [{ op: 'updateSubtitle', id: 's1', start: 0, end: 5, text: 'changed' }])
    expect(d.subtitles.find((s) => s.id === 's1')).toMatchObject({ text: 'changed', end: 5 })
    expect(applyTimelineOps(d, [{ op: 'addSubtitle', text: '  ', start: 0, end: 1 }])).toMatchObject({ code: 'timeline_text_required' })
    expect(applyTimelineOps(d, [{ op: 'addSubtitle', text: 'x'.repeat(301), start: 0, end: 1 }])).toMatchObject({ code: 'timeline_text_too_long' })
  })

  it('music, overlays, aspect, volume', () => {
    let d = ok(base(), [
      { op: 'setMusic', src: 'P/m.mp3', volume: 0.3 },
      { op: 'addOverlay', src: 'P/logo.png', start: 0, end: 2, x: 0.7, y: 0.8, width: 0.25 },
      { op: 'setAspect', aspect: '9:16' },
      { op: 'setClipVolume', volume: 0.5 },
    ])
    expect(d.music).toEqual({ src: 'P/m.mp3', volume: 0.3, duck: true })
    expect(d.overlays[0]).toMatchObject({ id: 'o1', x: 0.7, width: 0.25, opacity: 1 })
    expect(d.aspect).toBe('9:16')
    expect(d.clip_volume).toBe(0.5)
    d = ok(d, [{ op: 'updateMusic', duck: false }, { op: 'updateOverlay', id: 'o1', opacity: 0.5 }, { op: 'removeOverlay', id: 'o1' }])
    expect(d.music?.duck).toBe(false)
    expect(d.overlays).toEqual([])
    d = ok(d, [{ op: 'clearMusic' }])
    expect(d.music).toBeNull()
    expect(applyTimelineOps(d, [{ op: 'updateMusic', volume: 0.1 }])).toMatchObject({ code: 'timeline_not_found' })
    expect(applyTimelineOps(d, [{ op: 'setMusic', src: 'P/m.mp3', volume: 3 }])).toMatchObject({ code: 'timeline_bad_value' })
  })

  it('parseTimeline round-trips a document and rejects a broken one', () => {
    const d = ok(base(), [{ op: 'setMusic', src: 'P/m.mp3' }])
    expect(parseTimeline(JSON.parse(JSON.stringify(d)))).toEqual({ ok: true, doc: d })
    expect(parseTimeline({ clips: [{ src: 'P/a.mp4', start: 5, end: 1 }] })).toMatchObject({ ok: false, code: 'timeline_bad_time' })
    expect(parseTimeline(null)).toMatchObject({ ok: false })
    expect(timelineSummary(d)).toContain('2 clips (5s)')
  })

  it('isMediaPath: inside the project only', () => {
    expect(isMediaPath('P/a/b.mp4')).toBe(true)
    for (const bad of ['/abs.mp4', 'a/../b.mp4', 'C:\\x.mp4', 'http://x/y.mp4', 'a//b', '']) expect(isMediaPath(bad)).toBe(false)
  })
})

describe('timeline: undo patches (shared draft store kind)', () => {
  it('a patch replays both ways and refuses a changed document', () => {
    const b = base()
    const a = ok(b, [{ op: 'removeClip', id: 'c1' }])
    const patch = timelineKind.diff(b, a)!
    expect(timelineKind.diff(b, b)).toBeNull()
    const undone = timelineKind.apply(a, patch, 'undo')
    expect(undone).toEqual({ ok: true, doc: b })
    expect(timelineKind.apply(b, patch, 'redo')).toEqual({ ok: true, doc: a })
    expect(timelineKind.apply(ok(a, [{ op: 'setAspect', aspect: '1:1' }]), patch, 'undo')).toMatchObject({ ok: false, code: 'video_undo_conflict' })
  })

  it('removing two clips or changing the format is a big change', () => {
    const b = base()
    expect(timelineKind.isBig(b, ok(b, [{ op: 'removeClip', id: 'c1' }]))).toBe(false)
    expect(timelineKind.isBig(b, ok(b, [{ op: 'removeClip', id: 'c1' }, { op: 'removeClip', id: 'c2' }]))).toBe(true)
    expect(timelineKind.isBig(b, ok(b, [{ op: 'setAspect', aspect: '9:16' }]))).toBe(true)
  })
})

describe('timeline: render arguments', () => {
  const full = (): TimelineDoc => ok(base(), [
    { op: 'addSubtitle', text: 'Hi {x}\nthere', start: 0.5, end: 2 },
    { op: 'setMusic', src: 'P/m.mp3', volume: 0.4 },
    { op: 'addOverlay', src: 'P/logo.png', start: 0, end: 3, x: 0.7, y: 0.8, width: 0.25 },
    { op: 'setAspect', aspect: '9:16' },
  ])
  const inputs = { abs: { 'P/a.mp4': '/m/a.mp4', 'P/b.mp4': '/m/b.mp4', 'P/m.mp3': '/m/m.mp3', 'P/logo.png': '/m/logo.png' }, hasAudio: { 'P/a.mp4': true, 'P/b.mp4': false }, assPath: '/tmp/s.ass', out: '/o/out.mp4' }

  it('cuts every clip, fills 1080x1920 on a blurred copy, adds a silent track for a clip without sound', () => {
    const graph = buildRender(full(), inputs)[buildRender(full(), inputs).indexOf('-filter_complex') + 1]
    expect(graph).toContain('trim=start=1:end=4')
    expect(graph).toContain('scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur')
    expect(graph).toContain('anullsrc=r=48000:cl=stereo,atrim=0:2')
    expect(graph).toContain('concat=n=2:v=1:a=1[vc][ac]')
  })

  it('overlay is timed, subtitles use the ASS file, music is looped, cut and ducked under the clip sound', () => {
    const a = buildRender(full(), inputs)
    const graph = a[a.indexOf('-filter_complex') + 1]
    expect(graph).toContain("overlay=x=756:y=1536:enable='between(t,0,3)'")
    expect(graph).toContain("ass=filename='/tmp/s.ass'")
    expect(graph).toContain('sidechaincompress')
    expect(graph).toContain('volume=0.4')
    expect(a.join(' ')).toContain('-stream_loop -1 -i /m/m.mp3')
    expect(a.slice(-1)).toEqual(['/o/out.mp4'])
    expect(a).toContain('-n')
  })

  it('no music means the clip sound goes straight out; no ducking means a plain mix', () => {
    const plainArgs = buildRender(base(), { abs: inputs.abs, hasAudio: inputs.hasAudio, assPath: null, out: '/o/x.mp4' })
    expect(plainArgs[plainArgs.indexOf('-map') + 3]).toBe('[ac]')
    expect(plainArgs.join(' ')).not.toContain('ass=')
    const noDuck = ok(full(), [{ op: 'updateMusic', duck: false }])
    const g = buildRender(noDuck, inputs)
    expect(g[g.indexOf('-filter_complex') + 1]).toContain('[ac][mus]amix=inputs=2:duration=first:normalize=0[am]')
    expect(g[g.indexOf('-filter_complex') + 1]).not.toContain('sidechaincompress')
  })

  it('the ASS file: sized to the format, times in h:mm:ss.cc, line break kept, braces removed', () => {
    const ass = buildAss(full())
    expect(ass).toContain('PlayResX: 1080')
    expect(ass).toContain('PlayResY: 1920')
    expect(ass).toContain('Dialogue: 0,0:00:00.50,0:00:02.00,Default,,0,0,0,,Hi x\\Nthere')
  })
})

const HAVE_FFMPEG = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0

describe.skipIf(!HAVE_FFMPEG)('timeline: a real render (needs ffmpeg)', () => {
  it('produces a 1080x1920 mp4 with sound, as long as the clips together', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wbtl'))
    try {
      const ff = (args: string[]) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'pipe' })
      ff(['-f', 'lavfi', '-i', 'testsrc=duration=4:size=640x360:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-c:v', 'libx264', '-c:a', 'aac', '-shortest', join(dir, 'a.mp4')])
      ff(['-f', 'lavfi', '-i', 'color=c=red:s=320x240:d=3:r=25', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(dir, 'silent.mp4')])
      ff(['-f', 'lavfi', '-i', 'sine=frequency=220:duration=2', join(dir, 'm.mp3')])
      ff(['-f', 'lavfi', '-i', 'color=c=blue:s=200x100:d=1', '-frames:v', '1', join(dir, 'logo.png')])
      const d = ok(emptyTimeline(), [
        { op: 'addClip', src: 'P/a.mp4', start: 1, end: 3 },
        { op: 'addClip', src: 'P/silent.mp4', start: 0, end: 1.5 },
        { op: 'addSubtitle', text: 'Hello', start: 0.2, end: 2 },
        { op: 'setMusic', src: 'P/m.mp3', volume: 0.4 },
        { op: 'addOverlay', src: 'P/logo.png', start: 0, end: 3, width: 0.25 },
        { op: 'setAspect', aspect: '9:16' },
      ])
      const ass = join(dir, 's.ass')
      writeFileSync(ass, buildAss(d))
      const out = join(dir, 'out.mp4')
      const abs = { 'P/a.mp4': join(dir, 'a.mp4'), 'P/silent.mp4': join(dir, 'silent.mp4'), 'P/m.mp3': join(dir, 'm.mp3'), 'P/logo.png': join(dir, 'logo.png') }
      execFileSync('ffmpeg', buildRender(d, { abs, hasAudio: { 'P/a.mp4': true, 'P/silent.mp4': false }, assPath: ass, out }), { stdio: 'pipe' })
      expect(existsSync(out)).toBe(true)
      const info = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,width,height:format=duration', '-of', 'json', out]).toString())
      const v = info.streams.find((x: any) => x.codec_type === 'video')
      expect([v.width, v.height]).toEqual([1080, 1920])
      expect(info.streams.some((x: any) => x.codec_type === 'audio')).toBe(true)
      expect(Number(info.format.duration)).toBeCloseTo(3.5, 0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
