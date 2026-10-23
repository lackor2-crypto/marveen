/**
 * EGY KESZ KLIP KOZZETETELE TOBB CSATORNARA (munkadarab "Video fejlesztes", 8/c).
 *
 * Lepesek: engedely-ellenorzes -> a klip feltoltese a nyilvanos tarhelyre (EGYSZER) -> csatornankent egy Buffer-poszt.
 * Szabalyok:
 *   - A valodi kozzetetelhez jovahagyas kell, KIVEVE ha a tulajdonos a `publish_content` kategoriat 3-asra allitotta
 *     (Beallitasok / Autonomia): akkor a Marvin magatol megy. A vazlat sosem igenyel jovahagyast.
 *   - Ugyanaz a klip UGYANARRA a csatornara nem megy ki ketszer (tartos nyilvantartas); egy reszleges hiba utan az
 *     ujraprobalas csak a meg nem sikerult csatornakat erinti.
 *   - Az automatikus ujraprobalkozas NINCS: a hibat a tulajdonos latja.
 */
import { randomUUID } from 'node:crypto'
import { statSync, readFileSync } from 'node:fs'
import { resolveLifePath } from './life-explorer.js'
import { getDb } from './db.js'
import { loadAutonomyConfig } from './autonomy.js'
import { createBufferPost, type BufferDeps } from './workbench-social-buffer.js'
import { uploadPublicVideo, type HostDeps } from './workbench-social-host.js'

export interface SocialChannel { id: string; service: string; name?: string }

let tablesDb: unknown = null
export function ensureSocialTables(): void {
  const db = getDb()
  if (tablesDb === db) return
  db.exec(`
    CREATE TABLE IF NOT EXISTS wb_social_posts (
      id TEXT PRIMARY KEY,
      work_item_id TEXT NOT NULL,
      clip_key TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      service TEXT NOT NULL,
      buffer_post_id TEXT,
      draft INTEGER NOT NULL,
      due_at TEXT,
      video_url TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `)
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_wb_social_once ON wb_social_posts(clip_key, channel_id, draft)')
  tablesDb = db
}

/** A tulajdonos beallitasa: a publish_content kategoria 3-as szinten van-e (es nincs lezarva). */
export function publishWithoutAsking(config?: { categories: { key: string; level: number; locked: boolean }[] }): boolean {
  try {
    const cfg = config ?? loadAutonomyConfig()
    const c = cfg.categories.find((x) => x.key === 'publish_content')
    return !!c && !c.locked && c.level >= 3
  } catch { return false }
}

export interface PublishInput {
  workItemId: string
  /** A klip azonositoja (pl. a fajl eleresi utja + verzio): ez alapjan nem megy ki ketszer. */
  clipKey: string
  bytes: Buffer
  text: string
  channels: SocialChannel[]
  draft: boolean
  dueAt?: string
  title?: string
  /** A tulajdonos kifejezett jovahagyasa erre a kozzetetelre. */
  approved?: boolean
}

export interface ChannelOutcome { channelId: string; service: string; status: 'posted' | 'draft' | 'already_posted' | 'failed'; postId?: string; code?: string; detail?: string }
export type PublishResult =
  | { ok: false; code: string; detail: string }
  | { ok: true; videoUrl: string | null; outcomes: ChannelOutcome[] }

export async function publishClip(input: PublishInput, deps: { buffer?: BufferDeps; host?: HostDeps; autonomy?: { categories: { key: string; level: number; locked: boolean }[] } } = {}): Promise<PublishResult> {
  ensureSocialTables()
  if (!input.channels.length) return { ok: false, code: 'publish_no_channel', detail: 'no channel chosen' }
  if (!input.draft && !input.approved && !publishWithoutAsking(deps.autonomy)) {
    return { ok: false, code: 'publish_needs_approval', detail: 'live posting needs the owner\'s approval (or publish_content on level 3)' }
  }
  const db = getDb()
  const done = new Map<string, string | null>()
  for (const r of db.prepare('SELECT channel_id, buffer_post_id FROM wb_social_posts WHERE clip_key = ? AND draft = ?').all(input.clipKey, input.draft ? 1 : 0) as { channel_id: string; buffer_post_id: string | null }[]) done.set(r.channel_id, r.buffer_post_id)
  const todo = input.channels.filter((c) => !done.has(c.id))
  const outcomes: ChannelOutcome[] = input.channels.filter((c) => done.has(c.id)).map((c) => ({ channelId: c.id, service: c.service, status: 'already_posted', postId: done.get(c.id) ?? undefined }))
  if (!todo.length) return { ok: true, videoUrl: null, outcomes }

  const up = await uploadPublicVideo({ bytes: input.bytes, publicId: `marveen/${input.clipKey}` }, deps.host)
  if (!up.ok) return { ok: false, code: up.code, detail: up.detail }

  for (const c of todo) {
    const r = await createBufferPost({ channelId: c.id, service: c.service, text: input.text, videoUrl: up.url, draft: input.draft, dueAt: input.dueAt, title: input.title }, deps.buffer)
    if (!r.ok) { outcomes.push({ channelId: c.id, service: c.service, status: 'failed', code: r.code, detail: r.detail }); continue }
    db.prepare('INSERT OR IGNORE INTO wb_social_posts (id, work_item_id, clip_key, channel_id, service, buffer_post_id, draft, due_at, video_url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), input.workItemId, input.clipKey, c.id, c.service, r.postId, input.draft ? 1 : 0, input.dueAt ?? null, up.url, Math.floor(Date.now() / 1000))
    outcomes.push({ channelId: c.id, service: c.service, status: input.draft ? 'draft' : 'posted', postId: r.postId })
  }
  return { ok: true, videoUrl: up.url, outcomes }
}


// ---------------------------------------------------------------------------
// A munkadarab klipje es a korabbi posztok (a panelhez)
// ---------------------------------------------------------------------------
/** A tarhely ingyenes szintje ennyit visz fel egy videobol (Cloudinary: 100 MB). */
export const CLIP_MAX_BYTES = 100 * 1024 * 1024
const CLIP_EXT = /\.(mp4|mov|m4v)$/i

export type ClipRead = { ok: true; bytes: Buffer; rel: string } | { ok: false; code: string; detail: string }

/** A projekt mappajan BELULI videofajl beolvasasa (a `rel` az Eletfa-relativ ut). */
export function readClipFile(projectFolder: string | null | undefined, rel: string | null | undefined): ClipRead {
  const r = String(rel ?? '').trim()
  if (!r) return { ok: false, code: 'publish_no_clip', detail: 'this work item has no video file yet' }
  const folder = String(projectFolder ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  const norm = r.replace(/\\/g, '/')
  if (!folder || !norm.startsWith(folder + '/') || norm.split('/').includes('..')) return { ok: false, code: 'publish_clip_outside', detail: 'the video must be inside the project folder' }
  if (!CLIP_EXT.test(norm)) return { ok: false, code: 'publish_clip_not_video', detail: 'only .mp4, .mov or .m4v can be posted' }
  const abs = resolveLifePath(norm)
  if (!abs) return { ok: false, code: 'publish_no_clip', detail: norm }
  try {
    const size = statSync(abs).size
    if (size > CLIP_MAX_BYTES) return { ok: false, code: 'publish_clip_too_big', detail: `${Math.round(size / 1024 / 1024)} MB > ${Math.round(CLIP_MAX_BYTES / 1024 / 1024)} MB` }
    return { ok: true, bytes: readFileSync(abs), rel: norm }
  } catch (e) {
    return { ok: false, code: 'publish_no_clip', detail: e instanceof Error ? e.message : String(e) }
  }
}

export interface SocialPostRow { id: string; clip_key: string; channel_id: string; service: string; buffer_post_id: string | null; draft: number; due_at: string | null; video_url: string; created_at: number }

export function listSocialPosts(itemId: string): SocialPostRow[] {
  ensureSocialTables()
  return getDb().prepare('SELECT id, clip_key, channel_id, service, buffer_post_id, draft, due_at, video_url, created_at FROM wb_social_posts WHERE work_item_id = ? ORDER BY created_at DESC LIMIT 30').all(itemId) as SocialPostRow[]
}

/** A klip azonositoja: a fajl + a munkadarab (egy fajl egyszer megy ki egy csatornara). */
export function clipKeyFor(itemId: string, rel: string): string {
  return `${itemId}/${rel.split('/').pop()}`.replace(/\.[^.]+$/, '')
}
