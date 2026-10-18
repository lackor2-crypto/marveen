// #669 phase B: per-clip zoom/pan, rotate/flip and fade in/out (model, validation, render graph, real ffmpeg pixel checks).
import { describe, it, expect } from 'vitest'
import { spawnSync, execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emptyTimeline, parseTimeline, applyTimelineOps, type TimelineDoc } from '../workbench-video-timeline.js'
import { buildRender, frameFilter, fadeFilter } from '../workbench-video-render.js'

function ok(doc: TimelineDoc, ops: unknown[]): TimelineDoc {
  const r = applyTimelineOps(doc, ops)
  if (!r.ok) throw new Error(`${r.code}: ${r.detail}`)
  return r.doc
}
const code = (doc: TimelineDoc, ops: unknown[]): string => { const r = applyTimelineOps(doc, ops); return r.ok ? 'ok' : r.code }
const one = (): TimelineDoc => ok(emptyTimeline(), [{ op: 'addClip', src: 'P/a.mp4', start: 0, end: 4 }])

describe('frame/fade: model', () => {
  it('setClipFrame stores zoom/pan, a reset clears them, out-of-range is refused', () => {
    let d = ok(one(), [{ op: 'setClipFrame', id: 'c1', zoom: 2, panX: -0.5 }])
    expect(d.clips[0]).toMatchObject({ zoom: 2, panX: -0.5 })
    expect(d.clips[0].panY).toBeUndefined()
    d = ok(d, [{ op: 'setClipFrame', id: 'c1' }])
    expect(d.clips[0].zoom).toBeUndefined()
    expect(d.clips[0].panX).toBeUndefined()
    expect(code(one(), [{ op: 'setClipFrame', id: 'c1', zoom: 9 }])).toBe('timeline_bad_value')
    expect(code(one(), [{ op: 'setClipFrame', id: 'c1', zoom: 2, panY: 3 }])).toBe('timeline_bad_value')
  })
  it('setClipOrient and setClipFade store and clear; bad values are refused', () => {
    let d = ok(one(), [{ op: 'setClipOrient', id: 'c1', rotate: 90, flip: 'h' }, { op: 'setClipFade', id: 'c1', in: 1, out: 0.5 }])
    expect(d.clips[0]).toMatchObject({ rot: 90, flip: 'h', fadeIn: 1, fadeOut: 0.5 })
    d = ok(d, [{ op: 'setClipOrient', id: 'c1', rotate: 0, flip: 'none' }, { op: 'setClipFade', id: 'c1' }])
    expect(d.clips[0]).toEqual({ id: 'c1', src: 'P/a.mp4', start: 0, end: 4 })
    expect(code(one(), [{ op: 'setClipOrient', id: 'c1', rotate: 45 }])).toBe('timeline_bad_value')
    expect(code(one(), [{ op: 'setClipOrient', id: 'c1', flip: 'x' }])).toBe('timeline_bad_value')
    expect(code(one(), [{ op: 'setClipFade', id: 'c1', in: 9 }])).toBe('timeline_bad_value')
    expect(code(one(), [{ op: 'setClipFade', id: 'zz', in: 1 }])).toBe('timeline_not_found')
  })
  it('split: framing on both halves, fade-in on the first only, fade-out on the second only; save/parse round-trips', () => {
    const d = ok(one(), [{ op: 'setClipFrame', id: 'c1', zoom: 2 }, { op: 'setClipOrient', id: 'c1', rotate: 180 }, { op: 'setClipFade', id: 'c1', in: 1, out: 1 }, { op: 'splitClip', id: 'c1', at: 2 }])
    expect(d.clips.map((c) => [c.zoom, c.rot, c.fadeIn, c.fadeOut])).toEqual([[2, 180, 1, undefined], [2, 180, undefined, 1]])
    const p = parseTimeline(JSON.parse(JSON.stringify(d)))
    expect(p.ok && p.doc.clips[1]).toMatchObject({ zoom: 2, rot: 180, fadeOut: 1 })
    expect(parseTimeline({ ...d, clips: [{ ...d.clips[0], zoom: 99 }] }).ok).toBe(false)
  })
})

describe('frame/fade: render graph', () => {
  it('filters are only added when set, and a fade never exceeds half the clip', () => {
    expect(frameFilter({})).toBe('')
    expect(frameFilter({ rot: 90, flip: 'h' })).toBe(',transpose=1,hflip')
    expect(frameFilter({ zoom: 2, panX: 1 })).toContain('crop=w=trunc(iw/2/2)*2')
    expect(fadeFilter({}, 4, 'v')).toBe('')
    expect(fadeFilter({ fadeIn: 3, fadeOut: 3 }, 2, 'a')).toBe(',afade=t=in:st=0:d=1,afade=t=out:st=1:d=1')
    const inp = { abs: { 'P/a.mp4': '/x/a.mp4' }, hasAudio: { 'P/a.mp4': true }, assPath: null, out: '/x/o.mp4' }
    const a = buildRender(ok(one(), [{ op: 'setClipFade', id: 'c1', in: 1 }]), inp)
    expect(a[a.indexOf('-filter_complex') + 1]).toContain('fade=t=in:st=0:d=1')
    const b = buildRender(one(), inp)
    expect(b[b.indexOf('-filter_complex') + 1]).not.toMatch(/fade=|transpose|hflip|crop=w=/)
  })
})

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0
/** The RGB value of one pixel of frame `n` of a video, measured with ffmpeg itself. */
function pixel(file: string, n: number, x: number, y: number): [number, number, number] {
  const out = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file, '-vf', `select=eq(n\\,${n}),format=rgb24,crop=1:1:${x}:${y}`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'])
  return [out[0], out[1], out[2]]
}
describe.skipIf(!hasFfmpeg)('frame/fade: real ffmpeg', () => {
  it('flip, zoom, rotate and fade change the real pixels', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ff-'))
    try {
      const src = join(dir, 'a.mp4')
      // Left half red, right half blue, 16:9.
      execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=320x360:r=30', '-f', 'lavfi', '-i', 'color=c=blue:s=320x360:r=30', '-filter_complex', 'hstack', '-t', '2', '-pix_fmt', 'yuv420p', src])
      const render = (name: string, ops: unknown[]): string => {
        const d = ok(one(), [{ op: 'trimClip', id: 'c1', start: 0, end: 2 }, ...ops])
        const out = join(dir, `${name}.mp4`)
        execFileSync('ffmpeg', buildRender(d, { abs: { 'P/a.mp4': src }, hasAudio: { 'P/a.mp4': false }, assPath: null, out }))
        return out
      }
      const isRed = (p: number[]) => p[0] > 150 && p[2] < 100
      const isBlue = (p: number[]) => p[2] > 150 && p[0] < 100
      const plain = render('plain', [])
      expect(isRed(pixel(plain, 10, 300, 540))).toBe(true)
      expect(isBlue(pixel(plain, 10, 1620, 540))).toBe(true)
      const flipped = render('flip', [{ op: 'setClipOrient', id: 'c1', flip: 'h' }])
      expect(isBlue(pixel(flipped, 10, 300, 540))).toBe(true)
      expect(isRed(pixel(flipped, 10, 1620, 540))).toBe(true)
      // Zoom 4 panned fully left shows only red, even where the plain picture is blue.
      const zoomed = render('zoom', [{ op: 'setClipFrame', id: 'c1', zoom: 4, panX: -1 }])
      expect(isRed(pixel(zoomed, 10, 1620, 540))).toBe(true)
      // Rotated 90 degrees clockwise: the left (red) half ends up on top, the right (blue) half at the bottom.
      const rotated = render('rot', [{ op: 'setClipOrient', id: 'c1', rotate: 90 }])
      expect(isRed(pixel(rotated, 10, 960, 270))).toBe(true)
      expect(isBlue(pixel(rotated, 10, 960, 810))).toBe(true)
      // Fade: first frame dark, a mid frame bright; last frame dark with a fade-out.
      const faded = render('fade', [{ op: 'setClipFade', id: 'c1', in: 1, out: 1 }])
      const first = pixel(faded, 0, 300, 540)
      const mid = pixel(faded, 30, 300, 540)
      const last = pixel(faded, 59, 300, 540)
      expect(first[0]).toBeLessThan(40)
      expect(mid[0]).toBeGreaterThan(150)
      expect(last[0]).toBeLessThan(40)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }, 180000)
})
