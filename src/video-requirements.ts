/**
 * The minimum a video needs (#765): the value rules the setup wizard applies before it saves a key, and the
 * live "does it really work" checks behind the wizard's "Try it" button.
 *
 * Two rules this file keeps:
 *   1. A check answers with a MEASUREMENT or says it could not measure. "401" is "the service refused the key";
 *      a timeout or an odd status is "could not check" -- never "the key is bad" (the zero means two things).
 *   2. A key never leaves this file in text: not in an answer, not in a log. Answers carry a code and plain params.
 */
import { listBufferChannels, type BufferChannel, type BufferDeps } from './workbench-social-buffer.js'
import { parseCloudinaryUrl } from './workbench-social-host.js'
import { OPENROUTER_VIDEO_BASE, type FetchLike } from './workbench-video-gen.js'

/** The channels the free Buffer plan carries (Boss decision, #765): three, LinkedIn is out. */
export const BUFFER_FREE_SERVICES = ['facebook', 'instagram', 'tiktok'] as const

export type SaveCheck = { ok: true; value: string } | { ok: false; code: string }

/**
 * What the owner pastes for the Cloudinary row. The console shows the value as `CLOUDINARY_URL=cloudinary://...`
 * (sometimes with a `<your_api_secret>` placeholder still in it), so the prefix and quotes are stripped, and a
 * leftover placeholder is refused by name instead of being saved as a "key".
 */
export function normalizeCloudinaryInput(raw: string): SaveCheck {
  let v = String(raw ?? '').trim()
  v = v.replace(/^(export\s+)?CLOUDINARY_URL\s*=\s*/i, '').replace(/^["']|["']$/g, '').trim()
  if (/[<>]/.test(v) || /your_api_(key|secret)/i.test(v)) return { ok: false, code: 'cloudinary_placeholder' }
  if (!parseCloudinaryUrl(v)) return { ok: false, code: 'cloudinary_format' }
  return { ok: true, value: v }
}

/** Generic rule for the other Vault keys: one line, no spaces, not absurdly long. */
export function normalizePlainKey(raw: string): SaveCheck {
  const v = String(raw ?? '').trim().replace(/^["']|["']$/g, '').replace(/^Bearer\s+/i, '')
  if (!v) return { ok: false, code: 'key_empty' }
  if (/\s/.test(v) || v.length > 512) return { ok: false, code: 'key_format' }
  return { ok: true, value: v }
}

export interface CheckResult {
  /** ok = measured and fine; warn = works but something is missing; bad = the service refused; unknown = could not measure. */
  tone: 'ok' | 'warn' | 'bad' | 'unknown'
  /** i18n suffix: `wizard.check.<code>` */
  code: string
  params?: Record<string, string | number>
}

type CheckDeps = { fetchImpl?: FetchLike; getKey?: () => string | null; timeoutMs?: number }

async function call(f: FetchLike, url: string, headers: Record<string, string>, timeoutMs: number): Promise<{ status: number } | { error: true }> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const r = await f(url, { method: 'GET', headers, signal: ctl.signal })
    return { status: r.status }
  } catch {
    return { error: true }
  } finally {
    clearTimeout(timer)
  }
}

function fromStatus(status: number, okCode: string, rejectedCode: string): CheckResult {
  if (status >= 200 && status < 300) return { tone: 'ok', code: okCode }
  if (status === 401 || status === 403) return { tone: 'bad', code: rejectedCode }
  return { tone: 'unknown', code: 'unexpected', params: { status } }
}

/** OpenRouter: `GET /api/v1/key` describes the key behind the Bearer token; it costs nothing. */
export async function checkOpenRouter(deps: CheckDeps & { key: string | null }): Promise<CheckResult> {
  if (!deps.key) return { tone: 'bad', code: 'no_key' }
  const f = deps.fetchImpl ?? (globalThis.fetch as unknown as FetchLike)
  const r = await call(f, `${OPENROUTER_VIDEO_BASE}/key`, { authorization: `Bearer ${deps.key}` }, deps.timeoutMs ?? 15_000)
  if ('error' in r) return { tone: 'unknown', code: 'unreachable' }
  return fromStatus(r.status, 'openrouter_ok', 'key_rejected')
}

/** Cloudinary: the Admin API `ping`, signed with the key and secret in the URL value; it uploads nothing. */
export async function checkCloudinary(deps: CheckDeps & { url: string | null }): Promise<CheckResult> {
  const cfg = parseCloudinaryUrl(deps.url)
  if (!deps.url) return { tone: 'bad', code: 'no_key' }
  if (!cfg) return { tone: 'bad', code: 'cloudinary_format' }
  const f = deps.fetchImpl ?? (globalThis.fetch as unknown as FetchLike)
  const basic = Buffer.from(`${cfg.apiKey}:${cfg.apiSecret}`).toString('base64')
  const r = await call(f, `https://api.cloudinary.com/v1_1/${encodeURIComponent(cfg.cloudName)}/ping`, { authorization: `Basic ${basic}` }, deps.timeoutMs ?? 15_000)
  if ('error' in r) return { tone: 'unknown', code: 'unreachable' }
  return fromStatus(r.status, 'cloudinary_ok', 'key_rejected')
}

/** Which of the free-plan services have a usable (connected, unlocked) channel, which do not. */
export function judgeBufferChannels(channels: BufferChannel[]): CheckResult {
  const usable = channels.filter((c) => !c.isDisconnected && !c.isLocked)
  const have = new Set(usable.map((c) => String(c.service).toLowerCase()))
  const NAMES: Record<string, string> = { facebook: 'Facebook', instagram: 'Instagram', tiktok: 'TikTok', youtube: 'YouTube', linkedin: 'LinkedIn' }
  const label = (s: string): string => NAMES[s] ?? s.charAt(0).toUpperCase() + s.slice(1)
  const missing = BUFFER_FREE_SERVICES.filter((s) => !have.has(s))
  const broken = channels.filter((c) => c.isDisconnected || c.isLocked).map((c) => label(String(c.service).toLowerCase()))
  if (usable.length === 0) return { tone: 'warn', code: 'buffer_no_channel', params: { missing: missing.map(label).join(', ') } }
  const connected = [...have].map(label).join(', ')
  if (broken.length > 0) return { tone: 'warn', code: 'buffer_broken', params: { connected, broken: broken.join(', ') } }
  if (missing.length > 0) return { tone: 'warn', code: 'buffer_partial', params: { connected, missing: missing.map(label).join(', ') } }
  return { tone: 'ok', code: 'buffer_ok', params: { connected } }
}

/** Buffer: the key opens the account, and the connected channels are listed (read-only, nothing is posted). */
export async function checkBuffer(deps: BufferDeps & { key: string | null }): Promise<CheckResult> {
  if (!deps.key) return { tone: 'bad', code: 'no_key' }
  const r = await listBufferChannels({ ...deps, getKey: () => deps.key })
  if (!r.ok) {
    if (r.code === 'buffer_key_rejected') return { tone: 'bad', code: 'key_rejected' }
    if (r.code === 'buffer_unreachable') return { tone: 'unknown', code: 'unreachable' }
    return { tone: 'unknown', code: 'unexpected', params: { status: r.code } }
  }
  return judgeBufferChannels(r.channels)
}
