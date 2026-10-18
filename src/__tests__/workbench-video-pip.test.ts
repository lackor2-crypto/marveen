// #669 phase B: a video as an overlay (picture-in-picture): model, render graph, a real ffmpeg render.
import { describe, it, expect } from 'vitest'
import { spawnSync, execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emptyTimeline, applyTimelineOps, type TimelineDoc } from '../workbench-video-timeline.js'
import { buildRender } from '../workbench-video-render.js'

function ok(doc: TimelineDoc, ops: unknown[]): TimelineDoc {
  const r = applyTimelineOps(doc, ops)
  if (!r.ok) throw new Error(`${r.code}: ${r.detail}`)
  return r.doc
}
const doc = (): TimelineDoc => ok(emptyTimeline(), [
  { op: 'addClip', src: 'P/a.mp4', start: 0, end: 4 },
  { op: 'addOverlay', src: 'P/pip.mp4', start: 1, end: 3, x: 0, y: 0, width: 0.5 },
])

describe('video overlay: model', () => {
  it('accepts a video and a picture, refuses other files', () => {
    expect(doc().overlays[0].src).toBe('P/pip.mp4')
    const bad = applyTimelineOps(emptyTimeline(), [{ op: 'addOverlay', src: 'P/x.txt', start: 0, end: 1 }])
    expect(bad.ok ? 'ok' : bad.code).toBe('timeline_bad_media')
  })
})

describe('video overlay: render graph', () => {
  it('a video overlay is read without loop, shifted to its start, and does not cut the base', () => {
    const inp = { abs: { 'P/a.mp4': '/x/a.mp4', 'P/pip.mp4': '/x/pip.mp4' }, hasAudio: { 'P/a.mp4': false }, assPath: null, out: '/x/o.mp4' }
    const a = buildRender(doc(), inp)
    const fc = a[a.indexOf('-filter_complex') + 1]
    expect(fc).toContain('setpts=PTS-STARTPTS+1/TB')
    expect(fc).toContain('eof_action=pass')
    expect(fc).not.toContain('shortest=1')
    expect(a.join(' ')).not.toContain('-loop 1 -framerate 30 -t 4 -i /x/pip.mp4')
  })
})

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0
describe.skipIf(!hasFfmpeg)('video overlay: real ffmpeg', () => {
  it('the small blue video shows only between 1 and 3 s, in the corner; the output keeps the base length', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pip-'))
    try {
      const q = ['-hide_banner', '-loglevel', 'error', '-y']
      execFileSync('ffmpeg', [...q, '-f', 'lavfi', '-i', 'color=red:s=320x180:r=30', '-t', '4', '-pix_fmt', 'yuv420p', join(dir, 'a.mp4')])
      execFileSync('ffmpeg', [...q, '-f', 'lavfi', '-i', 'color=blue:s=160x90:r=30', '-t', '1.5', '-pix_fmt', 'yuv420p', join(dir, 'pip.mp4')])
      const out = join(dir, 'o.mp4')
      execFileSync('ffmpeg', buildRender(doc(), { abs: { 'P/a.mp4': join(dir, 'a.mp4'), 'P/pip.mp4': join(dir, 'pip.mp4') }, hasAudio: { 'P/a.mp4': false }, assPath: null, out }))
      const px = (t: number, at: string) => {
        const raw = execFileSync('ffmpeg', [...q.slice(0, 3), '-ss', String(t), '-i', out, '-frames:v', '1', '-vf', `crop=4:4:${at},scale=1:1,format=rgb24`, '-f', 'rawvideo', '-'])
        return [raw[0], raw[1], raw[2]]
      }
      const dur = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out]).toString())
      expect(dur).toBeGreaterThan(3.8)
      expect(px(0.5, '100:100')[0]).toBeGreaterThan(150)            // before: red
      const mid = px(1.5, '100:100'); expect(mid[2]).toBeGreaterThan(150); expect(mid[0]).toBeLessThan(80) // during: blue corner
      expect(px(1.5, '1700:900')[0]).toBeGreaterThan(150)           // far corner still red
      expect(px(3.5, '100:100')[0]).toBeGreaterThan(150)            // after the window: red again
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }, 120000)
})
