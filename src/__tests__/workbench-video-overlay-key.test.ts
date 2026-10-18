// #669 phase B: background removal (key) on overlay pictures (model, validation, render graph, a real ffmpeg render).
import { describe, it, expect } from 'vitest'
import { spawnSync, execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emptyTimeline, parseTimeline, applyTimelineOps, OVERLAY_KEYS, type TimelineDoc } from '../workbench-video-timeline.js'
import { buildRender } from '../workbench-video-render.js'

function ok(doc: TimelineDoc, ops: unknown[]): TimelineDoc {
  const r = applyTimelineOps(doc, ops)
  if (!r.ok) throw new Error(`${r.code}: ${r.detail}`)
  return r.doc
}
const base = (key?: string): TimelineDoc => ok(emptyTimeline(), [
  { op: 'addClip', src: 'P/a.mp4', start: 0, end: 2 },
  { op: 'addOverlay', src: 'P/logo.png', start: 0, end: 2, x: 0, y: 0, width: 1, opacity: 1, key },
])

describe('overlay key: model', () => {
  it('addOverlay stores a key, none/absent stores nothing, a bad one is refused', () => {
    expect(base('white').overlays[0].key).toBe('white')
    expect(base('none').overlays[0].key).toBeUndefined()
    expect(base().overlays[0].key).toBeUndefined()
    const bad = applyTimelineOps(emptyTimeline(), [{ op: 'addOverlay', src: 'P/logo.png', start: 0, end: 1, key: 'pink' }])
    expect(bad.ok ? 'ok' : bad.code).toBe('timeline_bad_style')
    expect(OVERLAY_KEYS).toEqual(['green', 'blue', 'white', 'black'])
  })
  it('updateOverlay keeps the key when not mentioned, changes it, and none clears it; save/parse round-trips', () => {
    let d = base('green')
    d = ok(d, [{ op: 'updateOverlay', id: 'o1', x: 0.1 }])
    expect(d.overlays[0].key).toBe('green')
    d = ok(d, [{ op: 'updateOverlay', id: 'o1', key: 'blue' }])
    expect(d.overlays[0].key).toBe('blue')
    const p = parseTimeline(JSON.parse(JSON.stringify(d)))
    expect(p.ok && p.doc.overlays[0].key).toBe('blue')
    d = ok(d, [{ op: 'updateOverlay', id: 'o1', key: 'none' }])
    expect(d.overlays[0].key).toBeUndefined()
  })
})

describe('overlay key: render graph', () => {
  it('only a keyed overlay gets the colorkey filter', () => {
    const inp = { abs: { 'P/a.mp4': '/x/a.mp4', 'P/logo.png': '/x/logo.png' }, hasAudio: { 'P/a.mp4': false }, assPath: null, out: '/x/o.mp4' }
    const fc = (d: TimelineDoc) => { const a = buildRender(d, inp); return a[a.indexOf('-filter_complex') + 1] }
    expect(fc(base('white'))).toContain('colorkey=0xFFFFFF:0.3:0.1')
    expect(fc(base())).not.toContain('colorkey')
  })
})

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0
describe.skipIf(!hasFfmpeg)('overlay key: real ffmpeg', () => {
  it('the white background of the picture disappears (red video shows), the blue square stays', () => {
    const dir = mkdtempSync(join(tmpdir(), 'okey-'))
    try {
      const q = ['-hide_banner', '-loglevel', 'error', '-y']
      execFileSync('ffmpeg', [...q, '-f', 'lavfi', '-i', 'color=red:s=320x180:r=30', '-t', '2', '-pix_fmt', 'yuv420p', join(dir, 'a.mp4')])
      execFileSync('ffmpeg', [...q, '-f', 'lavfi', '-i', 'color=white:s=320x180', '-vf', 'drawbox=x=110:y=60:w=100:h=60:color=blue:t=fill', '-frames:v', '1', join(dir, 'logo.png')])
      const px = (out: string, at: string) => {
        const raw = execFileSync('ffmpeg', [...q.slice(0, 3), '-ss', '0.5', '-i', out, '-frames:v', '1', '-vf', `crop=4:4:${at},scale=1:1,format=rgb24`, '-f', 'rawvideo', '-'])
        return [raw[0], raw[1], raw[2]]
      }
      const render = (key?: string) => {
        const out = join(dir, `${key ?? 'plain'}.mp4`)
        execFileSync('ffmpeg', buildRender(base(key), { abs: { 'P/a.mp4': join(dir, 'a.mp4'), 'P/logo.png': join(dir, 'logo.png') }, hasAudio: { 'P/a.mp4': false }, assPath: null, out }))
        return out
      }
      const plain = render(), keyed = render('white')
      const corner = (o: string) => px(o, '20:20')
      const centre = (o: string) => px(o, '958:538')
      expect(corner(plain)[1]).toBeGreaterThan(200)       // white background kept
      const [r, g, b] = corner(keyed)
      expect(r).toBeGreaterThan(150); expect(g).toBeLessThan(80); expect(b).toBeLessThan(80)  // red video shows through
      const c = centre(keyed)
      expect(c[2]).toBeGreaterThan(150); expect(c[0]).toBeLessThan(80)                         // blue square stays
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }, 120000)
})
