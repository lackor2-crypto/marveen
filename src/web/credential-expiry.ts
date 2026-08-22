/**
 * Credentials that expire on a clock, surfaced before they die.
 *
 * Boss, 2026-08-19: "erre tegyel egy tesztet, figyelest. ha lejar valami
 * szoljon a attekintes menupontban. es mondja hogy mit kell tenni." -- and
 * then: "csinald ugy hogy allandoan megjelenjen [...] ne tunjon el. ha nincs
 * semmi baj akkor azt is irja ki." Hence `ok` rows are returned too: the card
 * states the healthy case out loud, so silence never has to be interpreted.
 *
 * What prompted it, measured the same day: the gold-analysis task's email
 * fallback failed with `invalid_grant | Token has been expired or revoked`.
 * The Google OAuth app is in "Testing" publishing status, where a refresh
 * token lives exactly 7 days (`refresh_token_expires_in: 604799`), so Gmail,
 * Drive and Calendar all stop weekly -- silently, because nothing was watching
 * the clock. The token had been dead for two days before anyone noticed, and
 * only because a delivery was traced by hand.
 *
 * TWO token stores, on purpose. `google-tokens.json` is the multi-account one
 * the dashboard writes; `google-token.json` (no plural) is the legacy
 * single-account file that `scripts/whatsapp-send.py` -> `scripts/gmail-send.py`
 * still reads. Measured 2026-08-19: the plural store was healthy while the
 * legacy one had been dead for two days -- i.e. watching only the store the UI
 * knows about would have reported "minden rendben" over a broken delivery
 * path. Whichever file a sender actually reads is the one that has to be
 * watched.
 *
 * Deliberately time-based and file-only: the overview endpoint must stay fast
 * and must not depend on the network. That means this catches EXPIRY, not
 * manual revocation -- a token revoked early still reads `ok` here until its
 * expiry passes. The live probe on the Fiókok page remains the other half of
 * the story; this half is the one that can warn in advance.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { STORE_DIR } from '../config.js'

export type ExpiryStatus = 'ok' | 'soon' | 'expired'

export interface CredentialExpiry {
  /** Stable key; the client maps it to a label and a "what to do" text. */
  id: string
  /** Human-facing name of the thing that expires (account id, or the legacy
   *  store's role), so ten accounts stay tellable apart. */
  label: string
  status: ExpiryStatus
  /** Epoch ms. */
  expiresAt: number
  /** Whole days left; 0 on the last day, negative once expired. */
  daysLeft: number
}

/** Warn this long before the deadline. Two days is enough to act on a
 *  weekly-expiring token without nagging for most of its life. */
export const EXPIRY_WARN_MS = 2 * 24 * 60 * 60 * 1000

const DAY_MS = 24 * 60 * 60 * 1000

/** Timestamps in these files are written as seconds by the python helpers and
 *  as milliseconds by the TS side. Anything below this is seconds. */
function toMs(value: number): number {
  return value < 1e11 ? value * 1000 : value
}

function statusFor(now: number, expiresAt: number): ExpiryStatus {
  if (expiresAt <= now) return 'expired'
  return expiresAt - now <= EXPIRY_WARN_MS ? 'soon' : 'ok'
}

/**
 * One token record -> one row, or null when it states no deadline.
 *
 * Null is the right answer for a published (Production) OAuth app: those
 * refresh tokens do not expire, and inventing a deadline for them would be a
 * permanent false alarm. Null is also the answer for a record with no refresh
 * token at all -- there is nothing to keep alive.
 *
 * WHICH CLOCK -- measured 2026-08-22, when all ten accounts answered
 * `invalid_grant` while this card read "ok, 08-29-ig". `saved_at` is the ACCESS
 * token's timestamp and moves every hour; adding the REFRESH token's lifetime
 * to it pushed the deadline a week into the future on every refresh, so the
 * warning band could never be reached and the whole watcher was decorative.
 * `refresh_saved_at` is the refresh token's own birthday, written only when
 * Google actually issues or re-measures one. Records from before that field
 * existed fall back to `saved_at` -- the old, too-optimistic reading, but the
 * only number they carry; the fallback disappears at the next sign-in.
 */
function entryExpiry(
  now: number, id: string, label: string, raw: unknown,
): CredentialExpiry | null {
  if (!raw || typeof raw !== 'object') return null
  const rec = raw as Record<string, unknown>
  if (typeof rec.refresh_token !== 'string' || !rec.refresh_token) return null
  const savedAt = typeof rec.refresh_saved_at === 'number' ? rec.refresh_saved_at
    : typeof rec.saved_at === 'number' ? rec.saved_at : null
  const lifetime = typeof rec.refresh_token_expires_in === 'number'
    ? rec.refresh_token_expires_in : null
  if (savedAt === null || lifetime === null || lifetime <= 0) return null
  const expiresAt = toMs(savedAt) + lifetime * 1000
  return {
    id,
    label,
    status: statusFor(now, expiresAt),
    expiresAt,
    daysLeft: Math.floor((expiresAt - now) / DAY_MS),
  }
}

function readJson(path: string): unknown {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    // A malformed token file is a different problem, and one the live probe
    // reports itself. Staying quiet here beats a warning naming the wrong cause.
    return null
  }
}

/** The multi-account store the dashboard writes. `_default` is a pointer to an
 *  account id, not an account -- it carries no token and must not become a row. */
export function googleAccountExpiries(now: number, storeDir: string): CredentialExpiry[] {
  const data = readJson(join(storeDir, 'google-tokens.json'))
  if (!data || typeof data !== 'object') return []
  const out: CredentialExpiry[] = []
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (key.startsWith('_')) continue
    // A CIMET mutatjuk, nem a belso kulcsot: Boss, 2026-08-19 -- "epp csak azt
    // nem irtad ki hogy melyik fioknal van ez". Tiz bekotott fioknal a
    // "lackor2" meg megfejtheto, de a lejarat-uzenet cimzettje az, aki majd
    // ujra bejelentkezik: neki a cim mond valamit, nem a kulcs.
    const rec = value as Record<string, unknown>
    const email = (rec && typeof rec.email === 'string' && rec.email) ? rec.email : ''
    const row = entryExpiry(now, `google:${key}`, email || key, value)
    if (row) out.push(row)
  }
  return out
}

/**
 * The legacy single-account file -- ONLY while it is the one actually in use.
 *
 * Once `google-tokens.json` exists, the migration has run and every caller
 * (gmail-send.py included, fixed 2026-08-19) reads the account store instead.
 * The old file then just sits there with a token nothing renews, and reporting
 * its expiry would be a permanent red line about a credential no longer on any
 * path -- which is how a watcher teaches people to ignore it. Before that
 * migration it IS the mail credential, and then it has to be watched.
 */
export function legacyGoogleTokenExpiry(now: number, storeDir: string): CredentialExpiry | null {
  if (existsSync(join(storeDir, 'google-tokens.json'))) return null
  const data = readJson(join(storeDir, 'google-token.json'))
  return entryExpiry(now, 'google:legacy', 'levélküldés (régi token)', data)
}

/**
 * Everything with a deadline, worst first -- healthy rows included, because the
 * card must be able to say "minden rendben" instead of just going blank.
 */
export function credentialExpiries(
  now: number = Date.now(),
  storeDir: string = STORE_DIR,
): CredentialExpiry[] {
  const all = [...googleAccountExpiries(now, storeDir)]
  const legacy = legacyGoogleTokenExpiry(now, storeDir)
  if (legacy) all.push(legacy)
  const order: Record<ExpiryStatus, number> = { expired: 0, soon: 1, ok: 2 }
  return all.sort((a, b) => order[a.status] - order[b.status] || a.expiresAt - b.expiresAt)
}

/** The single worst status across everything, for the card's colour. `ok` when
 *  there is nothing with a deadline at all: nothing is expiring. */
export function worstExpiryStatus(rows: CredentialExpiry[]): ExpiryStatus {
  if (rows.some(r => r.status === 'expired')) return 'expired'
  if (rows.some(r => r.status === 'soon')) return 'soon'
  return 'ok'
}
