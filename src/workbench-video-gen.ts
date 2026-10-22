/**
 * AI-VIDEOGENERALAS az OpenRouteren at (munkadarab "Video fejlesztes", 3. fazis).
 *
 * Az OpenRouter video-protokollja (hivatalos dokumentacio, 2026-10-22):
 *   POST /api/v1/videos            -> 202 {id, polling_url, status: 'pending'}
 *   GET  /api/v1/videos/{id}       -> status: pending | in_progress | completed | failed
 *                                     (completed: unsigned_urls, usage.cost; failed: error)
 *   GET  /api/v1/videos/{id}/content?index=0  -> maga a videofajl (kulccsal)
 *   GET  /api/v1/videos/models     -> a modellek (NYILVANOS, kulcs nem kell)
 *
 * Ket szabaly, amit ez a fajl oriz:
 *   1. AZ AR SOSEM BEEGETETT. A modell sajat `pricing_skus` mezojebol szamoljuk, az elo listabol;
 *      ha nem ertjuk a mezoit, az ar `null` ("nem ismerjuk"), nem talalunk ki szamot.
 *   2. A KULCS CSAK A FEJLECBEN MEGY, hibauzenetbe, naplóba, URL-be soha.
 */

export const OPENROUTER_VIDEO_BASE = 'https://openrouter.ai/api/v1'

export interface VideoModel {
  id: string
  name: string
  resolutions: string[]
  aspectRatios: string[]
  durations: number[]
  /** `true`: tud hangot; `null`: a lista nem mond semmit. */
  audio: boolean | null
  skus: Record<string, string>
}

export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{
  ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string>; arrayBuffer(): Promise<ArrayBuffer>
}>

function asStrings(v: unknown): string[] { return Array.isArray(v) ? v.map(String) : [] }
function asNumbers(v: unknown): number[] { return Array.isArray(v) ? v.map(Number).filter((n) => Number.isFinite(n)) : [] }

export function parseVideoModels(body: unknown): VideoModel[] {
  const data = (body as { data?: unknown } | null)?.data
  if (!Array.isArray(data)) return []
  const out: VideoModel[] = []
  for (const raw of data) {
    const m = raw as Record<string, unknown>
    if (!m || typeof m['id'] !== 'string') continue
    const skus: Record<string, string> = {}
    const s = m['pricing_skus']
    if (s && typeof s === 'object') for (const [k, v] of Object.entries(s as Record<string, unknown>)) skus[k] = String(v)
    out.push({
      id: m['id'],
      name: typeof m['name'] === 'string' ? m['name'] : m['id'],
      resolutions: asStrings(m['supported_resolutions']),
      aspectRatios: asStrings(m['supported_aspect_ratios']),
      durations: asNumbers(m['supported_durations']).sort((a, b) => a - b),
      audio: typeof m['generate_audio'] === 'boolean' ? m['generate_audio'] : null,
      skus,
    })
  }
  return out
}

/** A modellek elo listaja. Nyilvanos vegpont: kulcs nelkul is megy. */
export async function listVideoModels(fetchImpl?: FetchLike, timeoutMs = 20_000): Promise<{ ok: true; models: VideoModel[] } | { ok: false; code: string; detail: string }> {
  const f = fetchImpl || (globalThis.fetch as unknown as FetchLike)
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const res = await f(`${OPENROUTER_VIDEO_BASE}/videos/models`, { method: 'GET', signal: ctl.signal })
    if (!res.ok) return { ok: false, code: 'video_models_failed', detail: `HTTP ${res.status}` }
    return { ok: true, models: parseVideoModels(await res.json()) }
  } catch (e) {
    return { ok: false, code: 'video_models_unreachable', detail: e instanceof Error ? e.message : 'network error' }
  } finally {
    clearTimeout(timer)
  }
}

export interface VideoParams {
  duration: number
  resolution: string
  aspect_ratio: string
  audio: boolean
}

/**
 * A varhato koltseg USD-ben. A modell `pricing_skus` mezoit olvassuk (a ket ismert alak:
 * `duration_seconds[_with|_without_audio][_<felbontas>]` USD/mp, `cents_per_video_output_second_<felbontas>` cent/mp).
 * `null`, ha egyik sem illik: akkor a felulet azt mondja, hogy az arat nem ismerjuk.
 */
export function estimateVideoCost(model: VideoModel, p: VideoParams): number | null {
  const s = model.skus
  const a = p.audio ? 'with_audio' : 'without_audio'
  const res = p.resolution
  const perSecond: (number | null)[] = [
    num(s[`duration_seconds_${a}_${res}`]),
    num(s[`duration_seconds_${a}`]),
    num(s[`duration_seconds_${res}`]),
    cents(s[`cents_per_video_output_second_${res}`]),
    num(s['duration_seconds']),
  ]
  const price = perSecond.find((x) => x !== null)
  if (price === undefined || price === null) return null
  return Math.round(price * p.duration * 10000) / 10000
}

function num(v: string | undefined): number | null {
  if (v === undefined) return null
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? n : null
}
function cents(v: string | undefined): number | null {
  const n = num(v)
  return n === null ? null : n / 100
}

/** A kert beallitasok ellenorzese a modell sajat listaja ellen (a nem tamogatottat az OpenRouter 400-zal utasitana el, penz nelkul, de itt mar elobb szolunk). */
export function validateVideoParams(model: VideoModel, p: VideoParams): { ok: true } | { ok: false; code: string; detail: string } {
  if (model.durations.length && !model.durations.includes(p.duration)) return { ok: false, code: 'video_bad_duration', detail: model.durations.join(', ') }
  if (model.resolutions.length && !model.resolutions.includes(p.resolution)) return { ok: false, code: 'video_bad_resolution', detail: model.resolutions.join(', ') }
  if (model.aspectRatios.length && !model.aspectRatios.includes(p.aspect_ratio)) return { ok: false, code: 'video_bad_aspect', detail: model.aspectRatios.join(', ') }
  if (p.audio && model.audio === null) return { ok: false, code: 'video_audio_unknown', detail: 'the model list does not say this model makes sound' }
  return { ok: true }
}

export type StartResult =
  | { ok: true; id: string; pollingUrl: string | null }
  | { ok: false; code: string; detail: string; /** A kerest elkuldtuk-e: ha igen, tilos ujraprobalni. */ maybeStarted: boolean }

/** A szolgaltato hibauzenetebol a kulcs kiszurve. */
function clean(text: string, key: string): string {
  let t = String(text || '')
  if (key) t = t.split(key).join('***')
  return t.slice(0, 300)
}

async function errDetail(res: { status: number; text(): Promise<string> }, key: string): Promise<string> {
  let body = ''
  try { body = await res.text() } catch { /* a statusz is elég */ }
  let msg = ''
  try {
    const j = JSON.parse(body) as { error?: { message?: string } | string; message?: string }
    msg = typeof j.error === 'string' ? j.error : j.error?.message || j.message || ''
  } catch { msg = body }
  return clean(`HTTP ${res.status}${msg ? ': ' + msg : ''}`, key)
}

export async function startVideo(input: {
  key: string; model: string; prompt: string; params: VideoParams; fetchImpl?: FetchLike; timeoutMs?: number
}): Promise<StartResult> {
  const f = input.fetchImpl || (globalThis.fetch as unknown as FetchLike)
  const body = {
    model: input.model,
    prompt: input.prompt,
    duration: input.params.duration,
    resolution: input.params.resolution,
    aspect_ratio: input.params.aspect_ratio,
    generate_audio: input.params.audio,
  }
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), input.timeoutMs ?? 60_000)
  try {
    const res = await f(`${OPENROUTER_VIDEO_BASE}/videos`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${input.key}` },
      body: JSON.stringify(body),
      signal: ctl.signal,
    })
    if (!res.ok) {
      // 4xx: a szolgaltato elutasitotta, penz nem ment el. 5xx: nem biztos.
      return { ok: false, code: res.status === 401 || res.status === 403 ? 'video_key_rejected' : res.status === 402 ? 'video_no_credit' : 'video_start_failed', detail: await errDetail(res, input.key), maybeStarted: res.status >= 500 }
    }
    const j = (await res.json()) as { id?: unknown; polling_url?: unknown }
    if (typeof j.id !== 'string' || !j.id) return { ok: false, code: 'video_start_failed', detail: 'no job id in the answer', maybeStarted: true }
    return { ok: true, id: j.id, pollingUrl: typeof j.polling_url === 'string' ? j.polling_url : null }
  } catch (e) {
    // Idotullepes / megszakadt kapcsolat: a kerés LEHET, hogy elment -> nem probalkozunk ujra magunktol.
    return { ok: false, code: 'video_start_unreachable', detail: clean(e instanceof Error ? e.message : 'network error', input.key), maybeStarted: true }
  } finally {
    clearTimeout(timer)
  }
}

export type VideoStatus =
  | { ok: true; status: 'pending' | 'in_progress' | 'completed' | 'failed'; costUsd: number | null; error: string | null }
  | { ok: false; code: string; detail: string }

export async function getVideoStatus(input: { key: string; id: string; fetchImpl?: FetchLike; timeoutMs?: number }): Promise<VideoStatus> {
  const f = input.fetchImpl || (globalThis.fetch as unknown as FetchLike)
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), input.timeoutMs ?? 30_000)
  try {
    const res = await f(`${OPENROUTER_VIDEO_BASE}/videos/${encodeURIComponent(input.id)}`, {
      method: 'GET', headers: { authorization: `Bearer ${input.key}` }, signal: ctl.signal,
    })
    if (!res.ok) return { ok: false, code: 'video_status_failed', detail: await errDetail(res, input.key) }
    const j = (await res.json()) as { status?: unknown; error?: unknown; usage?: { cost?: unknown } }
    const st = String(j.status ?? '')
    if (st !== 'pending' && st !== 'in_progress' && st !== 'completed' && st !== 'failed') return { ok: false, code: 'video_status_unknown', detail: clean(st, input.key) }
    const cost = Number(j.usage?.cost)
    const err = j.error == null ? null : typeof j.error === 'string' ? j.error : JSON.stringify(j.error)
    return { ok: true, status: st, costUsd: j.usage?.cost !== undefined && Number.isFinite(cost) ? cost : null, error: err ? clean(err, input.key) : null }
  } catch (e) {
    return { ok: false, code: 'video_status_unreachable', detail: clean(e instanceof Error ? e.message : 'network error', input.key) }
  } finally {
    clearTimeout(timer)
  }
}

/** A kesz videofajl. Az ideiglenes URL-t nem tartjuk meg: azonnal letoltjuk. */
export async function downloadVideo(input: { key: string; id: string; fetchImpl?: FetchLike; timeoutMs?: number }): Promise<{ ok: true; bytes: Buffer } | { ok: false; code: string; detail: string }> {
  const f = input.fetchImpl || (globalThis.fetch as unknown as FetchLike)
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), input.timeoutMs ?? 300_000)
  try {
    const res = await f(`${OPENROUTER_VIDEO_BASE}/videos/${encodeURIComponent(input.id)}/content?index=0`, {
      method: 'GET', headers: { authorization: `Bearer ${input.key}` }, signal: ctl.signal,
    })
    if (!res.ok) return { ok: false, code: 'video_download_failed', detail: await errDetail(res, input.key) }
    const bytes = Buffer.from(await res.arrayBuffer())
    if (bytes.length < 1000) return { ok: false, code: 'video_download_empty', detail: `${bytes.length} bytes` }
    return { ok: true, bytes }
  } catch (e) {
    return { ok: false, code: 'video_download_unreachable', detail: clean(e instanceof Error ? e.message : 'network error', input.key) }
  } finally {
    clearTimeout(timer)
  }
}
