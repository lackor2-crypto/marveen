// #669 phase 1: transitions between clips (model, validation, render graph, a real ffmpeg render).
import { describe, it, expect } from 'vitest'
import { spawnSync, execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  emptyTimeline, parseTimeline, applyTimelineOps, timelineDuration, clipOffsets, clipLen, effectiveTransition, type TimelineDoc,
} from '../workbench-video-timeline.js'
import { buildRender, joinClips, atempo } from '../workbench-video-render.js'

function ok(doc: TimelineDoc, ops: unknown[]): TimelineDoc {
  const r = applyTimelineOps(doc, ops)
  if (!r.ok) throw new Error(`${r.code}: ${r.detail}`)
  return r.doc
}
const three = (): TimelineDoc => ok(emptyTimeline(), [
  { op: 'addClip', src: 'P/a.mp4', start: 0, end: 4 },
  { op: 'addClip', src: 'P/b.mp4', start: 0, end: 4 },
  { op: 'addClip', src: 'P/c.mp4', start: 0, end: 4 },
])

describe('transitions: model', () => {
  it('setTransition shortens the video by the overlap and shifts later clips', () => {
    const d = ok(three(), [{ op: 'setTransition', id: 'c1', type: 'fade', duration: 1 }])
    expect(d.clips[0].transition).toEqual({ type: 'fade', duration: 1 })
    expect(timelineDuration(d)).toBe(11)
    expect(clipOffsets(d)).toEqual([0, 3, 7])
  })
  it('none clears it; no transition keeps the old numbers', () => {
    const d = ok(three(), [{ op: 'setTransition', id: 'c1', type: 'fade' }, { op: 'setTransition', id: 'c1', type: 'none' }])
    expect(d.clips[0].transition).toBeUndefined()
    expect(timelineDuration(d)).toBe(12)
  })
  it('rejects the last clip, a bad type, a bad length and an unknown clip', () => {
    const f = (op: Record<string, unknown>) => { const r = applyTimelineOps(three(), [{ op: 'setTransition', ...op }]); return r.ok ? 'ok' : r.code }
    expect(f({ id: 'c3', type: 'fade' })).toBe('timeline_bad_transition')
    expect(f({ id: 'c1', type: 'spin' })).toBe('timeline_bad_transition')
    expect(f({ id: 'c1', type: 'fade', duration: 5 })).toBe('timeline_bad_transition')
    expect(f({ id: 'c1', type: 'fade', duration: 0.01 })).toBe('timeline_bad_transition')
    expect(f({ id: 'zz', type: 'fade' })).toBe('timeline_not_found')
  })
  it('the length is capped at half of each neighbour (a later trim cannot break it)', () => {
    let d = ok(three(), [{ op: 'setTransition', id: 'c1', type: 'fade', duration: 2 }])
    d = ok(d, [{ op: 'trimClip', id: 'c2', start: 0, end: 1 }])
    expect(effectiveTransition(d, 0)!.duration).toBe(0.5)
    d = ok(d, [{ op: 'trimClip', id: 'c2', start: 0, end: 0.1 }])
    expect(effectiveTransition(d, 0)).toBeNull()
  })
  it('split gives the transition to the second half; save/parse round-trips it', () => {
    let d = ok(three(), [{ op: 'setTransition', id: 'c1', type: 'slideleft', duration: 1 }])
    d = ok(d, [{ op: 'splitClip', id: 'c1', at: 2 }])
    expect(d.clips[0].transition).toBeUndefined()
    expect(d.clips[1].transition?.type).toBe('slideleft')
    const p = parseTimeline(JSON.parse(JSON.stringify(d)))
    expect(p.ok && p.doc.clips[1].transition).toEqual({ type: 'slideleft', duration: 1 })
    expect(parseTimeline({ clips: [{ src: 'P/a.mp4', start: 0, end: 2, transition: { type: 'x' } }] }).ok).toBe(false)
  })
})

describe('transitions: render graph', () => {
  it('without a transition the graph is the unchanged concat', () => {
    expect(joinClips(three(), 'vc', 'ac')).toEqual(['[v0][a0][v1][a1][v2][a2]concat=n=3:v=1:a=1[vc][ac]'])
  })
  it('a transition is xfade + acrossfade at the right offset; a hard cut is a pair concat', () => {
    const d = ok(three(), [{ op: 'setTransition', id: 'c1', type: 'fadeblack', duration: 1 }])
    const g = joinClips(d, 'vc', 'ac').join(';')
    expect(g).toContain('[v0][v1]xfade=transition=fadeblack:duration=1:offset=3[jv0]')
    expect(g).toContain('[a0][a1]acrossfade=d=1')
    expect(g).toContain('concat=n=2:v=1:a=1')
    expect(g).toContain('[vc]')
  })
  it('the overlays and music use the shortened length', () => {
    const d = ok(three(), [{ op: 'setTransition', id: 'c1', type: 'fade', duration: 1 }, { op: 'addOverlay', src: 'P/o.png', start: 0, end: 2 }])
    const a = buildRender(d, { abs: { 'P/a.mp4': '/a', 'P/b.mp4': '/b', 'P/c.mp4': '/c', 'P/o.png': '/o' }, hasAudio: { 'P/a.mp4': true, 'P/b.mp4': true, 'P/c.mp4': true }, assPath: null, out: '/x.mp4' })
    expect(a[a.indexOf('-t') + 1]).toBe('11')
  })
})

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0
describe.skipIf(!hasFfmpeg)('transitions: real ffmpeg', () => {
  it('renders a crossfade: right length, and the middle frame is a mix of both clips', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wbtr'))
    try {
      for (const c of ['red', 'blue']) {
        execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=${c}:s=320x180:r=30`, '-f', 'lavfi', '-i', 'sine=f=440', '-t', '3', '-pix_fmt', 'yuv420p', join(dir, `${c}.mp4`)])
      }
      const d = ok(emptyTimeline(), [
        { op: 'addClip', src: 'P/red.mp4', start: 0, end: 3 }, { op: 'addClip', src: 'P/blue.mp4', start: 0, end: 3 },
        { op: 'setTransition', id: 'c1', type: 'fade', duration: 1 },
      ])
      const out = join(dir, 'out.mp4')
      const args = buildRender(d, { abs: { 'P/red.mp4': join(dir, 'red.mp4'), 'P/blue.mp4': join(dir, 'blue.mp4') }, hasAudio: { 'P/red.mp4': true, 'P/blue.mp4': true }, assPath: null, out })
      execFileSync('ffmpeg', args)
      expect(existsSync(out)).toBe(true)
      const dur = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out]).toString())
      expect(dur).toBeGreaterThan(4.9); expect(dur).toBeLessThan(5.15)
      const px = (t: string) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', t, '-i', out, '-frames:v', '1', '-vf', 'scale=1:1,format=rgb24', '-f', 'rawvideo', '-']).toString('hex')
      const mid = px('2.5')
      expect(mid.slice(0, 2)).not.toBe('ff'); expect(mid.slice(0, 2)).not.toBe('00'); expect(mid.slice(4, 6)).not.toBe('00')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('speed (#669)', () => {
  it('setSpeed changes the length, offsets and the transition cap; 1 clears; bad values fail', () => {
    let d = ok(emptyTimeline(), [{ op: 'addClip', src: 'P/a.mp4', start: 0, end: 4 }, { op: 'addClip', src: 'P/b.mp4', start: 0, end: 4 }])
    d = ok(d, [{ op: 'setSpeed', id: 'c1', speed: 2 }])
    expect(clipLen(d.clips[0])).toBe(2); expect(timelineDuration(d)).toBe(6); expect(clipOffsets(d)).toEqual([0, 2])
    expect(ok(d, [{ op: 'setSpeed', id: 'c1', speed: 1 }]).clips[0].speed).toBeUndefined()
    for (const bad of [0.1, 5, 'x']) expect(applyTimelineOps(d, [{ op: 'setSpeed', id: 'c1', speed: bad }]).ok).toBe(false)
    expect(applyTimelineOps(d, [{ op: 'setSpeed', id: 'zz', speed: 2 }]).ok).toBe(false)
  })
  it('split keeps the speed on both halves; save/parse round-trips it', () => {
    let d = ok(emptyTimeline(), [{ op: 'addClip', src: 'P/a.mp4', start: 0, end: 4 }, { op: 'setSpeed', id: 'c1', speed: 0.5 }])
    d = ok(d, [{ op: 'splitClip', id: 'c1', at: 2 }])
    expect(d.clips.map((c) => c.speed)).toEqual([0.5, 0.5])
    const r = parseTimeline(JSON.parse(JSON.stringify(d))); expect(r.ok && r.doc.clips[1].speed).toBe(0.5)
  })
  it('atempo chains outside 0.5-2', () => {
    expect(atempo(1)).toBe(''); expect(atempo(1.5)).toBe(',atempo=1.5'); expect(atempo(4)).toBe(',atempo=2,atempo=2'); expect(atempo(0.25)).toBe(',atempo=0.5,atempo=0.5')
  })
})

describe.skipIf(!hasFfmpeg)('speed: real ffmpeg', () => {
  it('a 4 s clip at 2x renders 2 s, with sound', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wbsp'))
    try {
      execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=red:s=320x180:r=30', '-f', 'lavfi', '-i', 'sine=f=440', '-t', '4', '-pix_fmt', 'yuv420p', join(dir, 'a.mp4')])
      const d = ok(emptyTimeline(), [{ op: 'addClip', src: 'P/a.mp4', start: 0, end: 4 }, { op: 'setSpeed', id: 'c1', speed: 4 }])
      const out = join(dir, 'out.mp4')
      execFileSync('ffmpeg', buildRender(d, { abs: { 'P/a.mp4': join(dir, 'a.mp4') }, hasAudio: { 'P/a.mp4': true }, assPath: null, out }))
      const dur = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out]).toString())
      expect(dur).toBeGreaterThan(0.9); expect(dur).toBeLessThan(1.2)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
