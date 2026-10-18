// #669: what fills the frame when a clip does not match the output shape (doc.background):
// a blurred copy (default, stored timelines unchanged), black bars, or the picture cropped to fill.
import { describe, it, expect } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emptyTimeline, parseTimeline, applyTimelineOps, TIMELINE_BACKGROUNDS, type TimelineDoc } from '../workbench-video-timeline.js'
import { buildRender, buildAss } from '../workbench-video-render.js'

function ok(doc: TimelineDoc, ops: unknown[]): TimelineDoc {
  const r = applyTimelineOps(doc, ops)
  if (!r.ok) throw new Error(`${r.code}: ${r.detail}`)
  return r.doc
}
const base = (bg?: string): TimelineDoc => ok(emptyTimeline(), [
  { op: 'addClip', src: 'P/a.mp4', start: 0, end: 1 },
  { op: 'setAspect', aspect: '9:16' },
  ...(bg ? [{ op: 'setBackground', background: bg }] : []),
])
const graphOf = (d: TimelineDoc): string => {
  const a = buildRender(d, { abs: { 'P/a.mp4': '/m/a.mp4' }, hasAudio: { 'P/a.mp4': true }, assPath: '/tmp/s.ass', out: '/o/out.mp4' })
  return a[a.indexOf('-filter_complex') + 1]
}

describe('#669 setBackground: the model', () => {
  it('the default is blur and is NOT stored, so older timelines stay byte for byte the same', () => {
    expect(emptyTimeline()).not.toHaveProperty('background')
    expect(base()).not.toHaveProperty('background')
    expect(base('blur')).not.toHaveProperty('background')
    expect(TIMELINE_BACKGROUNDS).toEqual(['blur', 'letterbox', 'crop'])
  })
  it('letterbox and crop are stored; going back to blur clears the field', () => {
    expect(base('letterbox').background).toBe('letterbox')
    expect(base('crop').background).toBe('crop')
    expect(ok(base('crop'), [{ op: 'setBackground', background: 'blur' }])).not.toHaveProperty('background')
  })
  it('a bad value is refused and changes nothing', () => {
    expect(applyTimelineOps(base('crop'), [{ op: 'setBackground', background: 'rainbow' }])).toMatchObject({ ok: false, code: 'timeline_bad_value' })
    expect(parseTimeline({ background: 'rainbow' })).toMatchObject({ ok: false, code: 'timeline_bad_value' })
  })
  it('a stored timeline round-trips through parse', () => {
    const p = parseTimeline(JSON.parse(JSON.stringify(base('letterbox'))))
    expect(p.ok && p.doc.background).toBe('letterbox')
  })
})

describe('#669 setBackground: the render arguments', () => {
  it('blur keeps the old graph (blurred copy under the picture)', () => {
    const g = graphOf(base())
    expect(g).toContain('boxblur=24:3')
    expect(g).toContain('overlay=(W-w)/2:(H-h)/2,setsar=1,format=yuv420p')
  })
  it('letterbox pads with black, no blur', () => {
    const g = graphOf(base('letterbox'))
    expect(g).toContain('pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black')
    expect(g).not.toContain('boxblur')
  })
  it('crop enlarges until the frame is full and cuts the rest, no blur', () => {
    const g = graphOf(base('crop'))
    expect(g).toContain('[fg0]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920')
    expect(g).not.toContain('boxblur')
  })
})

const HAVE_FFMPEG = spawnSync('ffmpeg', ['-version']).status === 0
describe.skipIf(!HAVE_FFMPEG)('#669 setBackground: a real render (needs ffmpeg)', () => {
  it('the three modes really look different in a 16:9 clip on a 9:16 frame', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wbbg'))
    try {
      // green picture with a red box in the left part: only the full picture (blur / letterbox) shows it, the crop does not
      execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=green:s=320x180:d=1:r=25', '-vf', 'drawbox=x=40:y=0:w=40:h=180:color=red:t=fill', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(dir, 'a.mp4')], { stdio: 'pipe' })
      const px = (mode: string, x: number, y: number): [number, number, number] => {
        const d = base(mode === 'blur' ? undefined : mode)
        const ass = join(dir, 's.ass'); writeFileSync(ass, buildAss(d))
        const out = join(dir, `${mode}.mp4`)
        execFileSync('ffmpeg', buildRender(d, { abs: { 'P/a.mp4': join(dir, 'a.mp4') }, hasAudio: { 'P/a.mp4': false }, assPath: ass, out }), { stdio: 'pipe' })
        const raw = join(dir, `${mode}.rgb`)
        execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', out, '-frames:v', '1', '-vf', `format=rgb24,crop=1:1:${x}:${y}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', raw], { stdio: 'pipe' })
        const b = readFileSync(raw); return [b[0], b[1], b[2]]
      }
      const dark = (c: number[]) => c[0] < 40 && c[1] < 40 && c[2] < 40
      const red = (c: number[]) => c[0] > 150 && c[1] < 100
      const green = (c: number[]) => c[1] > 100 && c[0] < 100
      // the picture itself (middle of the frame, over the red box: output x 135..270)
      expect(red(px('blur', 200, 960))).toBe(true)
      expect(red(px('letterbox', 200, 960))).toBe(true)
      expect(green(px('crop', 200, 960))).toBe(true)
      // above the picture
      expect(dark(px('letterbox', 200, 100))).toBe(true)
      expect(dark(px('blur', 200, 100))).toBe(false)
      expect(dark(px('crop', 200, 100))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 120000)
})
