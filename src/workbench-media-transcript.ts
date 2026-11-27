/**
 * #986 (Boss TG 7719): what is SAID in an audio file, or in the sound of a video, is read out into the context file of
 * the work item. The LOCAL recogniser (faster-whisper of the voice toolkit, the one the video subtitles use) does it, so
 * the recording never leaves the machine. A recording takes minutes: one at a time, in the background, at a low process
 * priority, newest file first. No length or size limit of its own.
 */
import { logger } from './logger.js'
import { isVoiceInstalled } from './web/routes/voice.js'
import { liveTranscript, setLiveTranscript, setRecogniserProbe } from './workbench-media-state.js'

/** `final`: the answer depends only on the content of the file (kept); otherwise it is tried again after a restart. */
export type SpeechResult = { ok: true; text: string } | { ok: false; reason: string; final: boolean }

/** The real recogniser is loaded at first use (see workbench-media-recognise.ts). */
const recognise = async (abs: string): Promise<SpeechResult> => (await import('./workbench-media-recognise.js')).recognise(abs)

let deps: { installed: () => boolean; recognise: (abs: string) => Promise<SpeechResult> } = { installed: isVoiceInstalled, recognise }
/** Tests only. */
export function _setSpeechDeps(d: Partial<typeof deps> = {}): void { deps = { installed: d.installed || isVoiceInstalled, recognise: d.recognise || recognise } }
export function speechInstalled(): boolean { return deps.installed() }
// The materials list asks through the light state module whether a recording can be transcribed here.
setRecogniserProbe(speechInstalled)

/** `finish` gets a result to keep, or null when the try failed and nothing is to be stored. */
interface Waiter { finish: (result: SpeechResult | null) => Promise<void> }
interface Job { abs: string; stamp: string; mtimeMs: number; waiters: Map<string, Waiter> }
const queue = new Map<string, Job>()
let working: Job | null = null
let drained: Promise<void> = Promise.resolve()

/** Puts one recording in line. `key` names who waits for it (item + file): asking again does not queue it twice. */
export function queueTranscript(file: { abs: string; size: number; mtimeMs: number }, key: string, finish: Waiter['finish']): boolean {
  const stamp = `${file.size}:${Math.floor(file.mtimeMs)}`
  const known = liveTranscript(file.abs)
  if (known?.state === 'failed' && known.stamp === stamp) return false
  if (working && working.abs === file.abs && working.stamp === stamp) { working.waiters.set(key, { finish }); return true }
  let job = queue.get(file.abs)
  if (!job || job.stamp !== stamp) {
    job = { abs: file.abs, stamp, mtimeMs: file.mtimeMs, waiters: job?.waiters ?? new Map() }
    queue.set(file.abs, job)
  }
  job.waiters.set(key, { finish })
  if (!working || working.abs !== file.abs) setLiveTranscript(file.abs, { state: 'waiting', stamp })
  if (!working) drained = pump()
  return true
}

async function pump(): Promise<void> {
  for (;;) {
    const job = [...queue.values()].sort((a, b) => b.mtimeMs - a.mtimeMs)[0]
    if (!job) return
    queue.delete(job.abs)
    working = job
    setLiveTranscript(job.abs, { state: 'running', stamp: job.stamp })
    let result: SpeechResult
    try { result = await deps.recognise(job.abs) }
    catch (err) { result = { ok: false, final: false, reason: String(err instanceof Error ? err.message : err).slice(0, 300) } }
    const keep = result.ok || result.final
    if (!result.ok) logger.warn({ abs: job.abs, reason: result.reason }, '[media-transcript] a recording was not read out')
    setLiveTranscript(job.abs, keep ? null : { state: 'failed', reason: result.ok ? '' : result.reason, stamp: job.stamp })
    for (const w of job.waiters.values()) {
      try { await w.finish(keep ? result : null) } catch (err) { logger.warn({ abs: job.abs, err: String(err) }, '[media-transcript] the transcript could not be saved') }
    }
    working = null
    // The same file changed while it was being read: its newer content is already in line.
    const again = queue.get(job.abs)
    if (again) setLiveTranscript(job.abs, { state: 'waiting', stamp: again.stamp })
  }
}

/** Tests only: resolves when the line is empty. */
export function _transcriptsIdle(): Promise<void> { return drained }
