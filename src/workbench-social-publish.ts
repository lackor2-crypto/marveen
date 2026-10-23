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
import { uploadPublicVideo, deletePublicVideo, type HostDeps } from './workbench-social-host.js'

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
  // A nyilvanos tarhelyen JELENLEVO videok (legfeljebb HOSTED_KEEP marad; a torlesre jeloltek `delete_pending`-gel varnak).
  db.exec(`
    CREATE TABLE IF NOT EXISTS wb_social_hosted (
      public_id TEXT PRIMARY KEY,
      clip_key TEXT NOT NULL,
      url TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      uploaded_at INTEGER NOT NULL,
      delete_pending INTEGER NOT NULL DEFAULT 0,
      delete_error TEXT,
      delete_tries INTEGER NOT NULL DEFAULT 0,
      deleted_at INTEGER
    )
  `)
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
export interface PruneReport { deleted: string[]; failed: { clip: string; code: string; detail: string }[] }
export type PublishResult =
  | { ok: false; code: string; detail: string }
  | { ok: true; videoUrl: string | null; outcomes: ChannelOutcome[]; pruned: PruneReport }

/** Ennyi video maradhat fent a nyilvanos tarhelyen (a 4.-nel a legregebbi torlodik). */
export const HOSTED_KEEP = 3

const clipLabel = (clipKey: string): string => clipKey.split('/').pop() || clipKey

/**
 * A tarhely rendbetetele: a megjelolt (torlesre var) videok torlesenek ujraprobalasa, es ha tobb mint `keep` van fent, a
 * legregebbiek megjelolese + torlese. A torles hibaja SOSEM dob: a sor `delete_pending` marad a hibaval (a felulet mutatja),
 * a kovetkezo feltoltesnel ujra megprobaljuk.
 */
export async function pruneHosted(host: HostDeps = {}, keep = HOSTED_KEEP): Promise<PruneReport> {
  ensureSocialTables()
  const db = getDb()
  const report: PruneReport = { deleted: [], failed: [] }
  const live = db.prepare('SELECT public_id FROM wb_social_hosted WHERE deleted_at IS NULL AND delete_pending = 0 ORDER BY uploaded_at ASC, rowid ASC').all() as { public_id: string }[]
  for (const r of live.slice(0, Math.max(0, live.length - keep))) db.prepare('UPDATE wb_social_hosted SET delete_pending = 1 WHERE public_id = ?').run(r.public_id)
  const pending = db.prepare('SELECT public_id, clip_key FROM wb_social_hosted WHERE deleted_at IS NULL AND delete_pending = 1 ORDER BY uploaded_at ASC, rowid ASC').all() as { public_id: string; clip_key: string }[]
  for (const p of pending) {
    let d: Awaited<ReturnType<typeof deletePublicVideo>>
    try { d = await deletePublicVideo(p.public_id, host) } catch (e) { d = { ok: false, code: 'host_delete_failed', detail: e instanceof Error ? e.message.slice(0, 200) : 'error' } }
    if (d.ok) {
      db.prepare('UPDATE wb_social_hosted SET deleted_at = ?, delete_error = NULL, delete_pending = 0 WHERE public_id = ?').run(Math.floor(Date.now() / 1000), p.public_id)
      report.deleted.push(clipLabel(p.clip_key))
    } else {
      db.prepare('UPDATE wb_social_hosted SET delete_error = ?, delete_tries = delete_tries + 1 WHERE public_id = ?').run(`${d.code}: ${d.detail}`.slice(0, 300), p.public_id)
      report.failed.push({ clip: clipLabel(p.clip_key), code: d.code, detail: d.detail })
    }
  }
  return report
}

export interface HostedStatus {
  max: number
  items: { name: string; bytes: number; uploaded_at: number; delete_pending: boolean; delete_error: string | null }[]
  recently_deleted: { name: string; deleted_at: number }[]
}

/** Mennyi van fent a tarhelyen es mi torlodott legutobb (a panelhez). */
export function hostedStatus(): HostedStatus {
  ensureSocialTables()
  const db = getDb()
  const items = db.prepare('SELECT clip_key, bytes, uploaded_at, delete_pending, delete_error FROM wb_social_hosted WHERE deleted_at IS NULL ORDER BY uploaded_at ASC, rowid ASC').all() as { clip_key: string; bytes: number; uploaded_at: number; delete_pending: number; delete_error: string | null }[]
  const gone = db.prepare('SELECT clip_key, deleted_at FROM wb_social_hosted WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC, rowid DESC LIMIT 3').all() as { clip_key: string; deleted_at: number }[]
  return {
    max: HOSTED_KEEP,
    items: items.map((r) => ({ name: clipLabel(r.clip_key), bytes: r.bytes, uploaded_at: r.uploaded_at, delete_pending: !!r.delete_pending, delete_error: r.delete_error })),
    recently_deleted: gone.map((r) => ({ name: clipLabel(r.clip_key), deleted_at: r.deleted_at })),
  }
}

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
  if (!todo.length) return { ok: true, videoUrl: null, outcomes, pruned: { deleted: [], failed: [] } }

  // A korabbi, elakadt torlesek ujraprobalasa (hibaja nem akasztja a posztolast).
  const before = await pruneHosted(deps.host)
  const up = await uploadPublicVideo({ bytes: input.bytes, publicId: `marveen/${input.clipKey}` }, deps.host)
  if (!up.ok) return { ok: false, code: up.code, detail: up.detail }
  db.prepare(`INSERT INTO wb_social_hosted (public_id, clip_key, url, bytes, uploaded_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(public_id) DO UPDATE SET url = excluded.url, bytes = excluded.bytes, uploaded_at = excluded.uploaded_at, delete_pending = 0, delete_error = NULL, deleted_at = NULL`)
    .run(up.publicId, input.clipKey, up.url, up.bytes, Math.floor(Date.now() / 1000))
  const after = await pruneHosted(deps.host)
  const pruned: PruneReport = { deleted: [...before.deleted, ...after.deleted], failed: after.failed }

  for (const c of todo) {
    const r = await createBufferPost({ channelId: c.id, service: c.service, text: input.text, videoUrl: up.url, draft: input.draft, dueAt: input.dueAt, title: input.title }, deps.buffer)
    if (!r.ok) { outcomes.push({ channelId: c.id, service: c.service, status: 'failed', code: r.code, detail: r.detail }); continue }
    db.prepare('INSERT OR IGNORE INTO wb_social_posts (id, work_item_id, clip_key, channel_id, service, buffer_post_id, draft, due_at, video_url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), input.workItemId, input.clipKey, c.id, c.service, r.postId, input.draft ? 1 : 0, input.dueAt ?? null, up.url, Math.floor(Date.now() / 1000))
    outcomes.push({ channelId: c.id, service: c.service, status: input.draft ? 'draft' : 'posted', postId: r.postId })
  }
  return { ok: true, videoUrl: up.url, outcomes, pruned }
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
