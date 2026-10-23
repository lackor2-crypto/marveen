/**
 * KOZOSSEGI KOZZETETEL A BUFFEREN AT (munkadarab "Video fejlesztes", 8. fazis, 8/b).
 *
 * A Buffer GraphQL API-ja (https://api.buffer.com, `Authorization: Bearer <kulcs>`); a mezoneveket a Buffer sajat
 * sema-leirasabol (introspekcio) olvastuk ki, nem talalgatjuk. A kulcs a Vaultban van (`buffer-api-key`).
 *
 * Szabalyok, amiket ez a fajl oriz:
 *   1. A VIDEO NYILVANOS, STABIL HTTPS-URL-EN KELL LEGYEN: a Buffernek nincs feltolto vegpontja. Mas URL-t nem engedunk at.
 *   2. NINCS ALAPERTELMEZETT "ELESBEN": a `createBufferPost` hivonak KIFEJEZETTEN meg kell mondania, hogy vazlat
 *      (`draft: true`) vagy valodi kozzetetel. A vazlat semmit nem tesz ki a nyilvanossag elé.
 *   3. A KULCS CSAK A FEJLECBEN megy; hibauzenetbe, naplóba nem kerul.
 */
import { getSecret } from './web/vault.js'

export const BUFFER_API_URL = 'https://api.buffer.com'
export const BUFFER_VAULT_ID = 'buffer-api-key'

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{
  ok: boolean; status: number; text(): Promise<string>
}>

export interface BufferDeps { fetchImpl?: FetchLike; getKey?: () => string | null; timeoutMs?: number }

export type BufferError = { ok: false; code: string; detail: string }

function keyOf(deps: BufferDeps): string | null {
  const k = deps.getKey ? deps.getKey() : getSecret(BUFFER_VAULT_ID)
  return k && k.trim() ? k.trim() : null
}

function clean(text: string, key: string): string {
  let t = String(text || '')
  if (key) t = t.split(key).join('***')
  return t.slice(0, 400)
}

async function gql<T>(deps: BufferDeps, query: string, variables?: Record<string, unknown>): Promise<{ ok: true; data: T } | BufferError> {
  const key = keyOf(deps)
  if (!key) return { ok: false, code: 'buffer_no_key', detail: 'no Buffer API key in the vault' }
  const f = deps.fetchImpl || (globalThis.fetch as unknown as FetchLike)
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), deps.timeoutMs ?? 30_000)
  try {
    const res = await f(BUFFER_API_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ query, variables }),
      signal: ctl.signal,
    })
    const raw = await res.text()
    if (res.status === 401 || res.status === 403) return { ok: false, code: 'buffer_key_rejected', detail: clean(raw, key) }
    if (!res.ok) return { ok: false, code: 'buffer_http_failed', detail: clean(`HTTP ${res.status} ${raw}`, key) }
    let j: { data?: T; errors?: { message?: string }[] }
    try { j = JSON.parse(raw) } catch { return { ok: false, code: 'buffer_bad_answer', detail: clean(raw, key) } }
    if (j.errors && j.errors.length) return { ok: false, code: 'buffer_query_failed', detail: clean(j.errors.map((e) => e.message || '').join('; '), key) }
    return { ok: true, data: j.data as T }
  } catch (e) {
    return { ok: false, code: 'buffer_unreachable', detail: clean(e instanceof Error ? e.message : 'network error', key) }
  } finally {
    clearTimeout(timer)
  }
}

export interface BufferChannel {
  id: string
  name: string
  /** pl. facebook, instagram, tiktok, youtube */
  service: string
  type: string | null
  isLocked: boolean
  isDisconnected: boolean
  timezone: string | null
}

/** A fiok szervezetei es azok bekotott csatornai. Csak olvas. */
export async function listBufferChannels(deps: BufferDeps = {}): Promise<{ ok: true; organizationId: string | null; channels: BufferChannel[] } | BufferError> {
  const orgs = await gql<{ account: { organizations: { id: string; name: string }[] } }>(deps, '{ account { organizations { id name } } }')
  if (!orgs.ok) return orgs
  const organizationId = orgs.data.account?.organizations?.[0]?.id ?? null
  if (!organizationId) return { ok: true, organizationId: null, channels: [] }
  const ch = await gql<{ channels: BufferChannel[] }>(deps,
    'query($org: OrganizationId!) { channels(input: { organizationId: $org }) { id name service type isLocked isDisconnected timezone } }', { org: organizationId })
  if (!ch.ok) return ch
  return { ok: true, organizationId, channels: ch.data.channels ?? [] }
}

export interface BufferPostInput {
  channelId: string
  /** A poszt szovege. */
  text: string
  /** A video NYILVANOS, STABIL, kozvetlen https-URL-je. */
  videoUrl: string
  /** KOTELEZO, kifejezett: `true` = vazlat (semmi nem megy ki), `false` = valodi kozzetetel/utemezes. */
  draft: boolean
  /** ISO idopont: megadva idozitett poszt (`customScheduled`); nelkule a Buffer sora (`addToQueue`). */
  dueAt?: string
  /** A csatorna szolgaltatasa (facebook / instagram / tiktok / youtube): a csatornankenti beallitasokhoz. */
  service?: string
  /** TikTok/YouTube cime. */
  title?: string
  thumbnailOffsetMs?: number
}

export function validatePublicVideoUrl(u: string): string | null {
  let url: URL
  try { url = new URL(u) } catch { return 'not a valid URL' }
  if (url.protocol !== 'https:') return 'the video URL must be https'
  const h = url.hostname.toLowerCase()
  if (h === 'localhost' || h.endsWith('.local') || /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h) || h === '::1') return 'the video URL must be public, not a local address'
  if (/(^|\.)(drive\.google\.com|dropbox\.com|onedrive\.live\.com|1drv\.ms)$/.test(h)) return 'share links (Drive, Dropbox, OneDrive) do not work: use a direct public file URL'
  return null
}

/** A csatornankenti beallitasok (a Buffer sema-leirasa szerint). */
function metadataFor(p: BufferPostInput): Record<string, unknown> | undefined {
  switch (p.service) {
    case 'instagram': return { instagram: { type: 'reel', shouldShareToFeed: true, isAiGenerated: true } }
    case 'facebook': return { facebook: { type: 'reel' } }
    case 'tiktok': return { tiktok: { isAiGenerated: true, ...(p.title ? { title: p.title.slice(0, 90) } : {}) } }
    case 'youtube': return { youtube: { privacy: 'public', madeForKids: false, isAiGenerated: true, notifySubscribers: true, ...(p.title ? { title: p.title.slice(0, 100) } : {}) } }
    default: return undefined
  }
}

export function buildCreatePostInput(p: BufferPostInput): Record<string, unknown> {
  const video: Record<string, unknown> = { url: p.videoUrl }
  if (p.thumbnailOffsetMs !== undefined) video['metadata'] = { thumbnailOffset: p.thumbnailOffsetMs }
  const input: Record<string, unknown> = {
    channelId: p.channelId,
    text: p.text,
    assets: [{ video }],
    schedulingType: 'automatic',
    mode: p.dueAt ? 'customScheduled' : 'addToQueue',
    saveToDraft: p.draft,
  }
  if (p.dueAt) input['dueAt'] = p.dueAt
  const meta = metadataFor(p)
  if (meta) input['metadata'] = meta
  return input
}

const CREATE_POST = `mutation($input: CreatePostInput!) {
  createPost(input: $input) {
    ... on PostActionSuccess { post { id text } }
    ... on MutationError { message }
  }
}`

export async function createBufferPost(p: BufferPostInput, deps: BufferDeps = {}): Promise<{ ok: true; postId: string; draft: boolean } | BufferError> {
  if (typeof p.draft !== 'boolean') return { ok: false, code: 'buffer_draft_flag_required', detail: 'draft must be true or false' }
  if (!p.channelId) return { ok: false, code: 'buffer_no_channel', detail: 'channelId is required' }
  if (!String(p.text || '').trim()) return { ok: false, code: 'buffer_no_text', detail: 'the post text is empty' }
  const bad = validatePublicVideoUrl(p.videoUrl)
  if (bad) return { ok: false, code: 'buffer_bad_video_url', detail: bad }
  if (p.dueAt && Number.isNaN(Date.parse(p.dueAt))) return { ok: false, code: 'buffer_bad_due_at', detail: 'dueAt must be an ISO date-time' }
  const r = await gql<{ createPost: { post?: { id: string }; message?: string } }>(deps, CREATE_POST, { input: buildCreatePostInput(p) })
  if (!r.ok) return r
  const out = r.data.createPost
  if (out?.post?.id) return { ok: true, postId: out.post.id, draft: p.draft }
  return { ok: false, code: 'buffer_post_rejected', detail: out?.message || 'Buffer did not create the post' }
}
