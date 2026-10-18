// #669 phase B: colour looks per clip (model, validation, render graph, a real ffmpeg render of every look).
import { describe, it, expect } from 'vitest'
import { spawnSync, execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emptyTimeline, parseTimeline, applyTimelineOps, CLIP_LOOKS, type TimelineDoc } from '../workbench-video-timeline.js'
import { buildRender, lookFilter, LOOK_FILTERS } from '../workbench-video-render.js'

function ok(doc: TimelineDoc, ops: unknown[]): TimelineDoc {
  const r = applyTimelineOps(doc, ops)
  if (!r.ok) throw new Error(`${r.code}: ${r.detail}`)
  return r.doc
}
const one = (): TimelineDoc => ok(emptyTimeline(), [{ op: 'addClip', src: 'P/a.mp4', start: 0, end: 4 }])

describe('clip looks: model', () => {
  it('setClipLook stores a look, none clears it, a bad one is refused', () => {
    let d = ok(one(), [{ op: 'setClipLook', id: 'c1', look: 'bw' }])
    expect(d.clips[0].look).toBe('bw')
    d = ok(d, [{ op: 'setClipLook', id: 'c1', look: 'none' }])
    expect(d.clips[0].look).toBeUndefined()
    const bad = applyTimelineOps(one(), [{ op: 'setClipLook', id: 'c1', look: 'neon' }])
    expect(bad.ok ? 'ok' : bad.code).toBe('timeline_bad_style')
    const nf = applyTimelineOps(one(), [{ op: 'setClipLook', id: 'zz', look: 'bw' }])
    expect(nf.ok ? 'ok' : nf.code).toBe('timeline_not_found')
  })
  it('split keeps the look on both halves; save/parse round-trips it', () => {
    let d = ok(one(), [{ op: 'setClipLook', id: 'c1', look: 'warm' }, { op: 'splitClip', id: 'c1', at: 2 }])
    expect(d.clips.map((c) => c.look)).toEqual(['warm', 'warm'])
    const p = parseTimeline(JSON.parse(JSON.stringify(d)))
    expect(p.ok && p.doc.clips[1].look).toBe('warm')
  })
  it('a failing op changes nothing (all or nothing)', () => {
    const r = applyTimelineOps(one(), [{ op: 'setClipLook', id: 'c1', look: 'bw' }, { op: 'setClipLook', id: 'c1', look: 'nope' }])
    expect(r.ok).toBe(false)
  })
})

describe('clip looks: render graph', () => {
  it('every look except none has a filter, and the graph carries it before the blurred-copy split', () => {
    expect(CLIP_LOOKS.filter((l) => l !== 'none').every((l) => LOOK_FILTERS[l])).toBe(true)
    expect(lookFilter(undefined)).toBe('')
    const d = ok(one(), [{ op: 'setClipLook', id: 'c1', look: 'bw' }])
    const args = buildRender(d, { abs: { 'P/a.mp4': '/x/a.mp4' }, hasAudio: { 'P/a.mp4': false }, assPath: null, out: '/x/o.mp4' })
    const fc = args[args.indexOf('-filter_complex') + 1]
    expect(fc).toContain('hue=s=0,split=2[bg0][fg0]')
    const plain = buildRender(one(), { abs: { 'P/a.mp4': '/x/a.mp4' }, hasAudio: { 'P/a.mp4': false }, assPath: null, out: '/x/o.mp4' })
    expect(plain[plain.indexOf('-filter_complex') + 1]).not.toContain('hue=s=0')
  })
})

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0
describe.skipIf(!hasFfmpeg)('clip looks: real ffmpeg', () => {
  it('every look renders; black and white really is grey, the original stays red', () => {
    const dir = mkdtempSync(join(tmpdir(), 'looks-'))
    try {
      execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=red:s=320x180:r=30', '-f', 'lavfi', '-i', 'sine=f=440', '-t', '2', '-pix_fmt', 'yuv420p', join(dir, 'a.mp4')])
      const px = (out: string) => {
        const raw = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', '0.5', '-i', out, '-frames:v', '1', '-vf', 'scale=1:1,format=rgb24', '-f', 'rawvideo', '-'])
        return [raw[0], raw[1], raw[2]]
      }
      const render = (look: string) => {
        const d = ok(one(), [{ op: 'trimClip', id: 'c1', start: 0, end: 2 }, { op: 'setClipLook', id: 'c1', look }])
        const out = join(dir, `${look}.mp4`)
        execFileSync('ffmpeg', buildRender(d, { abs: { 'P/a.mp4': join(dir, 'a.mp4') }, hasAudio: { 'P/a.mp4': true }, assPath: null, out }))
        return px(out)
      }
      for (const look of CLIP_LOOKS) {
        const [r, g, b] = render(look)
        if (look === 'bw') expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThan(12)
        if (look === 'none') { expect(r).toBeGreaterThan(150); expect(g).toBeLessThan(60); expect(b).toBeLessThan(60) }
      }
      expect(readFileSync(join(dir, 'vintage.mp4')).length).toBeGreaterThan(1000)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }, 120000)
})
