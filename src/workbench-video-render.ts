/**
 * VIDEO TIMELINE RENDER (v4 spec phase 5): turns a timeline into one MP4.
 *
 * `buildRender` is pure: it only builds the ffmpeg arguments and the subtitle
 * file text, so every rule (cut, blurred 9:16 fill, music ducking under speech,
 * picture overlays) is testable without ffmpeg. `renderTimeline` runs it.
 *
 * Nothing is overwritten: the result is a NEW mp4 next to the timeline (the same
 * free-name search as the trim), and ffmpeg runs with `-n`. A failed run removes
 * its half-written output. Subtitles are burnt in through a generated ASS file
 * (libass); when this ffmpeg has no libass the owner gets a plain sentence and
 * the render does not silently drop the subtitles.
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { ProjectRow } from './projects.js'
import { resolveLifePath } from './life-explorer.js'
import { getDb } from './db.js'
import { baseNameForNextVersion } from './workbench-edit.js'
import { getWorkItem } from './workbench.js'
import { itemOutputFolder } from './workbench-assets.js'
import { videoTool, videoTarget, videoRunTo, videoBusy, VIDEO_TRIM_TIMEOUT_MS, type VideoFail } from './workbench-video.js'
import { ASPECT_SIZE, timelineDuration, type TimelineDoc } from './workbench-video-timeline.js'

export const RENDER_FPS = 30
export const RENDER_TIMEOUT_MS = 4 * VIDEO_TRIM_TIMEOUT_MS

export type RenderFailCode =
  | 'render_empty' | 'render_clip_beyond_end' | 'render_source_missing' | 'render_source_outside' | 'render_no_subtitle_filter'
  | 'render_probe_failed'

export type RenderFail = { ok: false; code: RenderFailCode; detail?: string | null }

/** What `buildRender` needs to know about the outside world (all of it injected, so it stays pure). */
export interface RenderInputs {
  /** Absolute path of each media file used (key = the `src` in the timeline). */
  abs: Record<string, string>
  /** Whether each source video has an audio track. */
  hasAudio: Record<string, boolean>
  /** Absolute path of the ASS file, when there are subtitles. */
  assPath: string | null
  out: string
}

const fnum = (n: number): string => (Math.round(n * 1000) / 1000).toString()

/** ASS time: h:mm:ss.cc */
function assTime(sec: number): string {
  const cs = Math.round(sec * 100)
  const h = Math.floor(cs / 360000), m = Math.floor((cs % 360000) / 6000), s = Math.floor((cs % 6000) / 100), c = cs % 100
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`
}

/** The text of the ASS subtitle file for a timeline. */
export function buildAss(doc: TimelineDoc): string {
  const { width: W, height: H } = ASPECT_SIZE[doc.aspect]
  const size = Math.round(H / (doc.aspect === '9:16' ? 30 : 20))
  const margin = Math.round(H * (doc.aspect === '9:16' ? 0.14 : 0.06))
  const lines = [
    '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${W}`, `PlayResY: ${H}`, 'WrapStyle: 0', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,DejaVu Sans,${size},&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,${Math.max(2, Math.round(size / 12))},1,2,${Math.round(W * 0.06)},${Math.round(W * 0.06)},${margin},1`,
    '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ]
  for (const s of doc.subtitles) {
    const text = s.text.replace(/\\/g, '/').replace(/[{}]/g, '').replace(/\n/g, '\\N')
    lines.push(`Dialogue: 0,${assTime(s.start)},${assTime(s.end)},Default,,0,0,0,,${text}`)
  }
  return lines.join('\n') + '\n'
}

/** The ffmpeg arguments for a timeline. Throws nothing; the caller checks the inputs first. */
export function buildRender(doc: TimelineDoc, inp: RenderInputs): string[] {
  const { width: W, height: H } = ASPECT_SIZE[doc.aspect]
  const total = timelineDuration(doc)
  const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-n']
  const f: string[] = []
  let idx = 0

  const clipIdx: number[] = []
  for (const c of doc.clips) { args.push('-i', inp.abs[c.src]); clipIdx.push(idx++) }
  let musicIdx = -1
  if (doc.music) { args.push('-stream_loop', '-1', '-i', inp.abs[doc.music.src]); musicIdx = idx++ }
  const ovIdx: number[] = []
  for (const o of doc.overlays) { args.push('-loop', '1', '-framerate', String(RENDER_FPS), '-t', fnum(total), '-i', inp.abs[o.src]); ovIdx.push(idx++) }

  // Every clip: cut, fill the frame (the picture sits on a blurred copy of itself, so a
  // 16:9 clip in a 9:16 video has no black bars), same frame rate and sound format.
  const vl: string[] = []
  doc.clips.forEach((c, i) => {
    const n = clipIdx[i]
    f.push(
      `[${n}:v]trim=start=${fnum(c.start)}:end=${fnum(c.end)},setpts=PTS-STARTPTS,fps=${RENDER_FPS},split=2[bg${i}][fg${i}]`,
      `[bg${i}]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=24:3[bb${i}]`,
      `[fg${i}]scale=${W}:${H}:force_original_aspect_ratio=decrease[ff${i}]`,
      `[bb${i}][ff${i}]overlay=(W-w)/2:(H-h)/2,setsar=1,format=yuv420p[v${i}]`,
    )
    if (inp.hasAudio[c.src]) {
      f.push(`[${n}:a]atrim=start=${fnum(c.start)}:end=${fnum(c.end)},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,volume=${fnum(doc.clip_volume)}[a${i}]`)
    } else {
      f.push(`anullsrc=r=48000:cl=stereo,atrim=0:${fnum(c.end - c.start)},asetpts=PTS-STARTPTS[a${i}]`)
    }
    vl.push(`[v${i}][a${i}]`)
  })
  f.push(`${vl.join('')}concat=n=${doc.clips.length}:v=1:a=1[vc][ac]`)

  // Picture overlays, each only between its start and end.
  let v = 'vc'
  doc.overlays.forEach((o, k) => {
    f.push(
      `[${ovIdx[k]}:v]scale=${Math.max(2, Math.round(W * o.width))}:-1,format=rgba,colorchannelmixer=aa=${fnum(o.opacity)}[ov${k}]`,
      `[${v}][ov${k}]overlay=x=${Math.round(W * o.x)}:y=${Math.round(H * o.y)}:enable='between(t,${fnum(o.start)},${fnum(o.end)})':shortest=1[vo${k}]`,
    )
    v = `vo${k}`
  })

  if (inp.assPath) {
    f.push(`[${v}]ass=filename='${inp.assPath}'[vs]`)
    v = 'vs'
  }

  // Music: looped, cut to the length of the video, lowered while the clips speak.
  let a = 'ac'
  if (doc.music && musicIdx >= 0) {
    f.push(`[${musicIdx}:a]atrim=0:${fnum(total)},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,volume=${fnum(doc.music.volume)}[mus]`)
    if (doc.music.duck) {
      f.push(
        '[ac]asplit=2[ac1][ac2]',
        '[mus][ac1]sidechaincompress=threshold=0.04:ratio=10:attack=20:release=500[md]',
        '[ac2][md]amix=inputs=2:duration=first:normalize=0[am]',
      )
    } else {
      f.push('[ac][mus]amix=inputs=2:duration=first:normalize=0[am]')
    }
    a = 'am'
  }

  args.push(
    '-filter_complex', f.join(';'),
    '-map', `[${v}]`, '-map', `[${a}]`,
    '-r', String(RENDER_FPS),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart',
    inp.out,
  )
  return args
}

// ---- running it ---------------------------------------------------------------------

export interface MediaProbe { audio: boolean; duration: number | null }
type Probe = (ffmpegPath: string, abs: string) => Promise<MediaProbe | null>
type Filters = (ffmpegPath: string) => Promise<boolean | null>

const ffprobePath = (ffmpegPath: string): string => join(dirname(ffmpegPath), basename(ffmpegPath).replace(/ffmpeg/i, 'ffprobe'))

const defaultProbe: Probe = (ffmpegPath, abs) => new Promise((resolve) => {
  execFile(ffprobePath(ffmpegPath), ['-v', 'error', '-show_entries', 'stream=codec_type:format=duration', '-of', 'json', abs],
    { timeout: 30_000, windowsHide: true }, (err, stdout) => {
      if (err) { resolve(null); return }
      try {
        const j = JSON.parse(stdout) as { streams?: { codec_type?: string }[]; format?: { duration?: string } }
        const d = Number(j.format?.duration)
        resolve({ audio: (j.streams || []).some((x) => x.codec_type === 'audio'), duration: Number.isFinite(d) && d > 0 ? d : null })
      } catch { resolve(null) }
    })
})

const defaultFilters: Filters = (ffmpegPath) => new Promise((resolve) => {
  execFile(ffmpegPath, ['-hide_banner', '-filters'], { timeout: 30_000, windowsHide: true }, (err, stdout) => {
    resolve(err ? null : /\bass\b/.test(stdout) && /\bsidechaincompress\b/.test(stdout))
  })
})

let probe: Probe = defaultProbe
let filters: Filters = defaultFilters
/** Tests only. */
/** What ffprobe says about a file (audio stream? length?); null when it cannot be read. */
export function probeMedia(ffmpegPath: string, abs: string): Promise<MediaProbe | null> {
  return probe(ffmpegPath, abs)
}

export function _setRenderDeps(d: { probe?: Probe; filters?: Filters } = {}): void {
  probe = d.probe || defaultProbe
  filters = d.filters || defaultFilters
}

export type RenderResult =
  | { ok: true; file: { rel: string; name: string; bytes: number }; seconds: number }
  | VideoFail | RenderFail

/** Resolves a media `src` to a real file INSIDE the project folder. */
export function resolveMedia(project: ProjectRow, src: string): { ok: true; abs: string } | RenderFail {
  const folder = (project.folder_path || '').replace(/\/+$/, '')
  if (!folder || !(src === folder || src.startsWith(folder + '/'))) return { ok: false, code: 'render_source_outside', detail: src }
  const abs = resolveLifePath(src)
  if (!abs || !existsSync(abs)) return { ok: false, code: 'render_source_missing', detail: src }
  return { ok: true, abs }
}

export async function renderTimeline(project: ProjectRow, itemId: string, title: string, doc: TimelineDoc): Promise<RenderResult> {
  if (!doc.clips.length) return { ok: false, code: 'render_empty' }
  if (videoBusy.has(itemId)) return { ok: false, code: 'video_busy' }
  videoBusy.add(itemId)
  let tmp: string | null = null
  try {
    const ff = await videoTool()
    if (!ff.ok) return ff
    const abs: Record<string, string> = {}
    const srcs = new Set<string>([...doc.clips.map((c) => c.src), ...doc.overlays.map((o) => o.src), ...(doc.music ? [doc.music.src] : [])])
    for (const s of srcs) {
      const r = resolveMedia(project, s)
      if (!r.ok) return r
      abs[s] = r.abs
    }
    const hasAudio: Record<string, boolean> = {}
    const durations: Record<string, number | null> = {}
    for (const c of doc.clips) {
      if (!(c.src in hasAudio)) {
        const p = await probe(ff.path, abs[c.src])
        if (p === null) return { ok: false, code: 'render_probe_failed', detail: c.src }
        hasAudio[c.src] = p.audio
        durations[c.src] = p.duration
      }
      // A cut that runs past the end of its file would silently give a shorter video: say so instead.
      const len = durations[c.src]
      if (len !== null && c.end > len + 0.5) {
        return { ok: false, code: 'render_clip_beyond_end', detail: `${c.src}: the cut ends at ${c.end}s but the file is only ${Math.round(len * 10) / 10}s long` }
      }
    }
    if (doc.subtitles.length || doc.music?.duck) {
      const ok = await filters(ff.path)
      if (ok === false && doc.subtitles.length) return { ok: false, code: 'render_no_subtitle_filter' }
    }
    let assPath: string | null = null
    if (doc.subtitles.length) {
      tmp = mkdtempSync(join(tmpdir(), 'wbsub'))
      assPath = join(tmp, 'subs.ass')
      writeFileSync(assPath, buildAss(doc), 'utf-8')
    }
    const stem = baseNameForNextVersion(title || 'video').replace(/\.[^.]+$/, '') || 'video'
    // #496: the video goes to the work item (its own folder, else beside the timeline), never beside its first clip --
    // that may be the project root or another item's folder.
    const item = getWorkItem(itemId)
    const out = videoTarget(project, (item && itemOutputFolder(project, item)) ?? '', `${stem}.mp4`)
    if (!out.ok) return out
    const args = buildRender(doc, { abs, hasAudio, assPath, out: out.abs })
    const r = await videoRunTo(ff.path, args, out.abs, RENDER_TIMEOUT_MS)
    if (!r.ok) return r
    return { ok: true, file: { rel: out.rel, name: out.name, bytes: r.bytes }, seconds: timelineDuration(doc) }
  } finally {
    videoBusy.delete(itemId)
    if (tmp) { try { rmSync(tmp, { recursive: true, force: true }) } catch { /* temp dir; the OS cleans it */ } }
  }
}

export interface LastRender { rel: string; name: string; seconds: number; version_id: string; version_no: number }

/** The newest version of the work item that has a rendered video recorded on it. */
export function lastRenderOf(itemId: string): LastRender | null {
  const rows = getDb().prepare('SELECT id, version_no, metadata_json FROM work_item_versions WHERE work_item_id = ? AND metadata_json IS NOT NULL ORDER BY version_no DESC')
    .all(itemId) as { id: string; version_no: number; metadata_json: string }[]
  for (const r of rows) {
    try {
      const m = JSON.parse(r.metadata_json) as { render?: { rel?: unknown; name?: unknown; seconds?: unknown } }
      const x = m.render
      if (x && typeof x.rel === 'string' && typeof x.name === 'string') {
        return { rel: x.rel, name: x.name, seconds: Number(x.seconds) || 0, version_id: r.id, version_no: r.version_no }
      }
    } catch { /* a version with unreadable metadata is skipped, not fatal */ }
  }
  return null
}

// ---- helpers for the editor and the agent -------------------------------------------

export interface MediaFile { path: string; name: string; kind: 'video' | 'audio' | 'image'; bytes: number }
const MEDIA_KIND: [RegExp, MediaFile['kind']][] = [
  [/\.(mp4|mov|m4v|webm|mkv|avi)$/i, 'video'], [/\.(mp3|m4a|wav|ogg|aac|flac)$/i, 'audio'], [/\.(png|jpe?g|gif|webp)$/i, 'image'],
]
export const MEDIA_MAX_DEPTH = 4
export const MEDIA_MAX_FILES = 400

/** The video, audio and picture files in the project folder (a bounded walk), for the editor's pickers. */
export function listProjectMedia(project: ProjectRow): { ok: true; files: MediaFile[]; truncated: boolean } | RenderFail {
  const folder = (project.folder_path || '').replace(/\/+$/, '')
  const base = folder ? resolveLifePath(folder) : null
  if (!folder || !base || !existsSync(base)) return { ok: false, code: 'render_source_missing', detail: folder || null }
  const files: MediaFile[] = []
  let truncated = false
  const walk = (abs: string, rel: string, depth: number): void => {
    let entries: import('node:fs').Dirent[]
    try { entries = readdirSync(abs, { withFileTypes: true }) } catch { return }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (files.length >= MEDIA_MAX_FILES) { truncated = true; return }
      if (e.name.startsWith('.') || e.name === 'node_modules') continue
      if (e.isDirectory()) { if (depth < MEDIA_MAX_DEPTH) walk(join(abs, e.name), `${rel}/${e.name}`, depth + 1); continue }
      const kind = MEDIA_KIND.find(([re]) => re.test(e.name))?.[1]
      if (!kind) continue
      let bytes = 0
      try { bytes = statSync(join(abs, e.name)).size } catch { /* listed without a size */ }
      files.push({ path: `${rel}/${e.name}`, name: e.name, kind, bytes })
    }
  }
  walk(base, folder, 0)
  return { ok: true, files, truncated }
}

/**
 * An `addClip` without `end` runs to the end of the file: the length is read from
 * the file here (the pure operations cannot), so the editor and the agent never have
 * to guess a duration.
 */
export async function fillClipEnds(project: ProjectRow, ops: unknown): Promise<{ ok: true; ops: unknown } | VideoFail | RenderFail> {
  if (!Array.isArray(ops)) return { ok: true, ops }
  const out: unknown[] = []
  for (const raw of ops) {
    const o = raw as Record<string, unknown> | null
    if (!o || typeof o !== 'object' || o.op !== 'addClip' || (o.end !== undefined && o.end !== null && o.end !== '') || typeof o.src !== 'string') { out.push(raw); continue }
    const r = resolveMedia(project, o.src)
    if (!r.ok) return r
    const ff = await videoTool()
    if (!ff.ok) return ff
    const p = await probe(ff.path, r.abs)
    if (p === null || p.duration === null) return { ok: false, code: 'render_probe_failed', detail: o.src }
    out.push({ ...o, end: Math.floor(p.duration * 1000) / 1000 })
  }
  return { ok: true, ops: out }
}
