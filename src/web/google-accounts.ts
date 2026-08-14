// Parsing half of the dashboard-driven Google account setup. The I/O half is
// ./google-auth-runner.ts; this file is pure so the classification can be
// tested without a live install and without a Google round-trip.
//
// Boss, 2026-08-14: "ugy tervezd meg hogy lehet hogy 10 email lesz
// csatlakoztatva. mindegyiknek kellene hogy mukodjon. tehat emailt drivot
// fotokat stb lassuk egyszerre! a marveen ban"
//
// MEASURED, and it decided the shape of the whole feature (2026-08-14):
//
//   - Marveen's OWN Google integration is genuinely multi-account already
//     (scripts/google-auth.py, store/google-tokens.json keyed by account name,
//     with a "_default" pointer). Ten addresses can be live at once and every
//     one of them keeps Gmail + Calendar + Drive. THIS is where "10 email"
//     belongs, and all this feature adds is a way to do it from the dashboard
//     instead of from a terminal.
//
//   - The claude.ai MCP connectors CANNOT do it. Tried in a throwaway config
//     dir: `claude mcp add --transport http gmail-ketto https://gmailmcp...`
//     is accepted, and then every such server fails with "Incompatible auth
//     server: does not support dynamic client registration". Google's MCP
//     endpoints only accept the client claude.ai itself registers, so one
//     Claude account carries at most ONE Google identity per connector. Ten
//     addresses there would mean ten Claude accounts. See ./mcp-connectors.ts.
//
// So the page shows both, honestly, and the ten-address story runs through the
// Google half.

/** One Google address Marveen holds a refresh token for. */
export interface GoogleAccountRow {
  /** Key in store/google-tokens.json -- what `--account` takes. */
  id: string
  /** The account every unqualified call falls back to. */
  isDefault: boolean
  /** Real address, once a probe has run. Null means "not checked yet". */
  email: string | null
  /** Per-service reachability from the last probe. */
  services: GoogleServiceState
  /** When the probe ran, ms epoch; null if it never has. */
  checkedAt: number | null
  /** Operator-facing failure from the last probe, if it failed. */
  error: string | null
  /** Recognised failure kind, so the row can offer the fix instead of just the
   *  message. Null when it worked, or when the failure is not one we know. */
  kind: GoogleFailureKind
}

export interface GoogleServiceState {
  gmail: boolean
  calendar: boolean
  drive: boolean
}

export const NO_SERVICES: GoogleServiceState = { gmail: false, calendar: false, drive: false }

/**
 * `google-auth.py list` output -> account rows.
 *
 * The script prints two indented spaces then the key, and appends
 * "  (alapertelmezett)" to the default one. "Nincs bekotott Google-fiok."
 * means none, and is not an error.
 */
export function parseAccountList(stdout: string): Array<{ id: string; isDefault: boolean }> {
  const out: Array<{ id: string; isDefault: boolean }> = []
  for (const raw of (stdout || '').split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('Nincs ')) continue
    // Anything parenthesised is a marker, not part of the key.
    const isDefault = /\((alapertelmezett|alapértelmezett|default)\)/i.test(line)
    const id = line.replace(/\s*\([^)]*\)\s*$/, '').trim()
    // Keys are slugs (see _slugify in the script). Refusing anything else keeps
    // a stray diagnostic line from becoming a fake account row.
    if (!/^[a-z0-9_]+$/.test(id)) continue
    out.push({ id, isDefault })
  }
  return out
}

/**
 * store/google-tokens.json -> account rows, without asking the script.
 *
 * A mirror of the script's own cmd_list + _default_account (google-auth.py):
 * every key except "_default" is an account, the "_default" pointer only counts
 * if it names a key that is really there, and a single account is the default
 * whether or not anyone said so. Kept pure and tested because it is the ONE
 * place where this file is read without python -- if it drifts from the script,
 * the dashboard and the agents disagree about which address is in use.
 *
 * Values are never inspected: this file holds refresh tokens, and nothing here
 * needs more than the key names.
 */
export function accountsFromTokenStore(data: Record<string, unknown>): Array<{ id: string; isDefault: boolean }> {
  if (!data || typeof data !== 'object') return []
  // A key that is not a slug cannot have been written by the script, and it
  // would be handed straight back as a process argument.
  const keys = Object.keys(data).filter(k => k !== '_default' && isValidAccountId(k))
  const pointer = typeof data._default === 'string' ? data._default : null
  const def = pointer && keys.includes(pointer) ? pointer : (keys.length === 1 ? keys[0] : null)
  return keys.map(id => ({ id, isDefault: id === def }))
}

export interface GoogleProbeResult {
  ok: boolean
  email: string | null
  services: GoogleServiceState
  error: string | null
  /** What KIND of failure, when the message is one we can act on. See
   *  classifyGoogleFailure below. */
  kind: GoogleFailureKind
}

/**
 * `google-auth.py test <account>` output -> what actually works.
 *
 * Deliberately per-service rather than one yes/no: with ten addresses, "one of
 * them is broken" is useless -- the operator needs to see WHICH address lost
 * WHICH service. The script prints one line per API, so a partial failure
 * (Drive revoked, Gmail fine) still yields the working half.
 */
export function parseProbeOutput(stdout: string, stderr: string, exitCode: number): GoogleProbeResult {
  const text = `${stdout || ''}\n${stderr || ''}`
  const services: GoogleServiceState = { ...NO_SERVICES }

  const gmail = text.match(/Gmail:\s*([^\s]+@[^\s]+)/)
  if (gmail) services.gmail = true
  // "Calendar naptarak: 3" -- reaching the API is the signal, not the count: an
  // account with zero calendars is still a working Calendar connection.
  if (/Calendar naptarak:\s*\d+/.test(text)) services.calendar = true
  if (/Drive fajlok[^:]*:\s*\d+/.test(text)) services.drive = true

  const ok = exitCode === 0 && services.gmail
  let error: string | null = null
  if (!ok) {
    // The script's own message is the best one available; take its first line
    // and cap it, because an HTTP body can arrive here in full.
    const hiba = text.split('\n').map(l => l.trim()).find(l => l.startsWith('HIBA'))
    error = (hiba || text.split('\n').map(l => l.trim()).filter(Boolean).pop() || 'ismeretlen hiba').slice(0, 300)
  }
  // Classified on the FULL text, not on the capped message: the marker
  // ("invalid_grant") is often further down than 300 characters.
  return { ok, email: gmail ? gmail[1] : null, services, error, kind: ok ? null : classifyGoogleFailure(text) }
}

/**
 * A key for a new account, derived the same way the script derives one from an
 * address (_slugify): lowercase, non-alphanumerics collapsed to underscore.
 *
 * With ten accounts a collision is a matter of time, so a taken key gets a
 * numeric suffix rather than silently overwriting someone else's token.
 */
export function suggestAccountId(input: string, taken: string[] = []): string {
  const local = (input || '').includes('@') ? input.split('@', 1)[0] : input
  const base = local.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'fiok'
  if (!taken.includes(base)) return base
  for (let n = 2; n < 100; n++) {
    const candidate = `${base}_${n}`
    if (!taken.includes(candidate)) return candidate
  }
  return `${base}_${Date.now().toString(36)}`
}

/**
 * Which account key the script actually saved the token under.
 *
 * Usually the one we asked for. It differs when the script refuses to
 * overwrite a slot that belongs to a DIFFERENT address (google-auth.py
 * _exchange_code): signing in as somebody else under an existing name would
 * drop that account's token without a trace, so a new account is saved
 * instead. The page then has to talk about the account that now exists, not
 * about the name the operator typed.
 */
export function parseSavedAccountId(text: string): string | null {
  const m = (text || '').match(/\(fiok='([a-z0-9_]{1,40})'\)/)
  return m ? m[1] : null
}

/** Whether an id is safe to hand to the script as an argument. */
export function isValidAccountId(id: string): boolean {
  return /^[a-z0-9_]{1,40}$/.test(id)
}

/**
 * Pull the consent URL out of the auth process's output.
 *
 * Never logged and never stored: it carries the `state` value, and a link that
 * grants access to somebody's mail is not something to leave in a log file.
 */
export function extractConsentUrl(text: string): string | null {
  const m = (text || '').match(/https:\/\/accounts\.google\.com\/o\/oauth2\/[^\s"'<>]+/)
  return m ? m[0] : null
}

/**
 * Is this paste something the `exchange` command can use?
 *
 * Accepts the whole redirect URL (what the browser leaves in the address bar)
 * or a bare code. Rejects whitespace-bearing and over-long input before it can
 * reach a process argument.
 */
export function isUsablePaste(value: string): boolean {
  const v = (value || '').trim()
  if (!v || v.length > 2000) return false
  if (/[\s\0]/.test(v)) return false
  if (v.includes('code=')) return true
  // A bare authorization code: Google's are long opaque strings, never a URL.
  return /^[A-Za-z0-9._\-/]{16,}$/.test(v)
}

/** What the operator sees when a paste is refused -- said plainly, no jargon. */
export const PASTE_HELP =
  'Másold be a böngésző címsorából a TELJES linket a jóváhagyás után (azt, amiben szerepel a "code=" rész).'

// --- when it is GOOGLE that says no ------------------------------------------
//
// Boss, 2026-08-14, trying to add a second address from the Accounts page:
// "probaltam goggle fiokot hozzaadni de nem engedte a google [...] Hozzaferes
// letiltva: A(z) Marveen nem teljesitette a Google ellenorzesi folyamatat /
// usalackor@gmail.com [...] Hiba (403): access_denied", and then: "szoval ezen
// a folyamaton is vezesd vegig a usert hulyebiztosan!"
//
// This is not a bug and no amount of retrying fixes it. The OAuth app is in
// "Testing" publishing status, where Google admits ONLY the addresses listed as
// test users -- everyone else is refused at the consent screen with 403
// access_denied. The fix is one entry in the Google Cloud Console, and the
// operator has to be walked to it; the dashboard's job is to recognise the
// refusal and say exactly that instead of "didn't work".
//
// The second consequence of Testing status is delayed and looks unrelated: a
// refresh token issued to an unverified app dies after 7 days, so an address
// that worked all week suddenly answers `invalid_grant`. Same root cause, same
// page to visit (publish the app, or sign in again) -- so it is classified here
// too, rather than surfacing as a bare python error the operator cannot read.

export type GoogleFailureKind = 'test-user' | 'expired' | null

/** Accent- and case-insensitive, because the very same refusal arrives in
 *  Hungarian with accents, in Hungarian without them (the console strips them)
 *  and in English, depending on where it was copied from. */
function foldForMatch(text: string): string {
  return (text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
}

/**
 * Which known Google refusal is this text, if any?
 *
 * Fed three different things on purpose, all of which carry the same markers:
 * the redirect URL the operator pastes (`...&error=access_denied`), the output
 * of the auth/exchange script, and the output of a `test` probe. Anything it
 * does not recognise stays null -- a wrong guess here would send the operator
 * to the Cloud Console over an unrelated network error.
 */
export function classifyGoogleFailure(text: string): GoogleFailureKind {
  const s = foldForMatch(text)
  if (!s) return null
  // "access_denied" is the machine-readable one and appears in both the URL and
  // the error page; the rest are for text pasted off the screen.
  const testUser = [
    'access_denied',
    'hozzaferes letiltva',
    'ellenorzesi folyamat',        // "nem teljesitette a Google ellenorzesi folyamatat"
    'verification process',
    'teszteles alatt all',
    'currently being tested',
    'jovahagyott tesztelo',        // "...tesztelok szamara hozzaferheto"
    'approved testers',
    'has not completed the google',
  ]
  if (testUser.some(m => s.includes(m))) return 'test-user'
  const expired = [
    'invalid_grant',
    'token has been expired or revoked',
    'lejart vagy visszavontak',
  ]
  if (expired.some(m => s.includes(m))) return 'expired'
  return null
}

/**
 * Project ids are the console's own slug (lowercase, 6-30 chars). Validated
 * rather than trusted because it goes straight into a link the operator clicks:
 * a junk value would send them to a Google 404 with no idea why.
 */
export function isValidGoogleProjectId(id: string): boolean {
  return /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(id || '')
}

/**
 * Deep link to the page that holds the test-user list.
 *
 * `/auth/audience` is where the current console keeps "Test users" (the older
 * `/apis/credentials/consent` redirects there). Without a usable project id it
 * still opens the right page -- the console then asks which project, which is
 * one extra click rather than a dead end.
 */
export function googleConsentScreenUrl(projectId: string | null): string {
  const base = 'https://console.cloud.google.com/auth/audience'
  return projectId && isValidGoogleProjectId(projectId)
    ? `${base}?project=${encodeURIComponent(projectId)}`
    : base
}

/** Shown the moment the refusal is recognised. Deliberately says "not your
 *  fault" first: this failure looks exactly like a wrong password. */
export const GOOGLE_TEST_USER_HELP =
  'Ez nem a te hibád: a Google azért tiltotta le, mert ez a cím még nincs rajta a tesztelők listáján. Alább lépésről lépésre le van írva, mit kell tenni — két perc.'
