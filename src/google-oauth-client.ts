// A Google OAuth kliens-fajl (store/google-oauth-client.json) FELTOLTESE a
// feluletrol (kanban f97acc32, friss-telepitesi audit).
//
// Eddig a Beallitas varazslo 5. lepese ez volt: "A letoltott fajlt masold be
// ide, ezen a neven: store/google-oauth-client.json". Egy friss telepitesen a
// felhasznalo ezt terminal vagy fajlkezelo nelkul nem tudta megcsinalni -- es
// enelkul se level, se naptar, se Drive, se Fotok. Most a varazsloban egy
// gombbal feltoltheti a Google-tol letoltott fajlt.
//
// A fajl TITKOT tart (client_secret). Ezert:
//   - csak a Google "Asztali alkalmazas" (installed) kliense megy at: a
//     bejelentkezes loopback-cimre (http://localhost:<port>/) ter vissza, amit
//     a Google csak asztali kliensnel fogad el tetszoleges portra -- egy "web"
//     kliens a bejelentkezes VEGEN bukna el, redirect_uri_mismatch-csel,
//     ami egy nem programozonak megfejthetetlen;
//   - meglevo fajlt csak kimondott `replace`-szel irunk felul (a masik fajl
//     egy mukodo bekotes lehet, es a csere minden fiokot kilepteti);
//   - atomikusan irjuk, 0600 joggal; a tartalmat sehol nem naplozzuk.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { STORE_DIR } from './config.js'
import { atomicWriteFileSync } from './web/atomic-write.js'

export const GOOGLE_OAUTH_CLIENT_FILE = 'google-oauth-client.json'

export function googleOauthClientPath(storeDir: string = STORE_DIR): string {
  return join(storeDir, GOOGLE_OAUTH_CLIENT_FILE)
}

/** A felulet ezekbol a kodokbol valaszt emberi mondatot (hu.js / en.js). */
export type OauthClientError =
  | 'too_big'
  | 'not_json'
  | 'no_client'
  | 'web_client'
  | 'no_client_id'
  | 'no_client_secret'
  | 'exists'

export type OauthClientCheck =
  | { ok: true; clientJson: string; projectId: string }
  | { ok: false; error: OauthClientError }

/** Egy valodi kliens-fajl ~500 bajt; ennel joval nagyobb nem kliens-fajl. */
const MAX_BYTES = 64 * 1024

/**
 * Ellenorzi a feltoltott szoveget. NEM ir semmit.
 *
 * A visszaadott `clientJson` a Google eredeti szerkezete (`installed` ag), mert
 * a `scripts/google-auth.py` es a `google-auth-runner.ts` is ezt olvassa.
 */
export function checkOauthClientText(text: string): OauthClientCheck {
  const raw = String(text ?? '')
  if (Buffer.byteLength(raw, 'utf-8') > MAX_BYTES) return { ok: false, error: 'too_big' }
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return { ok: false, error: 'not_json' } }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, error: 'no_client' }
  const o = parsed as Record<string, unknown>
  const installed = o.installed
  if (!installed || typeof installed !== 'object') {
    return { ok: false, error: o.web && typeof o.web === 'object' ? 'web_client' : 'no_client' }
  }
  const node = installed as Record<string, unknown>
  const clientId = typeof node.client_id === 'string' ? node.client_id.trim() : ''
  if (!/^[\w.-]+\.apps\.googleusercontent\.com$/.test(clientId)) return { ok: false, error: 'no_client_id' }
  const secret = typeof node.client_secret === 'string' ? node.client_secret.trim() : ''
  if (!secret) return { ok: false, error: 'no_client_secret' }
  const projectId = typeof node.project_id === 'string' ? node.project_id : ''
  return { ok: true, clientJson: JSON.stringify({ installed: node }, null, 2) + '\n', projectId }
}

/**
 * Ellenoriz es ment. Meglevo fajlt csak `replace: true` mellett ir felul.
 */
export function saveOauthClient(
  text: string,
  opts: { replace?: boolean; storeDir?: string } = {},
): { ok: true; projectId: string; replaced: boolean } | { ok: false; error: OauthClientError } {
  const check = checkOauthClientText(text)
  if (!check.ok) return check
  const path = googleOauthClientPath(opts.storeDir)
  const existed = existsSync(path)
  if (existed && !opts.replace) return { ok: false, error: 'exists' }
  atomicWriteFileSync(path, check.clientJson, { mode: 0o600 })
  return { ok: true, projectId: check.projectId, replaced: existed }
}
