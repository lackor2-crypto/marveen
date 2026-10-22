/**
 * VOICEOVER for the video timeline (#669 phase C): a written line is read aloud by the LOCAL
 * voice (Piper in the voice toolkit), so the text never leaves the machine. The sound is saved as
 * a plain audio file in the work item's folder and put on the timeline as a voiceover the owner
 * can move, turn down or remove (the render mixes it in, the music ducks under it).
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isVoiceInstalled, voiceOnnxPath, VENV_PY } from './web/routes/voice.js'
import { KNOWN_VOICE_MODELS } from './web/agent-config.js'
import { writeProjectFile } from './project-files.js'
import { itemOutputFolder } from './workbench-assets.js'
import { videoTool } from './workbench-video.js'
import { resolveMedia, probeMedia } from './workbench-video-render.js'
import { VOICEOVER_TEXT_MAX } from './workbench-video-timeline.js'
import type { ProjectRow } from './projects.js'
import type { WorkItemRow } from './workbench.js'

export const VOICEOVER_VOICES: readonly string[] = [...KNOWN_VOICE_MODELS]
export const VOICEOVER_DEFAULT_VOICE = 'hu_HU-imre-medium'
const SYNTH_TIMEOUT_MS = 3 * 60_000

export type TtsFail = {
  ok: false
  code: 'tts_not_installed' | 'tts_bad_voice' | 'tts_text_required' | 'tts_text_too_long' | 'tts_failed' | 'tts_no_ffmpeg' | 'tts_write_failed'
  detail: string | null
}
export type VoiceoverMade = { ok: true; rel: string; name: string; dur: number; text: string }

/** Text -> a wav file's bytes. Replaceable for tests. */
export type Synth = (onnx: string, text: string) => Promise<{ ok: true; wav: Buffer } | { ok: false; detail: string }>

const piperSynth: Synth = (onnx, text) => new Promise((resolve) => {
  const dir = mkdtempSync(join(tmpdir(), 'wbtts'))
  const out = join(dir, 'speech.wav')
  const done = (r: { ok: true; wav: Buffer } | { ok: false; detail: string }): void => {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* temp folder: best effort */ }
    resolve(r)
  }
  let err = ''
  const proc = spawn(VENV_PY, ['-m', 'piper', '-m', onnx, '-f', out], { shell: false })
  const timer = setTimeout(() => proc.kill('SIGKILL'), SYNTH_TIMEOUT_MS)
  proc.stderr.on('data', (d: Buffer) => { err += d.toString() })
  proc.on('error', (e) => { clearTimeout(timer); done({ ok: false, detail: e.message }) })
  proc.on('close', (code) => {
    clearTimeout(timer)
    if (code !== 0) { done({ ok: false, detail: err.slice(-300) || `exit ${code}` }); return }
    try { done({ ok: true, wav: readFileSync(out) }) } catch (e) { done({ ok: false, detail: e instanceof Error ? e.message : String(e) }) }
  })
  proc.stdin.write(text, 'utf-8')
  proc.stdin.end()
})

let synth: Synth = piperSynth
/** Tests only. */
export function _setTtsDeps(d: { synth?: Synth } = {}): void { synth = d.synth || piperSynth }

/** A short ASCII file name part from the first words of the spoken text. */
export function voiceoverFileStem(text: string): string {
  const base = text.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 30).replace(/-+$/g, '')
  return `felolvasas-${base || 'hang'}`
}

export async function makeVoiceover(project: ProjectRow, item: Pick<WorkItemRow, 'folder' | 'container_folder' | 'source_path'>, textRaw: unknown, voiceRaw: unknown): Promise<VoiceoverMade | TtsFail> {
  const text = typeof textRaw === 'string' ? textRaw.replace(/\r/g, '').trim() : ''
  if (!text) return { ok: false, code: 'tts_text_required', detail: null }
  if (text.length > VOICEOVER_TEXT_MAX) return { ok: false, code: 'tts_text_too_long', detail: String(VOICEOVER_TEXT_MAX) }
  const voice = typeof voiceRaw === 'string' && voiceRaw.trim() ? voiceRaw.trim() : VOICEOVER_DEFAULT_VOICE
  if (!VOICEOVER_VOICES.includes(voice)) return { ok: false, code: 'tts_bad_voice', detail: voice }
  if (!isVoiceInstalled()) return { ok: false, code: 'tts_not_installed', detail: null }
  const onnx = voiceOnnxPath(voice)
  if (!onnx) return { ok: false, code: 'tts_not_installed', detail: voice }
  const ff = await videoTool()
  if (!ff.ok) return { ok: false, code: 'tts_no_ffmpeg', detail: null }
  const made = await synth(onnx, text)
  if (!made.ok) return { ok: false, code: 'tts_failed', detail: made.detail }
  const out = writeProjectFile(project, itemOutputFolder(project, item), `${voiceoverFileStem(text)}.wav`, made.wav)
  if (!out.ok) return { ok: false, code: 'tts_write_failed', detail: out.code }
  const abs = resolveMedia(project, out.rel)
  const pr = abs.ok ? await probeMedia(ff.path, abs.abs) : null
  const dur = pr?.duration ?? null
  if (dur === null || !(dur > 0)) return { ok: false, code: 'tts_failed', detail: 'the speech file has no length' }
  return { ok: true, rel: out.rel, name: out.name, dur: Math.round(dur * 1000) / 1000, text }
}
