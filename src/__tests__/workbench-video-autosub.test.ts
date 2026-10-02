// Phase 5, video: automatic subtitles from the LOCAL recogniser. The grouping of words is
// pure; the route and the agent tool are tested with a stand-in recogniser (and real ffmpeg
// when it is installed, for cutting the audio).
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase } from '../db.js'
import { createProject, updateProject } from '../projects.js'
import { createWorkItem } from '../workbench.js'
import { callWorkbench } from './helpers/workbench-route-call.js'
import { runTool } from '../workbench-agent/execute.js'
import { getTool } from '../workbench-agent/tools.js'
import { wordsToSubtitles, applySubtitleLines, _setAutoSubDeps, type SubWord } from '../workbench-video-autosub.js'
import { emptyTimeline, applyTimelineOps } from '../workbench-video-timeline.js'

const w = (word: string, start: number, end: number): SubWord => ({ word, start, end })

describe('words to subtitles', () => {
  it('a pause starts a new subtitle; punctuation sticks to the word; times follow the first and last word', () => {
    const out = wordsToSubtitles([w('Szia', 0, 0.4), w('világ', 0.5, 1), w('.', 1, 1.01), w('Újra', 3, 3.4), w('itt', 3.5, 3.9)])
    expect(out.map((l) => l.text)).toEqual(['Szia világ.', 'Újra itt'])
    expect(out[0]).toMatchObject({ start: 0 })
    expect(out[1]).toMatchObject({ start: 3, end: 3.9 })
  })

  it('a long run is cut at 80 characters and 6 seconds, never in the middle of a word', () => {
    const words: SubWord[] = Array.from({ length: 40 }, (_, i) => w(`szó${i}`, i * 0.3, i * 0.3 + 0.25))
    const out = wordsToSubtitles(words)
    expect(out.length).toBeGreaterThan(1)
    for (const l of out) {
      expect(l.text.length).toBeLessThanOrEqual(80)
      expect(l.end - l.start).toBeLessThanOrEqual(6.3)
      expect(l.text).not.toMatch(/szó\d*$/.test(l.text) ? /^$/ : /\s$/)
    }
    expect(out.map((l) => l.text).join(' ').split(' ')).toHaveLength(40)
  })

  it('a very short word stays on screen for half a second, but never into the next subtitle', () => {
    const out = wordsToSubtitles([w('Igen', 0, 0.1), w('Nem', 1.5, 1.6)])
    expect(out[0].end - out[0].start).toBeGreaterThanOrEqual(0.5)
    expect(out[0].end).toBeLessThanOrEqual(out[1].start)
  })

  it('broken words (no time, empty text) are skipped, an empty list gives nothing', () => {
    expect(wordsToSubtitles([])).toEqual([])
    expect(wordsToSubtitles([w('', 0, 1), { word: 'x', start: NaN, end: 1 }])).toEqual([])
  })
})

describe('putting the lines on the timeline', () => {
  const base = () => {
    const r = applyTimelineOps(emptyTimeline(), [{ op: 'addClip', src: 'P/a.mp4', start: 0, end: 10 }, { op: 'addSubtitle', text: 'régi', start: 0, end: 1 }])
    if (!r.ok) throw new Error(r.code)
    return r.doc
  }
  it('adds after the typed ones by default, replaces them on request, in batches over 100', () => {
    const lines = Array.from({ length: 250 }, (_, i) => ({ text: `sor ${i}`, start: i * 0.03, end: i * 0.03 + 0.2 }))
    const added = applySubtitleLines(base(), lines, false)
    expect(added.ok && added.doc.subtitles).toHaveLength(251)
    const replaced = applySubtitleLines(base(), lines, true)
    expect(replaced.ok && replaced.doc.subtitles).toHaveLength(250)
    expect(replaced.ok && replaced.doc.subtitles.some((s) => s.text === 'régi')).toBe(false)
  })
  it('refuses with a code when it would not fit (500 subtitles at most)', () => {
    const lines = Array.from({ length: 501 }, (_, i) => ({ text: 'x', start: i, end: i + 0.5 }))
    expect(applySubtitleLines(base(), lines, true)).toMatchObject({ ok: false, code: 'timeline_too_many' })
  })
})

const HAVE_FFMPEG = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0

describe.skipIf(!HAVE_FFMPEG)('automatic subtitles: the route and the agent tool (stand-in recogniser, real ffmpeg)', () => {
  let depot = ''
  let pid = ''
  let itemId = ''
  const dir = () => join(depot, 'Projektek', 'teszt')
  const url = (tail = '') => `/api/workbench/items/${itemId}/timeline${tail}`
  const json = { 'content-type': 'application/json' }
  const ops = (list: unknown[]) => callWorkbench(url('/ops'), 'POST', JSON.stringify({ ops: list }), json)
  const ctx = () => ({ projectId: pid, workItemId: itemId, lang: 'en' as const })
  const heard: string[] = []

  beforeEach(() => {
    initDatabase(':memory:')
    depot = mkdtempSync(join(tmpdir(), 'marveen-wb-autosub-'))
    mkdirSync(dir(), { recursive: true })
    process.env['MARVEEN_DEPOT'] = depot
    const p = createProject({ name: 'Kovács ház' })
    if (!p.ok) throw new Error('project')
    pid = p.project.id
    updateProject(pid, { folder_path: 'Projektek/teszt' })
    const it = createWorkItem({ project_id: pid, title: 'Reklám', type: 'video' })
    if (!it.ok) throw new Error('item')
    itemId = it.item.id
    const ff = (args: string[]) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'pipe' })
    ff(['-f', 'lavfi', '-i', 'testsrc=duration=4:size=320x180:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', join(dir(), 'a.mp4')])
    ff(['-f', 'lavfi', '-i', 'color=c=red:s=160x90:d=2:r=25', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(dir(), 'csendes.mp4')])
    heard.length = 0
    _setAutoSubDeps({
      transcribe: async (_wav, lang) => {
        heard.push(lang)
        return { ok: true, words: [{ word: 'Hello', start: 0.2, end: 0.6 }, { word: 'világ.', start: 0.7, end: 1.2 }] }
      },
    })
  })
  afterEach(() => {
    _setAutoSubDeps()
    rmSync(depot, { recursive: true, force: true })
    delete process.env['MARVEEN_DEPOT']
  })

  it('the clips are recognised one by one and the lines land on the TIMELINE clock; a clip without sound is skipped and named', async () => {
    await ops([
      { op: 'addClip', src: 'Projektek/teszt/csendes.mp4', start: 0, end: 2 },
      { op: 'addClip', src: 'Projektek/teszt/a.mp4', start: 1, end: 4 },
    ])
    const r = await callWorkbench(url('/autosubtitle'), 'POST', JSON.stringify({ language: 'de' }), json)
    expect(r.status).toBe(200)
    expect(heard).toEqual(['de'])
    expect(r.body.skipped).toEqual(['Projektek/teszt/csendes.mp4'])
    // the second clip starts at 2s on the timeline: 0.2s into the cut -> 2.2s
    expect(r.body.timeline.subtitles).toHaveLength(1)
    expect(r.body.timeline.subtitles[0]).toMatchObject({ text: 'Hello világ.', start: 2.2, end: 3.2 })
    expect(r.body.message).toMatch(/Nézd át/)
    // one undo step takes them away again
    const u = await callWorkbench(url('/undo'), 'POST')
    expect(u.body.timeline.subtitles).toEqual([])
  })

  it('an unknown language is refused; no clips is a plain failure; no recogniser says how to get it', async () => {
    expect((await callWorkbench(url('/autosubtitle'), 'POST', JSON.stringify({ language: 'xx' }), json)).status).toBe(400)
    const empty = await callWorkbench(url('/autosubtitle'), 'POST', JSON.stringify({}), json)
    expect(empty.status).toBe(400)
    await ops([{ op: 'addClip', src: 'Projektek/teszt/a.mp4', start: 0, end: 2 }])
    _setAutoSubDeps({ transcribe: async () => ({ ok: false, code: 'autosub_not_installed', detail: null }) })
    const r = await callWorkbench(url('/autosubtitle'), 'POST', JSON.stringify({}), json)
    expect(r.status).toBe(503)
    expect(r.body.message).toMatch(/nincs telepítve/)
  })

  it('no speech found changes nothing and says so', async () => {
    await ops([{ op: 'addClip', src: 'Projektek/teszt/a.mp4', start: 0, end: 2 }])
    _setAutoSubDeps({ transcribe: async () => ({ ok: true, words: [] }) })
    const r = await callWorkbench(url('/autosubtitle'), 'POST', JSON.stringify({}), json)
    expect(r.status).toBe(200)
    expect(r.body.added).toBe(0)
    expect(r.body.message).toMatch(/Nem találtam beszédet/)
  })

  it('the agent tool does the same, replaces on request, and is one undo step', async () => {
    expect(getTool('timeline.autoSubtitle')?.autonomyCategory).toBe('workbench_file_write')
    await ops([{ op: 'addClip', src: 'Projektek/teszt/a.mp4', start: 0, end: 3 }, { op: 'addSubtitle', text: 'régi', start: 0, end: 1 }])
    const r: any = await runTool('timeline.autoSubtitle', { language: 'hu', replace: true }, { ...ctx(), turnId: 't1' })
    expect(r.ok).toBe(true)
    expect(r.data.added).toBe(1)
    expect(r.data.timeline.subtitles.map((s: any) => s.text)).toEqual(['Hello világ.'])
    expect(r.data.note).toMatch(/check them/)
    expect(await runTool('timeline.autoSubtitle', { language: 'xx' }, ctx())).toMatchObject({ ok: false, code: 'autosub_bad_language' })
  })
})
