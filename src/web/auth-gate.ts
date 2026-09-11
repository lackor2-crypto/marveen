// Unified auth resolution for the dashboard HTTP gate.
//
// Extracted from the inline gate that used to live in src/web.ts so the
// precedence is unit-testable (auth-gate.test.ts is the fleet-regression
// contract). The BEARER path is checked first and is byte-for-byte unchanged:
// every fleet curl call, notify.sh, the channels auth probe and the federation
// wire endpoints keep working with zero change, whether or not any dashboard
// user exists.
//
// Precedence (first match wins):
//   1. Authorization: Bearer <dashboard token>   -> { kind: 'token' }
//   2. Authorization: Bearer <device key>        -> { kind: 'device', device, deviceId }
//   3. SSE pane-stream ?token=<dashboard token>   -> { kind: 'token' }  (path-scoped)
//   4. SSE pane-stream ?token=<device key>        -> { kind: 'device' } (path-scoped)
//   5. Autofill token, endpoint-scoped            -> { kind: 'autofill', client }
//   6. Federation inbound token, endpoint-scoped  -> { kind: 'federation', peer }
//   7. mv_session cookie                          -> { kind: 'session', user }
//   8. none of the above                          -> { kind: 'none' }
//
// requiresAuth() is the separate "is this path gated at all" predicate: public
// probes (auth status, login, avatars) return false; everything under /api/ and
// the fleet manifest return true.

import type http from 'node:http'
import { checkBearerToken } from './dashboard-auth.js'
import { identifyFederationCaller } from './federation/config.js'
import { resolveSession } from './auth-sessions.js'
import { resolveDeviceKey } from './auth-device-keys.js'
import { resolveAutofillClient } from './autofill-clients.js'

export type AuthResult =
  | { kind: 'token' }
  | { kind: 'device'; device: string; deviceId: number }
  | { kind: 'federation'; peer: string }
  | { kind: 'session'; user: string }
  | { kind: 'autofill'; client: string; clientId: number }
  | { kind: 'none' }

export const SESSION_COOKIE_NAME = 'mv_session'

// Minimal, allocation-light cookie parser. Only the values we look up matter;
// malformed pairs are skipped rather than throwing.
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    const name = part.slice(0, eq).trim()
    if (!name) continue
    const value = part.slice(eq + 1).trim()
    if (out[name] === undefined) out[name] = value
  }
  return out
}

function isSsePaneStream(path: string, method: string): boolean {
  return method === 'GET' && /^\/api\/agents\/[^/]+\/pane\/stream$/.test(path)
}

/**
 * The browser extension's wire endpoints (card 21311fdb / #96).
 *
 * The autofill token is scoped here and NOWHERE else, the same way federation
 * tokens are scoped to their two endpoints. A browser extension is the most
 * exposed client in the house; if its token ever leaks, what leaks with it is
 * "ask for the login of a site you already paired", not the dashboard.
 *
 * OPTIONS is included because the browser sends the CORS preflight without
 * credentials -- refusing it would block the real request that follows.
 */
export function isAutofillWireEndpoint(path: string, method: string): boolean {
  if (method === 'OPTIONS') return path.startsWith('/api/autofill/')
  return method === 'POST' && (
    path === '/api/autofill/pair' ||
    path === '/api/autofill/lookup' ||
    path === '/api/autofill/credential'
  )
}

export function isFederationWireEndpoint(path: string, method: string): boolean {
  return (
    (path === '/api/federation/manifest' && method === 'GET') ||
    (path === '/api/federation/inbox' && method === 'POST')
  )
}

// Public (ungated) surfaces. These mirror the old inline exceptions exactly,
// plus the new POST /api/auth/login (public + throttled) so the login form can
// reach the server before a session exists.
export function requiresAuth(path: string, method: string): boolean {
  if (path === '/api/auth/status' && method === 'GET') return false
  if (path === '/api/auth/login' && method === 'POST') return false
  if (method === 'GET' && (path === '/api/marveen/avatar' || /^\/api\/agents\/[^/]+\/avatar$/.test(path))) return false
  // Pairing carries its own credential -- the short code the user reads off the
  // dashboard -- so it cannot require one of the others. The preflight carries
  // none at all, by definition.
  if (path === '/api/autofill/pair' && method === 'POST') return false
  if (method === 'OPTIONS' && path.startsWith('/api/autofill/')) return false
  if (path === '/.well-known/fleetq' && method === 'GET') return true
  return path.startsWith('/api/')
}

export function resolveAuth(
  req: http.IncomingMessage,
  url: URL,
  path: string,
  method: string,
  dashboardToken: string,
): AuthResult {
  // 1. Bearer header -- unchanged, highest precedence.
  if (checkBearerToken(req.headers.authorization, dashboardToken)) return { kind: 'token' }

  // 2. Bearer device key. Runs only after the dashboard token failed to match,
  //    so the token lane stays byte-identical; resolveDeviceKey's prefix check
  //    makes this a no-op for every non-key bearer (and with zero device_keys
  //    rows the whole step never resolves -- fresh installs unaffected).
  const bearerMatch = /^Bearer\s+(.+)$/.exec(req.headers.authorization ?? '')
  if (bearerMatch) {
    const dk = resolveDeviceKey(bearerMatch[1]!.trim())
    if (dk) return { kind: 'device', device: dk.name, deviceId: dk.id }
  }

  // 3. SSE pane stream ?token= (EventSource cannot set an Authorization header):
  //    dashboard token first, then device key -- a device must be able to open
  //    the pane stream too, or the dashboard would look half-broken on it.
  if (isSsePaneStream(path, method)) {
    const qtoken = url.searchParams.get('token') ?? ''
    if (checkBearerToken(`Bearer ${qtoken}`, dashboardToken)) return { kind: 'token' }
    const dk = resolveDeviceKey(qtoken)
    if (dk) return { kind: 'device', device: dk.name, deviceId: dk.id }
  }

  // 4. The browser extension's own token: valid ONLY on the autofill wire
  //    endpoints. It is checked here rather than in the bearer lane above so
  //    that a leaked extension token cannot be replayed against any other
  //    endpoint -- the scope is enforced by the gate, not by good manners in
  //    the route.
  if (isAutofillWireEndpoint(path, method) && bearerMatch) {
    const client = resolveAutofillClient(bearerMatch[1]!.trim())
    if (client) return { kind: 'autofill', client: client.name, clientId: client.id }
  }

  // 5. Scoped per-peer federation tokens: valid ONLY on the two wire endpoints,
  //    and only while federation is enabled (identifyFederationCaller fail-closes).
  if (isFederationWireEndpoint(path, method)) {
    const peer = identifyFederationCaller(req.headers.authorization, checkBearerToken)
    if (peer !== null) return { kind: 'federation', peer }
  }

  // 6. Browser-login session cookie.
  const cookieValue = parseCookies(req.headers.cookie)[SESSION_COOKIE_NAME]
  if (cookieValue) {
    const session = resolveSession(cookieValue)
    if (session) return { kind: 'session', user: session.username }
  }

  return { kind: 'none' }
}
