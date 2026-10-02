/**
 * AUTOMATIC SUBTITLES for the video timeline (v4 spec phase 5): the speech of the
 * clips is recognised by the LOCAL recogniser (faster-whisper in the voice toolkit),
 * so the audio never leaves the machine. The words come back with times; they are
 * grouped into readable subtitles and put on the timeline as ordinary subtitles the
 * owner can edit (nothing is burnt in here: the render does that, as for typed ones).
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isVoiceInstalled, VENV_PY, VTOOLS_PY } from './web/routes/voice.js'
import { PROJECT_ROOT } from './config.js'
import { videoTool, videoRunTo, videoBusy } from './workbench-video.js'
import { resolveMedia, probeMedia } from './workbench-video-render.js'
import {
  applyTimelineOps, clipOffsets, TIMELINE_MAX_SUBTITLES, TIMELINE_TEXT_MAX, type TimelineDoc,
} from './workbench-video-timeline.js'
import type { ProjectRow } from './projects.js'

export const AUTOSUB_LANGS = ['hu', 'en', 'de'] as const
export type AutoSubLang = (typeof AUTOSUB_LANGS)[number]
/** The recogniser works at about the speed of the audio on a plain CPU, so there is a ceiling. */
export const AUTOSUB_MAX_SECONDS = 30 * 60
const AUTOSUB_TIMEOUT_MS = 45 * 60_000
const OPS_PER_BATCH = 100

export interface SubWord { word: string; start: number; end: number }
export interface SubLine { text: string; start: number; end: number }
export type AutoSubFail = { ok: false; code: string; detail: string | null }

/** At most this many characters in one subtitle (two short lines), this many seconds on screen. */
const MAX_CHARS = 80
const MAX_SECONDS = 6
const PAUSE = 0.7
const MIN_SECONDS = 0.5

/** Words with times -> readable subtitles: a new one at a pause, after a sentence end once it has some length, or when it gets too long. */
export function wordsToSubtitles(words: SubWord[]): SubLine[] {
  const out: SubLine[] = []
  let cur: SubWord[] = []
  const flush = (): void => {
    if (!cur.length) return
    const text = cur.map((w) => w.word).join(' ').replace(/\s+([,.;:!?])/g, '$1').trim().slice(0, TIMELINE_TEXT_MAX)
    if (text) out.push({ text, start: cur[0].start, end: cur[cur.length - 1].end })
    cur = []
  }
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i]
    if (!w.word || !Number.isFinite(w.start) || !Number.isFinite(w.end)) continue
    if (cur.length) {
      const last = cur[cur.length - 1]
      const len = cur.map((x) => x.word).join(' ').length + 1 + w.word.length
      if (w.start - last.end > PAUSE || len > MAX_CHARS || w.end - cur[0].start > MAX_SECONDS) flush()
    }
    cur.push(w)
    if (/[.?!…]$/.test(w.word) && cur.map((x) => x.word).join(' ').length >= 20) flush()
  }
  flush()
  // Short ones stay readable: stretch to the half second, but never into the next subtitle.
  for (let i = 0; i < out.length; i += 1) {
    const next = out[i + 1]
    const wanted = out[i].start + MIN_SECONDS
    if (out[i].end < wanted) out[i].end = next ? Math.min(wanted, Math.max(out[i].end, next.start)) : wanted
    if (out[i].end - out[i].start < 0.1) out[i].end = out[i].start + 0.1
  }
  return out
}

export type Transcriber = (wavPath: string, lang: AutoSubLang, timeoutMs: number) => Promise<{ ok: true; words: SubWord[] } | AutoSubFail>

const defaultTranscriber: Transcriber = (wav, lang, timeoutMs) => new Promise((resolve) => {
  if (!isVoiceInstalled()) { resolve({ ok: false, code: 'autosub_not_installed', detail: null }); return }
  // The script of this very checkout when there is one (always the newest, and it reads this checkout's
  // settings); the deployed copy in the voice folder otherwise (it is only as new as the last voice install).
  const repoScript = join(PROJECT_ROOT, 'scripts', 'voice', '_vtools.py')
  const args = [existsSync(repoScript) ? repoScript : VTOOLS_PY, 'transcribe-words-lang', wav, lang]
  let out = ''
  let err = ''
  let done = false
  const finish = (r: Awaited<ReturnType<Transcriber>>): void => { if (!done) { done = true; resolve(r) } }
  const child = spawn(VENV_PY, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* already gone */ } finish({ ok: false, code: 'autosub_timeout', detail: null }) }, timeoutMs)
  child.stdout.on('data', (b: Buffer) => { out += b.toString('utf-8') })
  child.stderr.on('data', (b: Buffer) => { err = (err + b.toString('utf-8')).slice(-3000) })
  child.on('error', (e) => { clearTimeout(timer); finish({ ok: false, code: 'autosub_failed', detail: e.message }) })
  child.on('close', (code) => {
    clearTimeout(timer)
    if (code !== 0) {
      finish(/usage:/i.test(err)
        ? { ok: false, code: 'autosub_old_toolkit', detail: null }
        : { ok: false, code: 'autosub_failed', detail: err.trim().split(/\r?\n/).slice(-2).join(' | ').slice(0, 400) || `exit ${code}` })
      return
    }
    try {
      const line = out.trim().split(/\r?\n/).filter(Boolean).pop() || ''
      const j = JSON.parse(line) as { words?: { word?: unknown; start?: unknown; end?: unknown }[] }
      const words = (j.words || []).map((w) => ({ word: String(w.word ?? '').trim(), start: Number(w.start), end: Number(w.end) }))
      finish({ ok: true, words })
    } catch { finish({ ok: false, code: 'autosub_failed', detail: 'the recogniser answered something I could not read' }) }
  })
})

let transcriber: Transcriber = defaultTranscriber
/** Tests only. */
export function _setAutoSubDeps(d: { transcribe?: Transcriber } = {}): void { transcriber = d.transcribe || defaultTranscriber }

export type AutoSubResult =
  | { ok: true; lines: SubLine[]; skipped: string[] }
  | AutoSubFail

/** Recognise the speech of every clip and give the subtitles on the TIMELINE clock. */
export async function recogniseTimeline(project: ProjectRow, itemId: string, doc: TimelineDoc, lang: AutoSubLang): Promise<AutoSubResult> {
  if (!(AUTOSUB_LANGS as readonly string[]).includes(lang)) return { ok: false, code: 'autosub_bad_language', detail: null }
  if (!doc.clips.length) return { ok: false, code: 'render_empty', detail: null }
  const total = doc.clips.reduce((n, c) => n + (c.end - c.start), 0)
  if (total > AUTOSUB_MAX_SECONDS) return { ok: false, code: 'autosub_too_long', detail: `${Math.round(total / 60)} minutes` }
  if (videoBusy.has(itemId)) return { ok: false, code: 'video_busy', detail: null }
  videoBusy.add(itemId)
  const tmp = mkdtempSync(join(tmpdir(), 'wbsubs'))
  try {
    const ff = await videoTool()
    if (!ff.ok) return { ok: false, code: ff.code, detail: ff.detail ?? null }
    const offsets = clipOffsets(doc)
    const lines: SubLine[] = []
    const skipped: string[] = []
    for (let i = 0; i < doc.clips.length; i += 1) {
      const c = doc.clips[i]
      const src = resolveMedia(project, c.src)
      if (!src.ok) return { ok: false, code: src.code, detail: src.detail ?? null }
      const p = await probeMedia(ff.path, src.abs)
      if (p === null) return { ok: false, code: 'render_probe_failed', detail: c.src }
      if (!p.audio) { skipped.push(c.src); continue }
      const wav = join(tmp, `clip${i}.wav`)
      const cut = await videoRunTo(ff.path, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(c.start), '-t', String(c.end - c.start), '-i', src.abs, '-vn', '-ac', '1', '-ar', '16000', '-f', 'wav', wav], wav, 10 * 60_000)
      if (!cut.ok) return { ok: false, code: cut.code, detail: cut.detail ?? null }
      const r = await transcriber(wav, lang, AUTOSUB_TIMEOUT_MS)
      if (!r.ok) return r
      for (const l of wordsToSubtitles(r.words)) {
        // The recogniser works on the cut audio, so its times start at 0 at the start of the clip.
        const start = Math.min(offsets[i] + (c.end - c.start), offsets[i] + l.start)
        lines.push({ text: l.text, start: Math.round(start * 1000) / 1000, end: Math.round(Math.min(offsets[i] + (c.end - c.start), offsets[i] + l.end) * 1000) / 1000 })
      }
    }
    lines.sort((a, b) => a.start - b.start)
    return { ok: true, lines: lines.filter((l) => l.end - l.start >= 0.1), skipped }
  } finally {
    videoBusy.delete(itemId)
    try { rmSync(tmp, { recursive: true, force: true }) } catch { /* the system cleans the temporary folder later */ }
  }
}

/** Put the recognised lines on the timeline (in batches: one call takes at most 100 operations); `replace` first clears the typed ones. */
export function applySubtitleLines(doc: TimelineDoc, lines: SubLine[], replace: boolean): { ok: true; doc: TimelineDoc; added: number } | AutoSubFail {
  const base = replace ? doc.subtitles.length : 0
  if (doc.subtitles.length - base + lines.length > TIMELINE_MAX_SUBTITLES) {
    return { ok: false, code: 'timeline_too_many', detail: `${lines.length} recognised lines would not fit (at most ${TIMELINE_MAX_SUBTITLES} subtitles)` }
  }
  const ops: Record<string, unknown>[] = []
  if (replace) for (const s of doc.subtitles) ops.push({ op: 'removeSubtitle', id: s.id })
  for (const l of lines) ops.push({ op: 'addSubtitle', text: l.text, start: l.start, end: l.end })
  let cur = doc
  for (let i = 0; i < ops.length; i += OPS_PER_BATCH) {
    const r = applyTimelineOps(cur, ops.slice(i, i + OPS_PER_BATCH))
    if (!r.ok) return { ok: false, code: r.code, detail: r.detail }
    cur = r.doc
  }
  return { ok: true, doc: cur, added: lines.length }
}
