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
import { finishedFolderFor } from './project-files.js'
import { videoTool, videoTarget, videoRunTo, videoBusy, VIDEO_TRIM_TIMEOUT_MS, type VideoFail } from './workbench-video.js'
import { ASPECT_SIZE, isVideoOverlaySrc, SUBTITLE_LOOKS, TIMELINE_MIN_CLIP, clipLen, effectiveTransition, timelineDuration, type SubtitleLook, type SubtitlePos, type TimelineDoc } from './workbench-video-timeline.js'

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

/** Colours are ASS &HAABBGGRR; the looks differ in size, weight, colour and box. */
const ASS_LOOKS: Record<SubtitleLook, { scale: number; bold: number; primary: string; outline: string; box: boolean }> = {
  classic: { scale: 1, bold: -1, primary: '&H00FFFFFF', outline: '&H00000000', box: false },
  bold: { scale: 1.3, bold: -1, primary: '&H00FFFFFF', outline: '&H00000000', box: false },
  yellow: { scale: 1.1, bold: -1, primary: '&H0000FFFF', outline: '&H00000000', box: false },
  box: { scale: 1, bold: -1, primary: '&H00FFFFFF', outline: '&HB4000000', box: true },
  title: { scale: 1.8, bold: -1, primary: '&H00FFFFFF', outline: '&H00000000', box: false },
}
const ASS_ALIGN: Record<SubtitlePos, number> = { bottom: 2, middle: 5, top: 8 }

/** The text of the ASS subtitle file for a timeline. */
export function buildAss(doc: TimelineDoc): string {
  const { width: W, height: H } = ASPECT_SIZE[doc.aspect]
  const size = Math.round(H / (doc.aspect === '9:16' ? 30 : 20))
  const margin = Math.round(H * (doc.aspect === '9:16' ? 0.14 : 0.06))
  const styleLine = (name: string, look: SubtitleLook): string => {
    const l = ASS_LOOKS[look]
    const sz = Math.round(size * l.scale)
    const outline = l.box ? Math.max(6, Math.round(sz / 4)) : Math.max(2, Math.round(sz / 12))
    return `Style: ${name},DejaVu Sans,${sz},${l.primary},${l.primary},${l.outline},&H80000000,${l.bold},0,0,0,100,100,0,0,${l.box ? 3 : 1},${outline},${l.box ? 0 : 1},2,${Math.round(W * 0.06)},${Math.round(W * 0.06)},${margin},1`
  }
  const lines = [
    '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${W}`, `PlayResY: ${H}`, 'WrapStyle: 0', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    styleLine('Default', 'classic'),
    ...SUBTITLE_LOOKS.filter((k) => k !== 'classic').map((k) => styleLine(k, k)),
    '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ]
  for (const s of doc.subtitles) {
    const text = s.text.replace(/\\/g, '/').replace(/[{}]/g, '').replace(/\n/g, '\\N')
    const pos = s.pos ?? 'bottom'
    const y0 = pos === 'bottom' ? H - margin : pos === 'top' ? margin : Math.round(H / 2)
    const tags: string[] = s.pos ? [`\\an${ASS_ALIGN[pos]}`] : []
    if (s.anim === 'fade') tags.push('\\fad(250,250)')
    else if (s.anim === 'pop') tags.push('\\fscx70\\fscy70\\t(0,220,\\fscx100\\fscy100)')
    else if (s.anim === 'slideup') tags.push(`\\move(${Math.round(W / 2)},${y0 + Math.round(H * 0.04)},${Math.round(W / 2)},${y0},0,250)`)
    lines.push(`Dialogue: 0,${assTime(s.start)},${assTime(s.end)},${s.look ? s.look : 'Default'},,0,0,0,,${tags.length ? `{${tags.join('')}}` : ''}${text}`)
  }
  return lines.join('\n') + '\n'
}

/**
 * Joins the normalised clips `[v0][a0]`, `[v1][a1]`, ... into `[outV][outA]`. Without a transition this is
 * the plain `concat` (unchanged since the first render). With transitions it chains pairs: a hard cut is a
 * two-input concat, a transition is `xfade` (picture) plus `acrossfade` (sound), which overlap the two clips.
 */
export function joinClips(doc: TimelineDoc, outV: string, outA: string): string[] {
  const n = doc.clips.length
  const trs = doc.clips.map((_, i) => effectiveTransition(doc, i))
  if (!trs.some(Boolean)) {
    return [`${doc.clips.map((_, i) => `[v${i}][a${i}]`).join('')}concat=n=${n}:v=1:a=1[${outV}][${outA}]`]
  }
  const out: string[] = []
  let accV = 'v0', accA = 'a0'
  let accLen = clipLen(doc.clips[0])
  for (let i = 0; i < n - 1; i++) {
    const last = i === n - 2
    const nv = last ? outV : `jv${i}`, na = last ? outA : `ja${i}`
    const len = clipLen(doc.clips[i + 1])
    const t = trs[i]
    if (t) {
      out.push(
        `[${accV}][v${i + 1}]xfade=transition=${t.type}:duration=${fnum(t.duration)}:offset=${fnum(accLen - t.duration)}[${nv}]`,
        `[${accA}][a${i + 1}]acrossfade=d=${fnum(t.duration)}:c1=tri:c2=tri[${na}]`,
      )
      accLen += len - t.duration
    } else {
      // concat stamps its output with a 1/1000000 timebase; xfade needs both inputs in the clips' own.
      out.push(
        `[${accV}][${accA}][v${i + 1}][a${i + 1}]concat=n=2:v=1:a=1[jr${i}][${na}]`,
        `[jr${i}]settb=1/${RENDER_FPS}[${nv}]`,
      )
      accLen += len
    }
    accV = nv; accA = na
  }
  return out
}

/** The colour each overlay key removes (core `colorkey` filter: colour, similarity, blend). */
const OVERLAY_KEY_HEX: Record<string, string> = { green: '0x00FF00', blue: '0x0000FF', white: '0xFFFFFF', black: '0x000000' }

/** The ffmpeg filter of each clip look (core libavfilter only, so it runs on every ffmpeg build). Empty for "none". */
export const LOOK_FILTERS: Record<string, string> = {
  bw: 'hue=s=0',
  warm: 'colorbalance=rs=0.12:gs=0.03:bs=-0.12:rm=0.08:bm=-0.08,eq=saturation=1.1',
  cool: 'colorbalance=rs=-0.12:bs=0.12:rm=-0.08:bm=0.08,eq=saturation=1.05',
  vivid: 'eq=saturation=1.5:contrast=1.1',
  fade: 'eq=contrast=0.85:brightness=0.05:saturation=0.8',
  vintage: 'curves=preset=vintage',
}
export function lookFilter(look: string | undefined): string {
  return look && LOOK_FILTERS[look] ? `,${LOOK_FILTERS[look]}` : ''
}

/** The `atempo` steps for a speed (one `atempo` only takes 0.5 to 2, so a bigger change is chained). */
export function atempo(speed: number): string {
  if (speed === 1) return ''
  const steps: number[] = []
  let r = speed
  while (r > 2) { steps.push(2); r /= 2 }
  while (r < 0.5) { steps.push(0.5); r /= 0.5 }
  steps.push(r)
  return steps.map((x) => `,atempo=${fnum(x)}`).join('')
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
  for (const o of doc.overlays) {
    if (isVideoOverlaySrc(o.src)) args.push('-i', inp.abs[o.src])
    else args.push('-loop', '1', '-framerate', String(RENDER_FPS), '-t', fnum(total), '-i', inp.abs[o.src])
    ovIdx.push(idx++)
  }

  // Every clip: cut, fill the frame (the picture sits on a blurred copy of itself, so a
  // 16:9 clip in a 9:16 video has no black bars), same frame rate and sound format.
  doc.clips.forEach((c, i) => {
    const n = clipIdx[i]
    f.push(
      `[${n}:v]trim=start=${fnum(c.start)}:end=${fnum(c.end)},setpts=(PTS-STARTPTS)/${fnum(c.speed ?? 1)},fps=${RENDER_FPS}${c.stab ? ',deshake' : ''}${lookFilter(c.look)},split=2[bg${i}][fg${i}]`,
      `[bg${i}]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=24:3[bb${i}]`,
      `[fg${i}]scale=${W}:${H}:force_original_aspect_ratio=decrease[ff${i}]`,
      `[bb${i}][ff${i}]overlay=(W-w)/2:(H-h)/2,setsar=1,format=yuv420p,settb=1/${RENDER_FPS}[v${i}]`,
    )
    if (inp.hasAudio[c.src]) {
      f.push(`[${n}:a]atrim=start=${fnum(c.start)}:end=${fnum(c.end)},asetpts=PTS-STARTPTS${atempo(c.speed ?? 1)},aresample=48000,aformat=channel_layouts=stereo,volume=${fnum(doc.clip_volume)}[a${i}]`)
    } else {
      f.push(`anullsrc=r=48000:cl=stereo,atrim=0:${fnum(clipLen(c))},asetpts=PTS-STARTPTS[a${i}]`)
    }
  })
  f.push(...joinClips(doc, 'vc', 'ac'))

  // Picture overlays, each only between its start and end.
  let v = 'vc'
  doc.overlays.forEach((o, k) => {
    const moving = isVideoOverlaySrc(o.src)
    // A moving overlay is shifted to start at the overlay's own start; the base picture sets the length (no `shortest`), and a clip shorter than the window just disappears (eof_action=pass).
    const lead = moving ? `fps=${RENDER_FPS},setpts=PTS-STARTPTS+${fnum(o.start)}/TB,` : ''
    f.push(
      `[${ovIdx[k]}:v]${lead}scale=${Math.max(2, Math.round(W * o.width))}:-2,format=rgba${o.key ? `,colorkey=${OVERLAY_KEY_HEX[o.key]}:0.3:0.1` : ''},colorchannelmixer=aa=${fnum(o.opacity)}[ov${k}]`,
      `[${v}][ov${k}]overlay=x=${Math.round(W * o.x)}:y=${Math.round(H * o.y)}:enable='between(t,${fnum(o.start)},${fnum(o.end)})':${moving ? 'eof_action=pass' : 'shortest=1'}[vo${k}]`,
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
    const outFolder = (item && itemOutputFolder(project, item)) ?? ''
    // #668: the rendered video is a finished file: it goes to the item's finished-files folder (same as the PDF of a deck) when the item has its own folder;
    // a folderless item shares the work-items box, which gets no subfolder of its own.
    const out = videoTarget(project, (item && outFolder && outFolder === String(item.folder ?? '').trim() && finishedFolderFor(project, outFolder)) || outFolder, `${stem}.mp4`)
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

// #669: the real length of a source file as the server measures it (ffprobe), remembered per file version. The browser's
// own video.duration is wrong for a variable-frame-rate phone video, and a dragged cut edge can run past the end.
const lengthCache = new Map<string, number | null>()

async function sourceLength(ffPath: string, abs: string): Promise<number | null> {
  let key = abs
  try { const st = statSync(abs); key = `${abs}|${st.mtimeMs}|${st.size}` } catch { return null }
  if (lengthCache.has(key)) return lengthCache.get(key) ?? null
  const p = await probe(ffPath, abs)
  const len = p && p.duration !== null ? p.duration : null
  if (lengthCache.size > 500) lengthCache.clear()
  lengthCache.set(key, len)
  return len
}

/**
 * Pulls every clip's cut back inside the real length of its file (no clip may end past it, and a clip that would then be
 * shorter than the minimum keeps a minimal piece at the end). Returns a copy; `changed` counts the clips that moved.
 * A file that cannot be probed (no ffprobe, missing) leaves its clip alone: this is a correction, never a blocker.
 */
export async function clampClipLengths(project: ProjectRow, doc: TimelineDoc): Promise<{ doc: TimelineDoc; changed: number }> {
  if (!doc.clips.length) return { doc, changed: 0 }
  const ff = await videoTool()
  if (!ff.ok) return { doc, changed: 0 }
  const out: TimelineDoc = { ...doc, clips: doc.clips.map((c) => ({ ...c })) }
  let changed = 0
  const lens = new Map<string, number | null>()
  for (const c of out.clips) {
    if (!lens.has(c.src)) {
      const r = resolveMedia(project, c.src)
      lens.set(c.src, r.ok ? await sourceLength(ff.path, r.abs) : null)
    }
    const len = lens.get(c.src)
    if (len === null || len === undefined) continue
    const real = Math.floor(len * 1000) / 1000
    if (c.end > real + 0.05) {
      c.end = real
      if (c.start > c.end - TIMELINE_MIN_CLIP) c.start = Math.max(0, Math.floor((c.end - TIMELINE_MIN_CLIP) * 1000) / 1000)
      changed++
    }
  }
  return { doc: changed ? out : doc, changed }
}
