/**
 * LONG TO SHORT for the video timeline (#669 phase C): the speech of one clip is recognised by the local recogniser
 * (the same one the automatic subtitles use, nothing leaves the machine), and the best stretches of about the wanted
 * length are proposed. The choice is a plain rule: stretches that start and end on a sentence border, are dense with
 * speech and have few long pauses score high. It does not understand the content, and the owner picks which one to keep.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isVoiceInstalled } from './web/routes/voice.js'
import { videoTool, videoRunTo, videoBusy, type VideoFail } from './workbench-video.js'
import { resolveMedia, probeMedia, type RenderFail } from './workbench-video-render.js'
import { transcribeWav, AUTOSUB_LANGS, AUTOSUB_MAX_SECONDS, type AutoSubFail, type AutoSubLang, type SubWord } from './workbench-video-autosub.js'
import type { TimelineDoc } from './workbench-video-timeline.js'
import type { ProjectRow } from './projects.js'

export const HIGHLIGHT_TARGETS = [15, 30, 60] as const
export const HIGHLIGHT_MAX_COUNT = 3
export const HIGHLIGHT_MIN_CLIP = 20

export interface Highlight {
  /** Seconds of the SOURCE file (what trimClip takes). */
  start: number
  end: number
  text: string
  /** 0..100, only to order the proposals. */
  score: number
}

interface Sentence { words: SubWord[]; start: number; end: number }

const SENTENCE_PAUSE = 0.8

function sentencesOf(words: SubWord[]): Sentence[] {
  const out: Sentence[] = []
  let cur: SubWord[] = []
  const flush = (): void => { if (cur.length) { out.push({ words: cur, start: cur[0].start, end: cur[cur.length - 1].end }); cur = [] } }
  for (const w of words) {
    if (!w.word || !Number.isFinite(w.start) || !Number.isFinite(w.end)) continue
    if (cur.length && w.start - cur[cur.length - 1].end > SENTENCE_PAUSE) flush()
    cur.push(w)
    if (/[.?!…]$/.test(w.word)) flush()
  }
  flush()
  return out
}

/** Words (seconds from the start of the cut) -> up to `count` non-overlapping proposals of about `target` seconds, best first. */
export function pickHighlights(words: SubWord[], target: number, count: number, offset = 0): Highlight[] {
  const sents = sentencesOf(words)
  const cands: Highlight[] = []
  for (let i = 0; i < sents.length; i += 1) {
    for (let j = i; j < sents.length; j += 1) {
      const dur = sents[j].end - sents[i].start
      if (dur > target * 1.15) break
      if (dur < target * 0.6) continue
      const ws = sents.slice(i, j + 1).flatMap((s) => s.words)
      let silence = 0
      for (let k = 1; k < ws.length; k += 1) silence += Math.max(0, ws[k].start - ws[k - 1].end)
      const density = Math.min(1, ws.length / dur / 3)
      const talk = 1 - Math.min(1, silence / dur)
      const lenFit = 1 - Math.min(1, Math.abs(dur - target) / target)
      const hook = /[?!]/.test(sents[i].words[sents[i].words.length - 1].word) || /[?]/.test(sents[i].words.map((w) => w.word).join(' ')) ? 1 : 0
      const score = 100 * (0.4 * density + 0.3 * talk + 0.2 * lenFit + 0.1 * hook)
      cands.push({
        start: Math.max(0, sents[i].start - 0.2) + offset, end: sents[j].end + 0.3 + offset,
        text: ws.map((w) => w.word).join(' ').replace(/\s+([,.;:!?])/g, '$1').trim().slice(0, 240), score: Math.round(score),
      })
    }
  }
  cands.sort((a, b) => b.score - a.score)
  const picked: Highlight[] = []
  for (const c of cands) {
    if (picked.length >= count) break
    if (picked.some((p) => c.start < p.end && p.start < c.end)) continue
    picked.push({ ...c, start: Math.round(c.start * 1000) / 1000, end: Math.round(c.end * 1000) / 1000 })
  }
  return picked
}

export type HighlightFail = { ok: false; code: string; detail: string | null }
export type HighlightFound = { ok: true; clipId: string; target: number; highlights: Highlight[]; heardWords: number }

export async function findHighlights(
  project: ProjectRow, itemId: string, doc: TimelineDoc,
  opts: { clipId: unknown; target?: unknown; count?: unknown; language?: unknown }, onProgress?: (fraction: number) => void, dryRun = false,
): Promise<HighlightFound | HighlightFail | RenderFail | VideoFail | AutoSubFail> {
  const target = Number(opts.target ?? 30)
  if (!(HIGHLIGHT_TARGETS as readonly number[]).includes(target)) return { ok: false, code: 'highlight_bad_target', detail: String(opts.target) }
  const count = Math.round(Number(opts.count ?? 3))
  if (!Number.isFinite(count) || count < 1 || count > HIGHLIGHT_MAX_COUNT) return { ok: false, code: 'highlight_bad_count', detail: String(opts.count) }
  const language = String(opts.language ?? 'hu') as AutoSubLang
  if (!(AUTOSUB_LANGS as readonly string[]).includes(language)) return { ok: false, code: 'autosub_bad_language', detail: null }
  const clip = doc.clips.find((c) => c.id === opts.clipId)
  if (!clip) return { ok: false, code: 'highlight_clip_missing', detail: String(opts.clipId) }
  const len = clip.end - clip.start
  if (len < HIGHLIGHT_MIN_CLIP || len < target * 1.3) return { ok: false, code: 'highlight_clip_short', detail: String(Math.round(len)) }
  if (len > AUTOSUB_MAX_SECONDS) return { ok: false, code: 'autosub_too_long', detail: `${Math.round(len / 60)} minutes` }
  if (!isVoiceInstalled()) return { ok: false, code: 'autosub_not_installed', detail: null }
  const ff = await videoTool()
  if (!ff.ok) return { ok: false, code: ff.code, detail: ff.detail ?? null }
  const src = resolveMedia(project, clip.src)
  if (!src.ok) return src
  if (videoBusy.has(itemId)) return { ok: false, code: 'video_busy', detail: null }
  if (dryRun) return { ok: true, clipId: clip.id, target, highlights: [], heardWords: 0 }
  videoBusy.add(itemId)
  const tmp = mkdtempSync(join(tmpdir(), 'wbhl'))
  try {
    const p = await probeMedia(ff.path, src.abs)
    if (p === null) return { ok: false, code: 'render_probe_failed', detail: clip.src }
    if (!p.audio) return { ok: false, code: 'highlight_no_audio', detail: null }
    const wav = join(tmp, 'clip.wav')
    const cut = await videoRunTo(ff.path, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(clip.start), '-t', String(len), '-i', src.abs, '-vn', '-ac', '1', '-ar', '16000', '-f', 'wav', wav], wav, 10 * 60_000)
    if (!cut.ok) return { ok: false, code: cut.code, detail: cut.detail ?? null }
    onProgress?.(0.1)
    const heard = await transcribeWav(wav, language)
    if (!heard.ok) return heard
    onProgress?.(0.95)
    return { ok: true, clipId: clip.id, target, highlights: pickHighlights(heard.words, target, count, clip.start), heardWords: heard.words.length }
  } finally {
    videoBusy.delete(itemId)
    try { rmSync(tmp, { recursive: true, force: true }) } catch { /* the system cleans the temporary folder later */ }
  }
}
