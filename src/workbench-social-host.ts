/**
 * NYILVANOS TARHELY A KOZOSSEGI VIDEOKNAK (munkadarab "Video fejlesztes", 8/c).
 *
 * A Buffernek nincs feltolto vegpontja: a videonak nyilvanos, stabil https-URL-en kell allnia a posztolasig. Itt egy
 * Cloudinary-szeru tarhelyre toltjuk fel (alairt feltoltes, a kimeno URL NEM aláirt/lejaro). A hozzaferes egyetlen
 * Vault-bejegyzes `cloudinary-url` neven, `cloudinary://<api_key>:<api_secret>@<cloud_name>` alakban.
 * A titok csak a feltoltes alairasaban hasznalt, hibauzenetbe, naplóba nem kerul.
 */
import { createHash } from 'node:crypto'
import { getSecret } from './web/vault.js'

export const HOST_VAULT_ID = 'cloudinary-url'

export interface HostConfig { cloudName: string; apiKey: string; apiSecret: string }

export function parseCloudinaryUrl(raw: string | null): HostConfig | null {
  if (!raw) return null
  const m = /^cloudinary:\/\/([^:@\s]+):([^@\s]+)@([^/\s]+)\/?$/.exec(raw.trim())
  return m ? { apiKey: m[1], apiSecret: m[2], cloudName: m[3] } : null
}

export function hostConfigFromVault(): HostConfig | null { return parseCloudinaryUrl(getSecret(HOST_VAULT_ID)) }

export type HostFetch = (url: string, init: { method: string; body: FormData; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>

export interface HostDeps { fetchImpl?: HostFetch; config?: HostConfig | null; now?: () => number; timeoutMs?: number }

/** A Cloudinary-alairas: a kuldott parameterek (a file, api_key, resource_type nelkul) abc-sorrendben, a titokkal egybefuzve, SHA-1. */
export function signUpload(params: Record<string, string | number>, apiSecret: string): string {
  const s = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('&')
  return createHash('sha1').update(s + apiSecret).digest('hex')
}

export type UploadResult = { ok: true; url: string; publicId: string; bytes: number } | { ok: false; code: string; detail: string }

export async function uploadPublicVideo(input: { bytes: Buffer; publicId: string }, deps: HostDeps = {}): Promise<UploadResult> {
  const cfg = deps.config === undefined ? hostConfigFromVault() : deps.config
  if (!cfg) return { ok: false, code: 'host_not_configured', detail: `no ${HOST_VAULT_ID} in the vault` }
  if (!input.bytes.length) return { ok: false, code: 'host_empty_file', detail: 'the video file is empty' }
  const timestamp = Math.floor((deps.now ? deps.now() : Date.now()) / 1000)
  const publicId = input.publicId.replace(/[^A-Za-z0-9_\-/]+/g, '-').slice(0, 120)
  const form = new FormData()
  form.set('file', new Blob([new Uint8Array(input.bytes)], { type: 'video/mp4' }), `${publicId.split('/').pop()}.mp4`)
  form.set('api_key', cfg.apiKey)
  form.set('timestamp', String(timestamp))
  form.set('public_id', publicId)
  form.set('signature', signUpload({ public_id: publicId, timestamp }, cfg.apiSecret))
  const f = deps.fetchImpl || (globalThis.fetch as unknown as HostFetch)
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), deps.timeoutMs ?? 300_000)
  const hide = (t: string): string => t.split(cfg.apiSecret).join('***').slice(0, 300)
  try {
    const res = await f(`https://api.cloudinary.com/v1_1/${encodeURIComponent(cfg.cloudName)}/video/upload`, { method: 'POST', body: form, signal: ctl.signal })
    const raw = await res.text()
    let j: { secure_url?: string; public_id?: string; bytes?: number; error?: { message?: string } } = {}
    try { j = JSON.parse(raw) } catch { /* nem JSON */ }
    if (!res.ok) return { ok: false, code: res.status === 401 || res.status === 403 ? 'host_key_rejected' : 'host_upload_failed', detail: hide(j.error?.message || `HTTP ${res.status}`) }
    if (!j.secure_url || !j.secure_url.startsWith('https://')) return { ok: false, code: 'host_bad_answer', detail: hide(raw) }
    return { ok: true, url: j.secure_url, publicId: j.public_id || publicId, bytes: j.bytes ?? input.bytes.length }
  } catch (e) {
    return { ok: false, code: 'host_unreachable', detail: hide(e instanceof Error ? e.message : 'network error') }
  } finally {
    clearTimeout(timer)
  }
}

export type DeleteResult = { ok: true; existed: boolean } | { ok: false; code: string; detail: string }

/** Egy feltoltott video torlese a tarhelyrol (alairt `destroy` kerés; a "not found" is siker: mar nincs ott). A titok sehova nem kerul. */
export async function deletePublicVideo(publicId: string, deps: HostDeps = {}): Promise<DeleteResult> {
  const cfg = deps.config === undefined ? hostConfigFromVault() : deps.config
  if (!cfg) return { ok: false, code: 'host_not_configured', detail: `no ${HOST_VAULT_ID} in the vault` }
  const timestamp = Math.floor((deps.now ? deps.now() : Date.now()) / 1000)
  const form = new FormData()
  form.set('api_key', cfg.apiKey)
  form.set('timestamp', String(timestamp))
  form.set('public_id', publicId)
  form.set('signature', signUpload({ public_id: publicId, timestamp }, cfg.apiSecret))
  const f = deps.fetchImpl || (globalThis.fetch as unknown as HostFetch)
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), deps.timeoutMs ?? 60_000)
  const hide = (t: string): string => t.split(cfg.apiSecret).join('***').slice(0, 300)
  try {
    const res = await f(`https://api.cloudinary.com/v1_1/${encodeURIComponent(cfg.cloudName)}/video/destroy`, { method: 'POST', body: form, signal: ctl.signal })
    const raw = await res.text()
    let j: { result?: string; error?: { message?: string } } = {}
    try { j = JSON.parse(raw) } catch { /* nem JSON */ }
    if (!res.ok) return { ok: false, code: res.status === 401 || res.status === 403 ? 'host_key_rejected' : 'host_delete_failed', detail: hide(j.error?.message || `HTTP ${res.status}`) }
    if (j.result === 'ok') return { ok: true, existed: true }
    if (j.result === 'not found') return { ok: true, existed: false }
    return { ok: false, code: 'host_delete_failed', detail: hide(raw) }
  } catch (e) {
    return { ok: false, code: 'host_unreachable', detail: hide(e instanceof Error ? e.message : 'network error') }
  } finally {
    clearTimeout(timer)
  }
}
