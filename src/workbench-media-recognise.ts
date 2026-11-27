// #986: one recording -> its transcript (FFmpeg takes the sound out, the local recogniser writes down what is said).
// Loaded only when a recording is actually transcribed: the video modules import each other in a circle, and pulling
// them in with the context file left the render timeout NaN (#789).
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ol } from './owner-lang.js'
import { videoTool, videoRunTo } from './workbench-video.js'
import { probeMedia } from './workbench-video-render.js'
import { transcribeWav, wordsToSubtitles, type SubWord } from './workbench-video-autosub.js'
import type { SpeechResult } from './workbench-media-transcript.js'

const MIN_TIMEOUT_MS = 45 * 60_000
/** A paragraph of the transcript covers about this many seconds. */
const PARAGRAPH_SECONDS = 30

function clock(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0')
  const ss = String(s % 60).padStart(2, '0')
  return s >= 3600 ? `${Math.floor(s / 3600)}:${mm}:${ss}` : `${mm}:${ss}`
}

/** Words with times -> paragraphs that start with their time, so a sentence can be found in the recording. */
export function transcriptText(words: SubWord[]): string {
  const out: string[] = []
  let start = 0
  let cur: string[] = []
  for (const line of wordsToSubtitles(words)) {
    if (cur.length && line.start - start >= PARAGRAPH_SECONDS) { out.push(`[${clock(start)}] ${cur.join(' ')}`); cur = [] }
    if (!cur.length) start = line.start
    cur.push(line.text)
  }
  if (cur.length) out.push(`[${clock(start)}] ${cur.join(' ')}`)
  return out.join('\n')
}

export async function recognise(abs: string): Promise<SpeechResult> {
  const ff = await videoTool()
  if (!ff.ok) return { ok: false, final: false, reason: ol('a hang kiolvasásához szükséges FFmpeg program nem érhető el', 'the FFmpeg program needed to read the sound is not available') }
  const media = await probeMedia(ff.path, abs)
  if (media === null) return { ok: false, final: false, reason: ol('a felvételt nem sikerült megnyitni', 'the recording could not be opened') }
  if (!media.audio) return { ok: false, final: true, reason: ol('a fájlban nincs hang', 'the file has no sound') }
  const timeout = Math.max(MIN_TIMEOUT_MS, (media.duration || 0) * 10_000)
  const tmp = await mkdtemp(join(tmpdir(), 'wbspeech'))
  try {
    const wav = join(tmp, 'sound.wav')
    const cut = await videoRunTo(ff.path, ['-hide_banner', '-loglevel', 'error', '-y', '-i', abs, '-vn', '-ac', '1', '-ar', '16000', '-f', 'wav', wav], wav, timeout)
    if (!cut.ok) return { ok: false, final: false, reason: ol('a hangsávot nem sikerült kivenni a fájlból', 'the sound could not be taken out of the file') + (cut.detail ? ` (${cut.detail})` : '') }
    const heard = await transcribeWav(wav, 'auto', timeout, { background: true })
    if (!heard.ok) return { ok: false, final: false, reason: ol('a beszédfelismerés nem sikerült', 'the speech recognition did not work') + ` (${heard.detail || heard.code})` }
    const text = transcriptText(heard.words)
    return text ? { ok: true, text } : { ok: false, final: true, reason: ol('a felvételen nem hallható érthető beszéd', 'no understandable speech is heard in the recording') }
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => { /* the system cleans the temporary folder later */ })
  }
}
