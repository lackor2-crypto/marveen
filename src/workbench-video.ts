/**
 * MUNKAPAD: EGYSZERU VIDEOMUNKA (kanban #406, 19. pont).
 *
 * Harom dolog: lejatszas (a bongeszo sajat lejatszoja, ehhez nem kell semmi),
 * az eleje/vege levagasa, es egy kepkocka mentese kepkent. Az utobbi ketto
 * FFmpeg-gel fut a gepen; ha nincs FFmpeg, a felulet emberi mondatot mutat es
 * a Kepessegek panelre visz -- a lejatszas akkor is megy.
 *
 * SEMMI NEM IR FELUL:
 *   - a vagas UJ fajl a regi melle (ugyanabba a mappaba, `klip (2).mp4`), es a
 *     video munkadarab UJ verzioja mutat ra; a regi verzio a regi fajlra;
 *   - a kepkocka UJ PNG fajl, es UJ kep munkadarab lesz belole ugyanabban a
 *     projektben (a sajat v1-e) -- a video munkadarab erintetlen marad.
 *
 * Az FFmpeg `-n` kapcsoloval fut: ha a cel-nev kozben foglalt lett, inkabb
 * hiba, mint felulirt fajl. Elbukott futas utan a felkesz kimenetet toroljuk.
 */
import { spawn } from 'node:child_process'
import { existsSync, statSync, unlinkSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { ProjectRow } from './projects.js'
import { projectFileTarget, freeFileName, safeFileName } from './project-files.js'
import { writeBlockReason } from './git-guard.js'
import { resolveLifePath } from './life-explorer.js'
import { buildPreview } from './workbench-preview.js'
import { baseNameForNextVersion, subFolderOf } from './workbench-edit.js'
import { probeFfmpeg } from './workbench-capabilities.js'
import {
  createWorkItem, createWorkItemVersion,
  type WorkItemRow, type WorkItemVersionRow,
} from './workbench.js'

type Lang = 'hu' | 'en'

/** Egy vagas legfeljebb ennyi ideig futhat (ujrakodolas; egy hosszu video perceket vesz igenybe). */
export const VIDEO_TRIM_TIMEOUT_MS = 15 * 60_000
export const VIDEO_FRAME_TIMEOUT_MS = 60_000
/** A legrovidebb ertelmes vagas (masodperc). */
export const VIDEO_MIN_CLIP = 0.1

export type VideoToolState = 'ok' | 'not_installed' | 'check_failed'
export interface VideoToolStatus { state: VideoToolState; path: string | null; detail: string | null }

export type RunResult = { ok: true } | { ok: false; timeout: boolean; detail: string }
export type Runner = (cmd: string, args: string[], timeoutMs: number) => Promise<RunResult>

const defaultRunner: Runner = (cmd, args, timeoutMs) => new Promise((resolve) => {
  let err = ''
  let done = false
  const finish = (r: RunResult) => { if (!done) { done = true; resolve(r) } }
  let child: ReturnType<typeof spawn>
  try {
    child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
  } catch (e) {
    finish({ ok: false, timeout: false, detail: e instanceof Error ? e.message : String(e) })
    return
  }
  const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* mar leallt */ } ; finish({ ok: false, timeout: true, detail: 'timeout' }) }, timeoutMs)
  child.stderr?.on('data', (b: Buffer) => { err = (err + b.toString('utf-8')).slice(-4000) })
  child.on('error', (e) => { clearTimeout(timer); finish({ ok: false, timeout: false, detail: e.message }) })
  child.on('close', (code) => {
    clearTimeout(timer)
    if (code === 0) finish({ ok: true })
    else finish({ ok: false, timeout: false, detail: lastLines(err) || `exit ${code}` })
  })
})

function lastLines(s: string): string {
  return s.trim().split(/\r?\n/).filter(Boolean).slice(-3).join(' | ').slice(0, 500)
}

let runner: Runner = defaultRunner
let toolReader: () => Promise<VideoToolStatus> = async () => {
  const p = await probeFfmpeg()
  return { state: p.reason, path: p.path, detail: p.detail }
}

/** Csak teszteknek. Argumentum nelkul visszaallit. */
export function _setVideoDeps(d: { run?: Runner; tool?: () => Promise<VideoToolStatus> } = {}): void {
  runner = d.run || defaultRunner
  toolReader = d.tool || (async () => {
    const p = await probeFfmpeg()
    return { state: p.reason, path: p.path, detail: p.detail }
  })
}

export function videoToolStatus(): Promise<VideoToolStatus> {
  return toolReader()
}

/** Idopont a felhasznalotol: masodperc (`12.5`) vagy ora:perc:mp (`1:05`, `0:01:05.5`). */
export function parseTime(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? v : null
  const s = String(v ?? '').trim().replace(',', '.')
  if (!s) return null
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s)
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/.exec(s)
  if (!m) return null
  const sec = Number(m[3])
  const min = Number(m[2])
  if (sec >= 60 || (m[1] !== undefined && min >= 60)) return null
  return Number(m[1] || 0) * 3600 + min * 60 + sec
}

/** `65.25` -> `1-05` (fajlnevbe: kettospont nelkul). */
export function timeLabel(sec: number): string {
  const s = Math.floor(sec)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = String(s % 60).padStart(2, '0')
  return h ? `${h}-${String(m).padStart(2, '0')}-${r}` : `${m}-${r}`
}

/** `65.25` -> `1:05` (feliratba). */
export function timeText(sec: number): string {
  return timeLabel(sec).replace(/-/g, ':')
}

export type VideoCode =
  | 'video_stale' | 'video_not_video' | 'video_bad_time' | 'video_no_ffmpeg' | 'video_ffmpeg_check_failed'
  | 'video_busy' | 'video_failed' | 'video_timeout' | 'video_no_output'
  | 'no_folder' | 'no_depot' | 'missing' | 'unreachable' | 'bad_folder' | 'bad_name' | 'repo_inside' | 'write_failed'
  | 'preview_missing' | 'preview_unreachable' | 'preview_no_folder' | 'preview_too_large'

export type VideoFail = { ok: false; code: VideoCode; detail?: string | null }

/** Egyszerre egy munka munkadarabonkent: egy dupla kattintas ne inditson ket kodolast. */
const busy = new Set<string>()

interface Source { abs: string; rel: string; name: string }

function videoSource(item: WorkItemRow, baseVersion: unknown): Source | VideoFail {
  const base = String(baseVersion ?? '')
  if (!base || base !== (item.current_version_id || '')) return { ok: false, code: 'video_stale' }
  const p = buildPreview(item.id)
  if (!p.rel) return { ok: false, code: 'video_not_video' }
  if (!p.available) {
    const code = ('preview_' + p.reason) as VideoCode
    return { ok: false, code: ['preview_missing', 'preview_unreachable', 'preview_no_folder', 'preview_too_large'].includes(code) ? code : 'video_not_video' }
  }
  if (p.kind !== 'video') return { ok: false, code: 'video_not_video' }
  const abs = resolveLifePath(p.rel)
  if (!abs) return { ok: false, code: 'preview_unreachable' }
  return { abs, rel: p.rel, name: p.name || basename(p.rel) }
}

async function tool(): Promise<{ ok: true; path: string } | VideoFail> {
  const t = await toolReader()
  if (t.state === 'ok' && t.path) return { ok: true, path: t.path }
  if (t.state === 'check_failed') return { ok: false, code: 'video_ffmpeg_check_failed', detail: t.detail }
  return { ok: false, code: 'video_no_ffmpeg' }
}

/** Szabad cel-fajl a projekt mappajaban (a forras almappajaban). */
function target(project: ProjectRow, srcRel: string, wanted: string): { ok: true; abs: string; rel: string; name: string } | VideoFail {
  const t = projectFileTarget(project, subFolderOf(project, srcRel))
  if (!t.ok) return { ok: false, code: t.code, detail: t.message || null }
  const clean = safeFileName(wanted)
  if (!clean) return { ok: false, code: 'bad_name' }
  const blocked = writeBlockReason(`${t.dirRel}/${clean}`)
  if (blocked) return { ok: false, code: 'repo_inside', detail: blocked }
  const name = freeFileName(t.dirAbs, clean)
  return { ok: true, abs: join(t.dirAbs, name), rel: `${t.dirRel}/${name}`, name }
}

function dropPartial(abs: string): void {
  try { if (existsSync(abs)) unlinkSync(abs) } catch { /* nem kritikus: a nev ugyis foglalt marad, a kovetkezo mentes (2)-t kap */ }
}

async function runTo(cmd: string, args: string[], out: string, timeoutMs: number): Promise<{ ok: true; bytes: number } | VideoFail> {
  const r = await runner(cmd, args, timeoutMs)
  if (!r.ok) {
    dropPartial(out)
    return { ok: false, code: r.timeout ? 'video_timeout' : 'video_failed', detail: r.timeout ? null : r.detail }
  }
  let bytes = 0
  try { bytes = statSync(out).size } catch { bytes = 0 }
  if (!bytes) { dropPartial(out); return { ok: false, code: 'video_no_output' } }
  return { ok: true, bytes }
}

export type TrimResult =
  | { ok: true; item: WorkItemRow; version: WorkItemVersionRow; file: { rel: string; name: string; bytes: number } }
  | VideoFail

/**
 * Az eleje/vege levagasa: `start`-tol `end`-ig (masodperc). UJ MP4 fajl +
 * a munkadarab UJ verzioja. Pontos vagas (ujrakodolas), nem a legkozelebbi
 * kulcskepkockanal -- a felhasznalo azt kapja, amit a lejatszon latott.
 */
export async function trimVideo(
  item: WorkItemRow, project: ProjectRow,
  opts: { start: unknown; end: unknown; baseVersion: unknown; created_by?: string | null },
): Promise<TrimResult> {
  const start = parseTime(opts.start)
  const end = parseTime(opts.end)
  if (start === null || end === null || end - start < VIDEO_MIN_CLIP) return { ok: false, code: 'video_bad_time' }
  const src = videoSource(item, opts.baseVersion)
  if ('ok' in src) return src
  if (busy.has(item.id)) return { ok: false, code: 'video_busy' }
  busy.add(item.id)
  try {
    const ff = await tool()
    if (!ff.ok) return ff
    const stem = baseNameForNextVersion(src.name).replace(/\.[^.]+$/, '') || 'video'
    const out = target(project, src.rel, `${stem}.mp4`)
    if (!out.ok) return out
    const args = [
      '-hide_banner', '-nostdin', '-loglevel', 'error', '-n',
      '-ss', start.toFixed(3), '-i', src.abs, '-t', (end - start).toFixed(3),
      '-map', '0:v:0?', '-map', '0:a:0?',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart',
      out.abs,
    ]
    const r = await runTo(ff.path, args, out.abs, VIDEO_TRIM_TIMEOUT_MS)
    if (!r.ok) return r
    const v = createWorkItemVersion(item.id, {
      source_path: out.rel,
      created_by: opts.created_by ?? null,
      metadata_json: JSON.stringify({ edit: 'video_trim', start, end, from: src.rel }),
    })
    if (!v.ok) return { ok: false, code: 'video_failed', detail: v.code }
    return { ok: true, item: v.item, version: v.version, file: { rel: out.rel, name: out.name, bytes: r.bytes } }
  } finally {
    busy.delete(item.id)
  }
}

export type FrameResult =
  | { ok: true; item: WorkItemRow; file: { rel: string; name: string; bytes: number } }
  | VideoFail

/**
 * Egy kepkocka (`at` masodperc) PNG-kent: UJ fajl a video melle, es UJ kep
 * munkadarab ugyanabban a projektben. A video munkadarab nem valtozik.
 */
export async function saveVideoFrame(
  item: WorkItemRow, project: ProjectRow,
  opts: { at: unknown; baseVersion: unknown; lang: Lang; created_by?: string | null },
): Promise<FrameResult> {
  const at = parseTime(opts.at)
  if (at === null) return { ok: false, code: 'video_bad_time' }
  const src = videoSource(item, opts.baseVersion)
  if ('ok' in src) return src
  const ff = await tool()
  if (!ff.ok) return ff
  const stem = baseNameForNextVersion(src.name).replace(/\.[^.]+$/, '') || 'video'
  const out = target(project, src.rel, `${stem} ${timeLabel(at)}.png`)
  if (!out.ok) return out
  const args = [
    '-hide_banner', '-nostdin', '-loglevel', 'error', '-n',
    '-ss', at.toFixed(3), '-i', src.abs, '-frames:v', '1', '-update', '1',
    out.abs,
  ]
  const r = await runTo(ff.path, args, out.abs, VIDEO_FRAME_TIMEOUT_MS)
  if (!r.ok) return r
  const title = opts.lang === 'en' ? `${item.title} -- frame ${timeText(at)}` : `${item.title} -- képkocka ${timeText(at)}`
  const c = createWorkItem({ project_id: project.id, type: 'image', title, source_path: out.rel, created_by: opts.created_by ?? null })
  if (!c.ok) return { ok: false, code: 'video_failed', detail: c.code }
  return { ok: true, item: c.item, file: { rel: out.rel, name: out.name, bytes: r.bytes } }
}
