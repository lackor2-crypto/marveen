/**
 * BACKGROUND REMOVAL for a clip of the video timeline (#669 phase C): the subject (a person, mostly) stays, the
 * background behind it becomes a flat colour or a blurred copy of the picture. It runs on the owner's machine
 * (rembg + onnxruntime with the small u2netp model, installed with the voice toolkit), so the video never leaves it.
 *
 * The result is a NEW video file in the work item's folder holding the clip's stretch (with its sound), and the
 * clip on the timeline is switched to it (`replaceClipSource`), so undo and the versions work like any other edit.
 */
import { basename, join } from 'node:path'
import { PROJECT_ROOT } from './config.js'
import { VENV_PY, cutoutModelsDir, isCutoutInstalled } from './web/routes/voice.js'
export { isCutoutInstalled }
import { itemOutputFolder } from './workbench-assets.js'
import { videoTool, videoTarget, videoRunTo, videoBusy, type VideoFail } from './workbench-video.js'
import { resolveMedia, probeMedia, type RenderFail } from './workbench-video-render.js'
import type { TimelineDoc } from './workbench-video-timeline.js'
import type { ProjectRow } from './projects.js'
import type { WorkItemRow } from './workbench.js'

export const CUTOUT_MODES = ['color', 'blur'] as const
export type CutoutMode = (typeof CUTOUT_MODES)[number]
/** The script handles this much per run (about two seconds of machine time per second of picture on a busy machine). */
export const CUTOUT_MAX_SECONDS = 30
export const CUTOUT_DEFAULT_COLOR = '00b140'
export const CUTOUT_TIMEOUT_MS = 45 * 60_000
const MODEL = 'u2netp'
const SCRIPT = join(PROJECT_ROOT, 'scripts', 'voice', 'cutout.py')

export type CutoutFail = {
  ok: false
  code: 'cutout_not_installed' | 'cutout_bad_mode' | 'cutout_bad_color' | 'cutout_too_long' | 'cutout_clip_missing' | 'cutout_failed' | 'cutout_no_ffmpeg'
  detail: string | null
}
export type CutoutMade = { ok: true; clipId: string; rel: string; name: string; dur: number; mode: CutoutMode }

const stemOf = (src: string): string => basename(src).replace(/\.[^.]+$/, '').slice(0, 60) || 'video'

/** Progress lines the script writes to stderr ("progress=0.37"): the last one in a chunk. */
export function cutoutProgress(chunk: string): number | null {
  let last: number | null = null
  for (const m of chunk.matchAll(/^progress=([0-9.]+)\s*$/gm)) last = Number(m[1])
  return last !== null && Number.isFinite(last) ? last : null
}

export async function cutoutClip(
  project: ProjectRow, item: Pick<WorkItemRow, 'id' | 'folder' | 'container_folder' | 'source_path'>, doc: TimelineDoc,
  opts: { clipId: unknown; mode?: unknown; color?: unknown }, onProgress?: (fraction: number) => void, dryRun = false,
): Promise<CutoutMade | CutoutFail | RenderFail | VideoFail> {
  const mode = (opts.mode === undefined || opts.mode === '' ? 'color' : opts.mode) as CutoutMode
  if (!(CUTOUT_MODES as readonly unknown[]).includes(mode)) return { ok: false, code: 'cutout_bad_mode', detail: String(opts.mode) }
  const colorRaw = typeof opts.color === 'string' && opts.color.trim() ? opts.color.trim().replace(/^#/, '').toLowerCase() : CUTOUT_DEFAULT_COLOR
  if (!/^[0-9a-f]{6}$/.test(colorRaw)) return { ok: false, code: 'cutout_bad_color', detail: String(opts.color) }
  const clip = doc.clips.find((c) => c.id === opts.clipId)
  if (!clip) return { ok: false, code: 'cutout_clip_missing', detail: String(opts.clipId) }
  const len = Math.round((clip.end - clip.start) * 1000) / 1000
  if (len > CUTOUT_MAX_SECONDS) return { ok: false, code: 'cutout_too_long', detail: String(CUTOUT_MAX_SECONDS) }
  if (!isCutoutInstalled()) return { ok: false, code: 'cutout_not_installed', detail: null }
  const ff = await videoTool()
  if (!ff.ok) return { ok: false, code: 'cutout_no_ffmpeg', detail: null }
  const src = resolveMedia(project, clip.src)
  if (!src.ok) return src
  if (videoBusy.has(item.id)) return { ok: false, code: 'video_busy' }
  // The checks above are the quick refusals; the editor asks for them first, so it can answer at once and only then start the slow job.
  if (dryRun) return { ok: true, clipId: clip.id, rel: '', name: '', dur: len, mode }
  videoBusy.add(item.id)
  try {
    const out = videoTarget(project, itemOutputFolder(project, item) ?? '', `${stemOf(clip.src)} (${mode === 'blur' ? 'elmosott hatter' : 'hatter nelkul'}).mp4`)
    if (!out.ok) return out
    const args = [SCRIPT, '--in', src.abs, '--out', out.abs, '--ss', String(clip.start), '--t', String(len), '--mode', mode, '--color', colorRaw, '--model', MODEL, '--models', cutoutModelsDir()]
    const tap = onProgress ? (chunk: string): void => { const f = cutoutProgress(chunk); if (f !== null) onProgress(f) } : undefined
    const r = await videoRunTo(VENV_PY, args, out.abs, CUTOUT_TIMEOUT_MS, tap)
    if (!r.ok) return r.code === 'video_failed' ? { ok: false, code: 'cutout_failed', detail: r.detail ?? null } : r
    const pr = await probeMedia(ff.path, out.abs)
    const dur = pr?.duration && pr.duration > 0 ? Math.round(pr.duration * 1000) / 1000 : len
    return { ok: true, clipId: clip.id, rel: out.rel, name: out.name, dur, mode }
  } finally {
    videoBusy.delete(item.id)
  }
}
