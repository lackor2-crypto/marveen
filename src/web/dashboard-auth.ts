import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { PROJECT_ROOT } from '../config.js'
import { atomicWriteFileSync } from './atomic-write.js'

// A single bearer token gates every /api/* route. It is loaded from
// DASHBOARD_TOKEN if set, otherwise persisted at store/.dashboard-token
// (mode 0600) and auto-generated on first run. Static assets (/, /index.html,
// /style.css, /app.js, /avatars/*) and the auth-status endpoint stay public
// so the UI can bootstrap itself.
export const DASHBOARD_TOKEN_PATH = join(PROJECT_ROOT, 'store', '.dashboard-token')

/** The shortest token the FILE may hand us. A generated token is 64 hex chars
 *  (256 bits); 32 is the floor below which a value is a typed-in word, not a
 *  secret. Measured 2026-09-27 (#415): an agent ran
 *  `echo "test-token-placeholder" > store/.dashboard-token`, and the next
 *  restart would have made that guessable string the dashboard's password. */
export const MIN_FILE_TOKEN_LENGTH = 32

/** The operator-supplied token, or null when the file is the source. When the
 *  env gives the token, the file is not ours to police or rewrite. */
export function dashboardTokenFromEnv(): string | null {
  return process.env.DASHBOARD_TOKEN?.trim() || null
}

let weakFileTokenReplaced: number | null = null

/** When this process refused a too-short token from the file at startup and
 *  wrote a fresh one instead (epoch ms), or null. The token guard reports it. */
export function weakFileTokenReplacedAt(): number | null {
  return weakFileTokenReplaced
}

export function loadOrCreateDashboardToken(tokenPath: string = DASHBOARD_TOKEN_PATH): string {
  const fromEnv = dashboardTokenFromEnv()
  if (fromEnv) return fromEnv
  try {
    if (existsSync(tokenPath)) {
      const cached = readFileSync(tokenPath, 'utf-8').trim()
      if (cached.length >= MIN_FILE_TOKEN_LENGTH) return cached
      // A non-empty but short value is not a token anybody generated -- it is
      // what an overwrite leaves behind. Replace it rather than adopt it.
      if (cached) weakFileTokenReplaced = Date.now()
    }
  } catch { /* fall through and regenerate */ }
  const fresh = randomBytes(32).toString('hex')
  mkdirSync(dirname(tokenPath), { recursive: true })
  atomicWriteFileSync(tokenPath, fresh, { mode: 0o600 })
  return fresh
}

export function checkBearerToken(header: string | undefined, expected: string): boolean {
  if (!header) return false
  const m = /^Bearer\s+(.+)$/.exec(header)
  if (!m) return false
  const provided = Buffer.from(m[1].trim())
  const wanted = Buffer.from(expected)
  if (provided.length !== wanted.length) return false
  return timingSafeEqual(provided, wanted)
}
