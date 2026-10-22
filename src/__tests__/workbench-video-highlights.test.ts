// #669 phase C: long to short: the rule-based pick of the best stretches, the input checks and the injected recogniser.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { applyTimelineOps, emptyTimeline, type TimelineDoc } from '../workbench-video-timeline.js'
import { pickHighlights, findHighlights, HIGHLIGHT_MAX_COUNT } from '../workbench-video-highlights.js'
import { _setVideoDeps } from '../workbench-video.js'
import type { SubWord } from '../workbench-video-autosub.js'
import type { ProjectRow } from '../projects.js'

const state = vi.hoisted(() => ({ installed: true }))
vi.mock('../web/routes/voice.js', async (orig) => ({
  ...(await orig<typeof import('../web/routes/voice.js')>()),
  isVoiceInstalled: () => state.installed,
}))

/** `n` sentences of 5 words, 0.4 s per word, `gap` seconds between sentences, from `t0`. */
function speech(n: number, gap: number, t0 = 0, wps = 0.4): SubWord[] {
  const out: SubWord[] = []
  let t = t0
  for (let s = 0; s < n; s += 1) {
    for (let w = 0; w < 5; w += 1) { out.push({ word: w === 4 ? `mondat${s}.` : `szo${w}`, start: t, end: t + wps - 0.05 }); t += wps }
    t += gap
  }
  return out
}
const doc = (end: number): TimelineDoc => {
  const r = applyTimelineOps(emptyTimeline(), [{ op: 'addClip', src: 'P/a.mp4', start: 10, end }])
  if (!r.ok) throw new Error(r.code)
  return r.doc
}

describe('pickHighlights', () => {
  it('proposes stretches of about the target length on sentence borders, shifted to the source clock', () => {
    const h = pickHighlights(speech(30, 0.5), 15, 2, 10)
    expect(h.length).toBe(2)
    for (const x of h) {
      expect(x.end - x.start).toBeGreaterThan(8)
      expect(x.end - x.start).toBeLessThan(18)
      expect(x.start).toBeGreaterThanOrEqual(10)
      expect(x.text).toMatch(/mondat\d+\.$/)
    }
  })
  it('proposals never overlap and come best first', () => {
    const h = pickHighlights(speech(40, 0.5), 15, 3, 0)
    expect(h.length).toBe(3)
    const s = [...h].sort((a, b) => a.start - b.start)
    for (let i = 1; i < s.length; i += 1) expect(s[i].start).toBeGreaterThanOrEqual(s[i - 1].end)
    expect(h[0].score).toBeGreaterThanOrEqual(h[1].score)
  })
  it('prefers the dense talk over a slow, pause-ridden part', () => {
    const slow = speech(10, 2.5, 0, 0.8)
    const lastEnd = slow[slow.length - 1].end + 3
    const fast = speech(12, 0.3, lastEnd, 0.3)
    const [best] = pickHighlights([...slow, ...fast], 15, 1, 0)
    expect(best.start).toBeGreaterThan(lastEnd - 1)
  })
  it('gives nothing for no speech and for speech shorter than the target', () => {
    expect(pickHighlights([], 30, 3)).toEqual([])
    expect(pickHighlights(speech(2, 0.5), 60, 3)).toEqual([])
  })
})

describe('findHighlights: input checks', () => {
  const project = { id: 'p', folder_path: 'P' } as unknown as ProjectRow
  beforeEach(() => { state.installed = true; _setVideoDeps({ tool: async () => ({ state: 'ok', path: '/usr/bin/ffmpeg', detail: null }) }) })
  it('names a bad target, a bad count, a bad language and an unknown clip', async () => {
    expect(await findHighlights(project, 'i', doc(200), { clipId: 'c1', target: 20 })).toMatchObject({ code: 'highlight_bad_target' })
    expect(await findHighlights(project, 'i', doc(200), { clipId: 'c1', count: HIGHLIGHT_MAX_COUNT + 1 })).toMatchObject({ code: 'highlight_bad_count' })
    expect(await findHighlights(project, 'i', doc(200), { clipId: 'c1', language: 'fr' })).toMatchObject({ code: 'autosub_bad_language' })
    expect(await findHighlights(project, 'i', doc(200), { clipId: 'c9' })).toMatchObject({ code: 'highlight_clip_missing' })
  })
  it('refuses a clip that is too short for the target, and says when the toolkit is missing', async () => {
    expect(await findHighlights(project, 'i', doc(40), { clipId: 'c1', target: 60 })).toMatchObject({ code: 'highlight_clip_short' })
    state.installed = false
    expect(await findHighlights(project, 'i', doc(200), { clipId: 'c1' })).toMatchObject({ code: 'autosub_not_installed' })
  })
  it('a source outside the project is refused before any work', async () => {
    const other = applyTimelineOps(emptyTimeline(), [{ op: 'addClip', src: 'Q/a.mp4', start: 0, end: 200 }])
    if (!other.ok) throw new Error(other.code)
    expect(await findHighlights(project, 'i', other.doc, { clipId: 'c1' })).toMatchObject({ code: 'render_source_outside' })
  })
})
