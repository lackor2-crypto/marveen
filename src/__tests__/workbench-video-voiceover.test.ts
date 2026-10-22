// #669 phase C: a voiceover (a written line read aloud) on the timeline: model, ops, render graph, a real ffmpeg render, input checks.
import { describe, it, expect } from 'vitest'
import { spawnSync, execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emptyTimeline, applyTimelineOps, parseTimeline, timelineSummary, type TimelineDoc } from '../workbench-video-timeline.js'
import { buildRender } from '../workbench-video-render.js'
import { makeVoiceover, voiceoverFileStem } from '../workbench-video-tts.js'
import type { ProjectRow } from '../projects.js'

function ok(d: TimelineDoc, ops: unknown[]): TimelineDoc {
  const r = applyTimelineOps(d, ops)
  if (!r.ok) throw new Error(`${r.code}: ${r.detail}`)
  return r.doc
}
const doc = (music = false): TimelineDoc => ok(emptyTimeline(), [
  { op: 'addClip', src: 'P/a.mp4', start: 0, end: 4 },
  { op: 'addVoiceover', src: 'P/say.wav', start: 2, dur: 1, text: 'Szia' },
  ...(music ? [{ op: 'setMusic', src: 'P/m.wav', volume: 0.5, duck: true }] : []),
])

describe('voiceover: model and operations', () => {
  it('adds, updates (start, volume) and removes; sorted by start; the list disappears when empty', () => {
    let d = doc()
    expect(d.voiceovers).toEqual([{ id: 'v1', src: 'P/say.wav', start: 2, dur: 1, volume: 1, text: 'Szia' }])
    d = ok(d, [{ op: 'addVoiceover', src: 'P/b.wav', start: 0.5, dur: 2 }])
    expect(d.voiceovers!.map((v) => v.id)).toEqual(['v2', 'v1'])
    d = ok(d, [{ op: 'updateVoiceover', id: 'v1', start: 3, volume: 0.4 }])
    expect(d.voiceovers!.find((v) => v.id === 'v1')).toMatchObject({ start: 3, volume: 0.4, dur: 1, text: 'Szia' })
    d = ok(d, [{ op: 'removeVoiceover', id: 'v1' }, { op: 'removeVoiceover', id: 'v2' }])
    expect('voiceovers' in d).toBe(false)
  })
  it('refuses a non-audio file, a missing length, a bad volume, an unknown id', () => {
    const code = (op: Record<string, unknown>): string => { const r = applyTimelineOps(doc(), [op]); return r.ok ? 'ok' : r.code }
    expect(code({ op: 'addVoiceover', src: 'P/x.mp4', start: 0, dur: 1 })).toBe('timeline_bad_media')
    expect(code({ op: 'addVoiceover', src: 'P/x.wav', start: 0 })).toBe('timeline_bad_time')
    expect(code({ op: 'addVoiceover', src: 'P/x.wav', start: 0, dur: 1, volume: 2 })).toBe('timeline_bad_value')
    expect(code({ op: 'updateVoiceover', id: 'v9', start: 1 })).toBe('timeline_not_found')
    expect(code({ op: 'removeVoiceover', id: 'v9' })).toBe('timeline_not_found')
  })
  it('an old timeline without the field stays as it was, and a stored one round-trips', () => {
    const old = parseTimeline({ clips: [{ src: 'P/a.mp4', start: 0, end: 2 }] })
    expect(old.ok && 'voiceovers' in old.doc).toBe(false)
    const back = parseTimeline(JSON.parse(JSON.stringify(doc())))
    expect(back.ok && back.doc.voiceovers).toEqual(doc().voiceovers)
    expect(timelineSummary(doc())).toContain('1 voiceovers')
  })
})

describe('voiceover: render graph', () => {
  const inp = { abs: { 'P/a.mp4': '/x/a.mp4', 'P/say.wav': '/x/say.wav', 'P/m.wav': '/x/m.wav' }, hasAudio: { 'P/a.mp4': false }, assPath: null, out: '/x/o.mp4' }
  const fc = (d: TimelineDoc): string => { const a = buildRender(d, inp); return a[a.indexOf('-filter_complex') + 1] }
  it('is delayed to its start and mixed into the clips sound', () => {
    expect(fc(doc())).toContain('adelay=2000|2000')
    expect(fc(doc())).toContain('[acv]')
  })
  it('the music ducks under the voiceover too (the side-chain listens to the mixed sound)', () => {
    expect(fc(doc(true))).toContain('[acv]asplit=2[ac1][ac2]')
  })
  it('a timeline without voiceovers builds exactly the old graph', () => {
    expect(fc(ok(emptyTimeline(), [{ op: 'addClip', src: 'P/a.mp4', start: 0, end: 4 }]))).not.toContain('acv')
  })
})

describe('voiceover: input checks before anything is made', () => {
  const project = { id: 'p', folder_path: 'P' } as unknown as ProjectRow
  const item = { folder: null, container_folder: null, source_path: null }
  it('names the problem for an empty text, a too long text and an unknown voice', async () => {
    expect(await makeVoiceover(project, item, '  ', null)).toMatchObject({ ok: false, code: 'tts_text_required' })
    expect(await makeVoiceover(project, item, 'x'.repeat(2001), null)).toMatchObject({ ok: false, code: 'tts_text_too_long' })
    expect(await makeVoiceover(project, item, 'Szia', 'nincs-ilyen')).toMatchObject({ ok: false, code: 'tts_bad_voice' })
  })
  it('the file name is plain ASCII from the first words', () => {
    expect(voiceoverFileStem('Árvíztűrő tükörfúrógép, szia!')).toBe('felolvasas-arvizturo-tukorfurogep-szia')
    expect(voiceoverFileStem('!!!')).toBe('felolvasas-hang')
  })
})

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0
describe.skipIf(!hasFfmpeg)('voiceover: real ffmpeg', () => {
  it('the spoken tone is heard only from 2 s to 3 s, and the output keeps the base length', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vo-'))
    try {
      const q = ['-hide_banner', '-loglevel', 'error', '-y']
      execFileSync('ffmpeg', [...q, '-f', 'lavfi', '-i', 'color=red:s=320x180:r=30', '-t', '4', '-pix_fmt', 'yuv420p', join(dir, 'a.mp4')])
      execFileSync('ffmpeg', [...q, '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', join(dir, 'say.wav')])
      const out = join(dir, 'o.mp4')
      execFileSync('ffmpeg', buildRender(doc(), { abs: { 'P/a.mp4': join(dir, 'a.mp4'), 'P/say.wav': join(dir, 'say.wav') }, hasAudio: { 'P/a.mp4': false }, assPath: null, out }))
      const rms = (from: number, len: number): number => {
        const raw = execFileSync('ffmpeg', [...q.slice(0, 3), '-ss', String(from), '-t', String(len), '-i', out, '-vn', '-ac', '1', '-ar', '8000', '-f', 's16le', '-'])
        const n = raw.length / 2
        let s = 0
        for (let i = 0; i < n; i++) { const v = raw.readInt16LE(i * 2) / 32768; s += v * v }
        return Math.sqrt(s / Math.max(1, n))
      }
      const dur = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out]).toString())
      expect(dur).toBeGreaterThan(3.8)
      expect(rms(0.2, 1.4)).toBeLessThan(0.01)       // before the voiceover: silence
      expect(rms(2.2, 0.6)).toBeGreaterThan(0.03)    // during: the tone
      expect(rms(3.3, 0.6)).toBeLessThan(0.01)       // after: silence again
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }, 120000)
})
