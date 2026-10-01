/**
 * VIDEO TIMELINE (v4 spec phase 5, video part): the document model and the
 * edit operations. Pure: no disk, no database, no ffmpeg. The saving (working
 * copy, undo, versions) is the shared draft store; rendering is
 * `workbench-video-render.ts`.
 *
 * A timeline is a list of clips played one after the other (each one a cut of
 * a source video), subtitles, one music track, and picture overlays. The owner
 * and the Workbench agent use the SAME operations (`applyTimelineOps`), the
 * same way as on the canvas, so everything is undoable the same way.
 *
 * Times are seconds. Clip `start`/`end` are positions inside the SOURCE file;
 * subtitle and overlay `start`/`end` are positions on the finished TIMELINE.
 * The length of a source file is not known here (no ffprobe in a pure
 * module): a cut that runs past the end of its file is reported by the renderer
 * in plain words, it is not guessed at.
 */
import { createDraftStore, type DraftKind, type DraftStore } from './workbench-draft-store.js'

export const TIMELINE_MAX_CLIPS = 100
export const TIMELINE_MAX_SUBTITLES = 500
export const TIMELINE_MAX_OVERLAYS = 50
export const TIMELINE_TEXT_MAX = 300
export const TIMELINE_MIN_CLIP = 0.1
export const TIMELINE_MAX_SECONDS = 4 * 3600
export const TIMELINE_EXT = '.timeline.json'

export const TIMELINE_ASPECTS = ['16:9', '9:16', '1:1'] as const
export type TimelineAspect = (typeof TIMELINE_ASPECTS)[number]
/** Output size per aspect ratio: the platform sizes the owner expects (1080p / Reels / square). */
export const ASPECT_SIZE: Record<TimelineAspect, { width: number; height: number }> = {
  '16:9': { width: 1920, height: 1080 },
  '9:16': { width: 1080, height: 1920 },
  '1:1': { width: 1080, height: 1080 },
}

export interface TimelineClip { id: string; src: string; start: number; end: number }
export interface TimelineSubtitle { id: string; text: string; start: number; end: number }
export interface TimelineMusic {
  src: string
  /** 0..1 */
  volume: number
  /** Lower the music while the clips speak (side-chain compression). */
  duck: boolean
}
export interface TimelineOverlay {
  id: string
  src: string
  start: number
  end: number
  /** Position and width as a share (0..1) of the frame; the height follows the picture. */
  x: number
  y: number
  width: number
  opacity: number
}
export interface TimelineDoc {
  version: 1
  aspect: TimelineAspect
  /** Original sound of the clips, 0..1. */
  clip_volume: number
  clips: TimelineClip[]
  subtitles: TimelineSubtitle[]
  music: TimelineMusic | null
  overlays: TimelineOverlay[]
}

export function emptyTimeline(): TimelineDoc {
  return { version: 1, aspect: '16:9', clip_volume: 1, clips: [], subtitles: [], music: null, overlays: [] }
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000
const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n))

/** A project-relative path of a media file: no `..`, no scheme, no absolute path. */
export function isMediaPath(v: unknown): v is string {
  if (typeof v !== 'string') return false
  const s = v.trim()
  if (!s || s.length > 500) return false
  if (s.startsWith('/') || s.includes('\\') || /^[a-z][a-z0-9+.-]*:/i.test(s)) return false
  return !s.split('/').some((seg) => seg === '..' || seg === '')
}
const VIDEO_EXT = /\.(mp4|mov|m4v|webm|mkv|avi)$/i
const AUDIO_EXT = /\.(mp3|m4a|wav|ogg|aac|flac)$/i
const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i

export type TimelineCode =
  | 'timeline_bad_shape' | 'timeline_bad_op' | 'timeline_not_found' | 'timeline_too_many'
  | 'timeline_bad_time' | 'timeline_bad_media' | 'timeline_text_required' | 'timeline_text_too_long'
  | 'timeline_bad_aspect' | 'timeline_bad_value'

export type TimelineFail = { ok: false; code: TimelineCode; detail: string }
export type TimelineParse = { ok: true; doc: TimelineDoc } | TimelineFail

function fail(code: TimelineCode, detail: string): TimelineFail { return { ok: false, code, detail } }

function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v.replace(',', '.')) : NaN
  return Number.isFinite(n) ? n : null
}

function nextId(prefix: string, taken: Iterable<string>): string {
  let max = 0
  for (const id of taken) {
    const m = new RegExp(`^${prefix}(\\d+)$`).exec(id)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return `${prefix}${max + 1}`
}

function cleanText(v: unknown): { ok: true; text: string } | TimelineFail {
  const text = typeof v === 'string' ? v.replace(/\r/g, '').trim() : ''
  if (!text) return fail('timeline_text_required', 'text is required')
  if (text.length > TIMELINE_TEXT_MAX) return fail('timeline_text_too_long', `at most ${TIMELINE_TEXT_MAX} characters`)
  return { ok: true, text }
}

function span(startRaw: unknown, endRaw: unknown, what: string): { ok: true; start: number; end: number } | TimelineFail {
  const start = num(startRaw), end = num(endRaw)
  if (start === null || end === null || start < 0 || end > TIMELINE_MAX_SECONDS || end - start < TIMELINE_MIN_CLIP) {
    return fail('timeline_bad_time', `${what}: start and end must be seconds, end at least ${TIMELINE_MIN_CLIP} after start`)
  }
  return { ok: true, start: round3(start), end: round3(end) }
}

/** Validates a stored or incoming timeline. Unknown keys are dropped; nothing is guessed. */
export function parseTimeline(raw: unknown): TimelineParse {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('timeline_bad_shape', 'the timeline must be an object')
  const r = raw as Record<string, unknown>
  const doc = emptyTimeline()
  if ('aspect' in r) {
    if (!(TIMELINE_ASPECTS as readonly unknown[]).includes(r.aspect)) return fail('timeline_bad_aspect', 'aspect must be 16:9, 9:16 or 1:1')
    doc.aspect = r.aspect as TimelineAspect
  }
  if ('clip_volume' in r) {
    const v = num(r.clip_volume)
    if (v === null || v < 0 || v > 1) return fail('timeline_bad_value', 'clip_volume must be between 0 and 1')
    doc.clip_volume = round3(v)
  }
  const list = (key: string, max: number): unknown[] | TimelineFail => {
    const v = r[key]
    if (v === undefined) return []
    if (!Array.isArray(v)) return fail('timeline_bad_shape', `${key} must be a list`)
    if (v.length > max) return fail('timeline_too_many', `${key}: at most ${max}`)
    return v
  }
  const seen = new Set<string>()
  const id = (o: Record<string, unknown>, prefix: string): string => {
    const given = typeof o.id === 'string' && /^[a-z]\d{1,6}$/.test(o.id) && !seen.has(o.id) ? o.id : nextId(prefix, seen)
    seen.add(given)
    return given
  }
  const clips = list('clips', TIMELINE_MAX_CLIPS)
  if (!Array.isArray(clips)) return clips
  for (const c of clips) {
    const o = (c && typeof c === 'object' ? c : {}) as Record<string, unknown>
    if (!isMediaPath(o.src) || !VIDEO_EXT.test(o.src)) return fail('timeline_bad_media', 'a clip needs a video file inside the project')
    const s = span(o.start, o.end, 'clip')
    if (!s.ok) return s
    doc.clips.push({ id: id(o, 'c'), src: o.src.trim(), start: s.start, end: s.end })
  }
  const subs = list('subtitles', TIMELINE_MAX_SUBTITLES)
  if (!Array.isArray(subs)) return subs
  for (const c of subs) {
    const o = (c && typeof c === 'object' ? c : {}) as Record<string, unknown>
    const t = cleanText(o.text)
    if (!t.ok) return t
    const s = span(o.start, o.end, 'subtitle')
    if (!s.ok) return s
    doc.subtitles.push({ id: id(o, 's'), text: t.text, start: s.start, end: s.end })
  }
  if (r.music != null) {
    const m = (typeof r.music === 'object' ? r.music : {}) as Record<string, unknown>
    if (!isMediaPath(m.src) || !AUDIO_EXT.test(m.src)) return fail('timeline_bad_media', 'the music needs an audio file inside the project')
    const vol = m.volume === undefined ? 0.5 : num(m.volume)
    if (vol === null || vol < 0 || vol > 1) return fail('timeline_bad_value', 'the music volume must be between 0 and 1')
    doc.music = { src: m.src.trim(), volume: round3(vol), duck: m.duck === undefined ? true : m.duck === true }
  }
  const ovs = list('overlays', TIMELINE_MAX_OVERLAYS)
  if (!Array.isArray(ovs)) return ovs
  for (const c of ovs) {
    const o = (c && typeof c === 'object' ? c : {}) as Record<string, unknown>
    if (!isMediaPath(o.src) || !IMAGE_EXT.test(o.src)) return fail('timeline_bad_media', 'an overlay needs a picture inside the project')
    const s = span(o.start, o.end, 'overlay')
    if (!s.ok) return s
    const x = o.x === undefined ? 0.05 : num(o.x), y = o.y === undefined ? 0.05 : num(o.y)
    const w = o.width === undefined ? 0.2 : num(o.width), op = o.opacity === undefined ? 1 : num(o.opacity)
    if (x === null || y === null || w === null || op === null || x < 0 || x > 1 || y < 0 || y > 1 || w < 0.02 || w > 1 || op < 0 || op > 1) {
      return fail('timeline_bad_value', 'overlay x, y, width and opacity must be shares between 0 and 1 (width at least 0.02)')
    }
    doc.overlays.push({ id: id(o, 'o'), src: o.src.trim(), start: s.start, end: s.end, x: round3(x), y: round3(y), width: round3(w), opacity: round3(op) })
  }
  return { ok: true, doc }
}

/** Length of the finished video: the clips back to back. */
export function timelineDuration(doc: TimelineDoc): number {
  return round3(doc.clips.reduce((sum, c) => sum + (c.end - c.start), 0))
}

/** Where each clip starts on the finished timeline. */
export function clipOffsets(doc: TimelineDoc): number[] {
  const out: number[] = []
  let t = 0
  for (const c of doc.clips) { out.push(round3(t)); t += c.end - c.start }
  return out
}

export type TimelineOpsResult =
  | { ok: true; doc: TimelineDoc; applied: { op: string; id: string | null; note: string }[] }
  | TimelineFail

type Op = Record<string, unknown>

/**
 * Applies a list of operations to a copy of the timeline. All or nothing: the
 * first bad operation stops the whole list and nothing is changed.
 *
 * Operations: addClip {src,start,end,at?}, trimClip {id,start?,end?}, moveClip {id,to},
 * splitClip {id,at} (at = source second), removeClip {id}, addSubtitle {text,start,end},
 * updateSubtitle {id,text?,start?,end?}, removeSubtitle {id}, setMusic {src,volume?,duck?},
 * updateMusic {volume?,duck?}, clearMusic, addOverlay {src,start,end,x?,y?,width?,opacity?},
 * updateOverlay {id,...}, removeOverlay {id}, setAspect {aspect}, setClipVolume {volume}.
 */
export function applyTimelineOps(input: TimelineDoc, rawOps: unknown): TimelineOpsResult {
  if (!Array.isArray(rawOps) || !rawOps.length) return fail('timeline_bad_op', 'ops must be a non-empty list')
  if (rawOps.length > 100) return fail('timeline_bad_op', 'at most 100 operations at once')
  const doc: TimelineDoc = JSON.parse(JSON.stringify(input))
  const applied: { op: string; id: string | null; note: string }[] = []

  const find = <T extends { id: string }>(list: T[], id: unknown, what: string): T | TimelineFail => {
    const f = list.find((x) => x.id === id)
    return f ?? fail('timeline_not_found', `no ${what} with id ${String(id)}`)
  }
  const isFail = (v: unknown): v is TimelineFail => !!v && typeof v === 'object' && (v as { ok?: unknown }).ok === false

  for (const raw of rawOps) {
    if (!raw || typeof raw !== 'object') return fail('timeline_bad_op', 'every operation must be an object')
    const op = raw as Op
    const name = String(op.op ?? '')
    switch (name) {
      case 'addClip': {
        if (doc.clips.length >= TIMELINE_MAX_CLIPS) return fail('timeline_too_many', `at most ${TIMELINE_MAX_CLIPS} clips`)
        if (!isMediaPath(op.src) || !VIDEO_EXT.test(op.src)) return fail('timeline_bad_media', 'a clip needs a video file inside the project')
        const s = span(op.start ?? 0, op.end, 'clip')
        if (!s.ok) return s
        const id = nextId('c', doc.clips.map((c) => c.id))
        const at = op.at === undefined ? doc.clips.length : clamp(Math.round(num(op.at) ?? doc.clips.length), 0, doc.clips.length)
        doc.clips.splice(at, 0, { id, src: op.src.trim(), start: s.start, end: s.end })
        applied.push({ op: name, id, note: `added at position ${at + 1}` })
        break
      }
      case 'trimClip': {
        const c = find(doc.clips, op.id, 'clip')
        if (isFail(c)) return c
        const s = span(op.start ?? c.start, op.end ?? c.end, 'clip')
        if (!s.ok) return s
        c.start = s.start; c.end = s.end
        applied.push({ op: name, id: c.id, note: `now ${s.start}s to ${s.end}s of the source` })
        break
      }
      case 'moveClip': {
        const idx = doc.clips.findIndex((x) => x.id === op.id)
        if (idx < 0) return fail('timeline_not_found', `no clip with id ${String(op.id)}`)
        const to = num(op.to)
        if (to === null) return fail('timeline_bad_value', 'to must be a position (1 = first)')
        const dest = clamp(Math.round(to) - 1, 0, doc.clips.length - 1)
        const [c] = doc.clips.splice(idx, 1)
        doc.clips.splice(dest, 0, c)
        applied.push({ op: name, id: c.id, note: `now position ${dest + 1}` })
        break
      }
      case 'splitClip': {
        const idx = doc.clips.findIndex((x) => x.id === op.id)
        if (idx < 0) return fail('timeline_not_found', `no clip with id ${String(op.id)}`)
        const c = doc.clips[idx]
        const at = num(op.at)
        if (at === null || at - c.start < TIMELINE_MIN_CLIP || c.end - at < TIMELINE_MIN_CLIP) {
          return fail('timeline_bad_time', `the cut point must lie inside the clip (${c.start}s to ${c.end}s of the source), at least ${TIMELINE_MIN_CLIP}s from each end`)
        }
        if (doc.clips.length >= TIMELINE_MAX_CLIPS) return fail('timeline_too_many', `at most ${TIMELINE_MAX_CLIPS} clips`)
        const id = nextId('c', doc.clips.map((x) => x.id))
        doc.clips.splice(idx + 1, 0, { id, src: c.src, start: round3(at), end: c.end })
        c.end = round3(at)
        applied.push({ op: name, id: c.id, note: `split into ${c.id} and ${id}` })
        break
      }
      case 'removeClip': {
        const idx = doc.clips.findIndex((x) => x.id === op.id)
        if (idx < 0) return fail('timeline_not_found', `no clip with id ${String(op.id)}`)
        doc.clips.splice(idx, 1)
        applied.push({ op: name, id: String(op.id), note: 'removed' })
        break
      }
      case 'addSubtitle': {
        if (doc.subtitles.length >= TIMELINE_MAX_SUBTITLES) return fail('timeline_too_many', `at most ${TIMELINE_MAX_SUBTITLES} subtitles`)
        const t = cleanText(op.text)
        if (!t.ok) return t
        const s = span(op.start, op.end, 'subtitle')
        if (!s.ok) return s
        const id = nextId('s', doc.subtitles.map((x) => x.id))
        doc.subtitles.push({ id, text: t.text, start: s.start, end: s.end })
        doc.subtitles.sort((a, b) => a.start - b.start)
        applied.push({ op: name, id, note: 'added' })
        break
      }
      case 'updateSubtitle': {
        const c = find(doc.subtitles, op.id, 'subtitle')
        if (isFail(c)) return c
        if ('text' in op) { const t = cleanText(op.text); if (!t.ok) return t; c.text = t.text }
        const s = span(op.start ?? c.start, op.end ?? c.end, 'subtitle')
        if (!s.ok) return s
        c.start = s.start; c.end = s.end
        doc.subtitles.sort((a, b) => a.start - b.start)
        applied.push({ op: name, id: c.id, note: 'updated' })
        break
      }
      case 'removeSubtitle': {
        const idx = doc.subtitles.findIndex((x) => x.id === op.id)
        if (idx < 0) return fail('timeline_not_found', `no subtitle with id ${String(op.id)}`)
        doc.subtitles.splice(idx, 1)
        applied.push({ op: name, id: String(op.id), note: 'removed' })
        break
      }
      case 'setMusic': {
        const p = parseTimeline({ music: { src: op.src, volume: op.volume, duck: op.duck } })
        if (!p.ok) return p
        doc.music = p.doc.music
        applied.push({ op: name, id: null, note: 'music set' })
        break
      }
      case 'updateMusic': {
        if (!doc.music) return fail('timeline_not_found', 'there is no music to change')
        const p = parseTimeline({ music: { src: doc.music.src, volume: op.volume ?? doc.music.volume, duck: op.duck ?? doc.music.duck } })
        if (!p.ok) return p
        doc.music = p.doc.music
        applied.push({ op: name, id: null, note: 'music changed' })
        break
      }
      case 'clearMusic':
        doc.music = null
        applied.push({ op: name, id: null, note: 'music removed' })
        break
      case 'addOverlay': {
        if (doc.overlays.length >= TIMELINE_MAX_OVERLAYS) return fail('timeline_too_many', `at most ${TIMELINE_MAX_OVERLAYS} overlays`)
        const p = parseTimeline({ overlays: [{ src: op.src, start: op.start, end: op.end, x: op.x, y: op.y, width: op.width, opacity: op.opacity }] })
        if (!p.ok) return p
        const id = nextId('o', doc.overlays.map((x) => x.id))
        doc.overlays.push({ ...p.doc.overlays[0], id })
        applied.push({ op: name, id, note: 'added' })
        break
      }
      case 'updateOverlay': {
        const c = find(doc.overlays, op.id, 'overlay')
        if (isFail(c)) return c
        const p = parseTimeline({
          overlays: [{
            src: op.src ?? c.src, start: op.start ?? c.start, end: op.end ?? c.end,
            x: op.x ?? c.x, y: op.y ?? c.y, width: op.width ?? c.width, opacity: op.opacity ?? c.opacity,
          }],
        })
        if (!p.ok) return p
        Object.assign(c, { ...p.doc.overlays[0], id: c.id })
        applied.push({ op: name, id: c.id, note: 'updated' })
        break
      }
      case 'removeOverlay': {
        const idx = doc.overlays.findIndex((x) => x.id === op.id)
        if (idx < 0) return fail('timeline_not_found', `no overlay with id ${String(op.id)}`)
        doc.overlays.splice(idx, 1)
        applied.push({ op: name, id: String(op.id), note: 'removed' })
        break
      }
      case 'setAspect': {
        if (!(TIMELINE_ASPECTS as readonly unknown[]).includes(op.aspect)) return fail('timeline_bad_aspect', 'aspect must be 16:9, 9:16 or 1:1')
        doc.aspect = op.aspect as TimelineAspect
        applied.push({ op: name, id: null, note: `output is now ${doc.aspect}` })
        break
      }
      case 'setClipVolume': {
        const v = num(op.volume)
        if (v === null || v < 0 || v > 1) return fail('timeline_bad_value', 'volume must be between 0 and 1')
        doc.clip_volume = round3(v)
        applied.push({ op: name, id: null, note: `clip sound ${doc.clip_volume}` })
        break
      }
      default:
        return fail('timeline_bad_op', `unknown operation "${name}"`)
    }
  }
  return { ok: true, doc, applied }
}

/** A readable one-paragraph summary, for the agent and for logs. */
export function timelineSummary(doc: TimelineDoc): string {
  const d = timelineDuration(doc)
  return `${doc.clips.length} clips (${d}s), ${doc.subtitles.length} subtitles, `
    + `${doc.music ? 'music' : 'no music'}, ${doc.overlays.length} overlays, ${doc.aspect}`
}

// ---- undo patches and the shared draft store ---------------------------------------

/** A step is the whole small document before and after: a timeline is a few KB, and a
 *  whole-document patch is replayed in both directions without any per-operation inverse. */
export interface TimelinePatch { b: TimelineDoc; a: TimelineDoc }

const same = (x: unknown, y: unknown): boolean => JSON.stringify(x) === JSON.stringify(y)

export const timelineKind: DraftKind<TimelineDoc, TimelinePatch> = {
  key: 'video',
  ext: TIMELINE_EXT,
  maxBytes: 2_000_000,
  empty: emptyTimeline,
  // The store hands over the file / database text; a ready object is accepted too.
  parse: (raw) => {
    let value: unknown = raw
    if (typeof raw === 'string') {
      try { value = JSON.parse(raw) } catch { return { ok: false, code: 'timeline_bad_shape', detail: 'the timeline file is not valid JSON' } }
    }
    const p = parseTimeline(value)
    return p.ok ? { ok: true, doc: p.doc } : { ok: false, code: p.code, detail: p.detail }
  },
  isFile: (name) => name.toLowerCase().endsWith(TIMELINE_EXT),
  fileName: (title) => {
    const base = String(title ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 60)
    return `${base || 'video'}${TIMELINE_EXT}`
  },
  baseName: (name) => String(name ?? '').replace(/ \(\d+\)(?=\.[^.]+$|$)/, ''),
  diff: (before, after) => (same(before, after) ? null : { b: before, a: after }),
  apply: (doc, patch, dir) => {
    const expect = dir === 'undo' ? patch.a : patch.b
    if (!same(doc, expect)) {
      return { ok: false, code: 'video_undo_conflict', detail: 'the timeline was changed in another way since this step, so it cannot be undone safely' }
    }
    return { ok: true, doc: dir === 'undo' ? patch.b : patch.a }
  },
  // Big = the cut list changed a lot: clips removed or replaced, or a different output format.
  isBig: (before, after) => {
    const ids = new Set(after.clips.map((c) => c.id))
    const lost = before.clips.filter((c) => !ids.has(c.id)).length
    return lost >= 2 || before.aspect !== after.aspect
  },
  count: (doc) => doc.clips.length + doc.subtitles.length + doc.overlays.length,
}

let store: DraftStore<TimelineDoc> | null = null
/** The one store of the video timeline (created on first use). */
export function timelineStore(): DraftStore<TimelineDoc> {
  if (!store) store = createDraftStore(timelineKind)
  return store
}
