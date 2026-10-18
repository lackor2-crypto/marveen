// #669 phase B: per-clip stabilisation (model, validation, render graph, a real ffmpeg render of a shaky clip).
import { describe, it, expect } from 'vitest'
import { spawnSync, execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emptyTimeline, parseTimeline, applyTimelineOps, type TimelineDoc } from '../workbench-video-timeline.js'
import { buildRender } from '../workbench-video-render.js'

function ok(doc: TimelineDoc, ops: unknown[]): TimelineDoc {
  const r = applyTimelineOps(doc, ops)
  if (!r.ok) throw new Error(`${r.code}: ${r.detail}`)
  return r.doc
}
const one = (): TimelineDoc => ok(emptyTimeline(), [{ op: 'addClip', src: 'P/a.mp4', start: 0, end: 4 }])

describe('stabilise: model', () => {
  it('setStabilize turns it on and off; a non-boolean or unknown clip is refused', () => {
    let d = ok(one(), [{ op: 'setStabilize', id: 'c1', on: true }])
    expect(d.clips[0].stab).toBe(true)
    d = ok(d, [{ op: 'setStabilize', id: 'c1', on: false }])
    expect(d.clips[0].stab).toBeUndefined()
    const bad = applyTimelineOps(one(), [{ op: 'setStabilize', id: 'c1', on: 'yes' }])
    expect(bad.ok ? 'ok' : bad.code).toBe('timeline_bad_value')
    const nf = applyTimelineOps(one(), [{ op: 'setStabilize', id: 'zz', on: true }])
    expect(nf.ok ? 'ok' : nf.code).toBe('timeline_not_found')
  })
  it('split keeps it on both halves; save/parse round-trips it', () => {
    const d = ok(one(), [{ op: 'setStabilize', id: 'c1', on: true }, { op: 'splitClip', id: 'c1', at: 2 }])
    expect(d.clips.map((c) => c.stab)).toEqual([true, true])
    const p = parseTimeline(JSON.parse(JSON.stringify(d)))
    expect(p.ok && p.doc.clips[1].stab).toBe(true)
  })
})

describe('stabilise: render graph', () => {
  it('only a stabilised clip gets deshake', () => {
    const inp = { abs: { 'P/a.mp4': '/x/a.mp4' }, hasAudio: { 'P/a.mp4': false }, assPath: null, out: '/x/o.mp4' }
    const fc = (d: TimelineDoc) => { const a = buildRender(d, inp); return a[a.indexOf('-filter_complex') + 1] }
    expect(fc(ok(one(), [{ op: 'setStabilize', id: 'c1', on: true }]))).toContain('fps=30,deshake,split=2')
    expect(fc(one())).not.toContain('deshake')
  })
})

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0
describe.skipIf(!hasFfmpeg)('stabilise: real ffmpeg', () => {
  it('a shaky clip renders with the filter', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stab-'))
    try {
      execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=s=320x180:r=30', '-vf', "crop=300:160:'10+8*sin(n*1.7)':'10+8*cos(n*2.3)'", '-t', '2', '-pix_fmt', 'yuv420p', join(dir, 'a.mp4')])
      const d = ok(one(), [{ op: 'trimClip', id: 'c1', start: 0, end: 2 }, { op: 'setStabilize', id: 'c1', on: true }])
      const out = join(dir, 'o.mp4')
      execFileSync('ffmpeg', buildRender(d, { abs: { 'P/a.mp4': join(dir, 'a.mp4') }, hasAudio: { 'P/a.mp4': false }, assPath: null, out }))
      expect(statSync(out).size).toBeGreaterThan(1000)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }, 120000)
})
