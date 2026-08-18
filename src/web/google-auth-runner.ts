// I/O half of the dashboard-driven Google account setup. The parsing -- and the
// measurements that justify this shape -- live in ./google-accounts.ts.
//
// Boss, 2026-08-14: ten addresses should be connectable, and all of them should
// work at once. They already can: scripts/google-auth.py has been account-keyed
// since 2026-08-10. What it did NOT have was a way in from the dashboard, so
// the honest instruction on the Accounts page was "ask Marvin in chat" -- which
// is exactly the answer a non-programmer cannot act on.
//
// This drives the EXISTING script rather than reimplementing OAuth: the token
// exchange, the refresh handling and the store layout are already tested, and a
// second implementation of a credential flow is a second place to get it wrong.
//
// ONE flow at a time, and that is not a simplification: the script binds a FIXED
// loopback port (47921) and keeps its in-flight `state` in a single file
// (store/.google-auth-pending.json). Two concurrent authorizations would fight
// over both, and the loser would exchange its code against the winner's state.
//
// Nothing here logs the consent URL, the pasted redirect or any token value.
// The URL carries `state`, the paste carries a one-time code, and the store
// carries refresh tokens -- none of which belong in a log line.
import { spawn, execFile, execFileSync } from 'node:child_process'
import { existsSync, readFileSync, chmodSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { logger } from '../logger.js'
import { makeLazyBinResolver } from '../platform.js'
import { PROJECT_ROOT, STORE_DIR } from '../config.js'
import { atomicWriteFileSync } from './atomic-write.js'
import {
  accountsFromTokenStore,
  parseAccountList,
  parseProbeOutput,
  parseSavedAccountId,
  isValidAccountId,
  isValidGoogleProjectId,
  classifyGoogleFailure,
  extractConsentUrl,
  isUsablePaste,
  NO_SERVICES,
  PASTE_HELP,
  GOOGLE_TEST_USER_HELP,
  type GoogleAccountRow,
  type GoogleProbeResult,
  type GoogleFailureKind,
} from './google-accounts.js'

// Lazy, not resolved at import: a module-level resolveFromPath() throws during
// IMPORT if the binary is momentarily unresolvable, which takes the whole
// dashboard down over an optional integration (see platform.ts).
const python = makeLazyBinResolver('python3')
const SCRIPT = join(PROJECT_ROOT, 'scripts', 'google-auth.py')
const TOKENS_PATH = join(STORE_DIR, 'google-tokens.json')
const CLIENT_PATH = join(STORE_DIR, 'google-oauth-client.json')

/** The script waits 10 minutes for the loopback redirect; outliving that by a
 *  minute lets a slow consent finish instead of being called a failure. */
const AUTH_MAX_AGE_MS = 11 * 60_000

/** Whether this install can authorize at all. Without the OAuth client file the
 *  script exits immediately, and a "Connect" button that always fails is worse
 *  than one that explains why it is disabled. */
export function googleOauthClientPresent(): boolean {
  return existsSync(CLIENT_PATH)
}

/**
 * The Google Cloud project this install's OAuth client belongs to.
 *
 * Read for ONE reason: when Google refuses an address with 403 access_denied
 * (the app is in "Testing" status and the address is not a test user), the page
 * can link straight to that project's test-user list instead of telling a
 * non-programmer to "find your project in the Cloud Console".
 *
 * ONLY project_id is read. This file also holds client_id and client_secret,
 * and neither is touched here, returned, or logged -- the project id is a
 * name, the other two are credentials.
 *
 * Cached on mtime: the page asks for this on every render, and the file changes
 * roughly never.
 */
let projectIdCache: { mtimeMs: number; projectId: string | null } | null = null

export function googleOauthProjectId(): string | null {
  try {
    const { mtimeMs } = statSync(CLIENT_PATH)
    if (projectIdCache && projectIdCache.mtimeMs === mtimeMs) return projectIdCache.projectId
    const parsed = JSON.parse(readFileSync(CLIENT_PATH, 'utf-8')) as Record<string, unknown>
    // Desktop clients nest under "installed", web clients under "web".
    const node = (parsed?.installed ?? parsed?.web ?? parsed) as Record<string, unknown>
    const raw = node && typeof node.project_id === 'string' ? node.project_id : ''
    const projectId = isValidGoogleProjectId(raw) ? raw : null
    projectIdCache = { mtimeMs, projectId }
    return projectId
  } catch {
    // Missing or unreadable: the link still works, it just has to ask which
    // project. Never a reason to fail a request.
    return null
  }
}

// --- reading the account list ------------------------------------------------

function runScript(args: string[], timeoutMs = 60_000): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(python(), [SCRIPT, ...args], {
      timeout: timeoutMs, encoding: 'utf-8', cwd: PROJECT_ROOT,
    })
    return { code: 0, stdout, stderr: '' }
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string }
    return {
      code: typeof e.status === 'number' ? e.status : 1,
      stdout: e.stdout ? String(e.stdout) : '',
      stderr: e.stderr ? String(e.stderr) : '',
    }
  }
}

/**
 * The same call without parking the event loop.
 *
 * MEASURED, 2026-08-14: `google-auth.py test lackor2` takes 1.17s with a warm
 * token, and longer when the refresh has to run. execFileSync freezes the WHOLE
 * dashboard process for that long -- SSE, agent traffic, everything -- so
 * anything the page triggers by itself (the probes below) has to go this way.
 */
function runScriptAsync(args: string[], timeoutMs = 60_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    execFile(python(), [SCRIPT, ...args], { timeout: timeoutMs, encoding: 'utf-8', cwd: PROJECT_ROOT },
      (err, stdout, stderr) => {
        const e = err as (Error & { code?: number }) | null
        resolve({
          code: e ? (typeof e.code === 'number' ? e.code : 1) : 0,
          stdout: stdout ? String(stdout) : '',
          stderr: stderr ? String(stderr) : '',
        })
      })
  })
}

/**
 * Probes are cached HARD, and on purpose.
 *
 * One probe is three Google API calls plus a token refresh. With ten accounts a
 * page render would be forty round-trips, on a page the operator refreshes
 * while waiting for something else to finish. Five minutes is short enough that
 * a revoked account surfaces on its own, and any flow that CHANGES an account
 * invalidates its entry outright.
 */
const PROBE_TTL_MS = 5 * 60_000
const probeCache = new Map<string, { at: number; result: GoogleProbeResult }>()

export function invalidateGoogleProbe(id?: string): void {
  if (id) probeCache.delete(id)
  else probeCache.clear()
}

/**
 * One probe per account at a time.
 *
 * The page auto-checks the accounts it has never seen, and the operator can hit
 * "Check" on the same row while that is running. Without this, the two would
 * spawn two python processes for one answer.
 */
const probesInFlight = new Map<string, Promise<GoogleProbeResult>>()

/** Ask Google what still works for one account. `force` skips the cache. */
export async function probeGoogleAccount(id: string, force = false): Promise<GoogleProbeResult> {
  if (!isValidAccountId(id)) {
    return { ok: false, email: null, services: { ...NO_SERVICES }, error: 'érvénytelen fiók-azonosító', kind: null }
  }
  const hit = probeCache.get(id)
  if (!force && hit && Date.now() - hit.at < PROBE_TTL_MS) return hit.result
  const running = probesInFlight.get(id)
  if (running) return running
  const started = runScriptAsync(['test', id], 90_000).then(({ code, stdout, stderr }) => {
    const result = parseProbeOutput(stdout, stderr, code)
    probeCache.set(id, { at: Date.now(), result })
    return result
  }).finally(() => { probesInFlight.delete(id) })
  probesInFlight.set(id, started)
  return started
}

/**
 * The account list itself: read from the store file, cached briefly.
 *
 * The file, not a `google-auth.py list` spawn, because /api/connections/summary
 * asks for this on every Overview render and every dashboard page load -- and
 * an execFileSync there freezes the whole process (agents included) to answer a
 * question a 300-byte JSON file already answers. The script's `list` is exactly
 * `keys != "_default"` plus the default pointer (cmd_list / _default_account),
 * so this is the same answer, not a second opinion.
 *
 * It also removes a disagreement that was already possible: the setup wizard
 * counted accounts from this file while the page listed them from the script.
 *
 * The one thing the file cannot do is the script's legacy-token migration
 * (_load_tokens), so an empty read still falls through to the script -- which
 * migrates, and then has something to print.
 */
const LIST_TTL_MS = 30_000
let listCache: { at: number; rows: Array<{ id: string; isDefault: boolean }> } | null = null

function invalidateAccountList(): void {
  listCache = null
}

function readAccountList(): Array<{ id: string; isDefault: boolean }> {
  if (listCache && Date.now() - listCache.at < LIST_TTL_MS) return listCache.rows
  let rows = accountsFromTokenStore(readTokensFile())
  if (rows.length === 0) rows = parseAccountList(runScript(['list'], 20_000).stdout)
  listCache = { at: Date.now(), rows }
  return rows
}

/**
 * Every Google address this install holds a token for, with whatever the last
 * probe found. No Google round-trip: the list is a cached file read, and
 * `checkedAt: null` is an honest "not checked yet" the page renders as such.
 */
export function listGoogleAccounts(): GoogleAccountRow[] {
  return readAccountList().map(({ id, isDefault }) => {
    const cached = probeCache.get(id)
    return {
      id, isDefault,
      email: cached ? cached.result.email : null,
      services: cached ? cached.result.services : { ...NO_SERVICES },
      checkedAt: cached ? cached.at : null,
      error: cached ? cached.result.error : null,
      kind: cached ? cached.result.kind : null,
    }
  })
}

/**
 * The same list, but every account actually asked.
 *
 * Sequential, not Promise.all: ten parallel probes are ten python processes and
 * ten token refreshes at once on a box that is also running the agents. The
 * cache means the second visit costs nothing, so the slow case is bounded and
 * happens once.
 */
export async function listGoogleAccountsProbed(force = false): Promise<GoogleAccountRow[]> {
  const rows: GoogleAccountRow[] = []
  for (const { id, isDefault } of readAccountList()) {
    const result = await probeGoogleAccount(id, force)
    const entry = probeCache.get(id)
    rows.push({
      id, isDefault,
      email: result.email,
      services: result.services,
      checkedAt: entry ? entry.at : Date.now(),
      error: result.error,
      kind: result.kind,
    })
  }
  return rows
}

// --- the guided authorization ------------------------------------------------

interface AuthFlow {
  startedAt: number
  accountId: string
  /** Everything the child has printed. Held in memory only, never written out:
   *  the first lines contain the consent URL. */
  output: string
  child: ReturnType<typeof spawn> | null
  exitCode: number | null
  /** Set once `exchange` has written a token, so the poll can report success
   *  even though the child was the one killed. */
  finished: boolean
  error: string | null
  /** Set when the refusal came from Google itself (403 access_denied), so the
   *  page can open the test-user walkthrough instead of saying "didn't work". */
  blocked: GoogleFailureKind
}
let flow: AuthFlow | null = null

export type GoogleAuthPhase = 'idle' | 'starting' | 'consent' | 'exchanging' | 'done' | 'failed'

export interface GoogleAuthStatus {
  active: boolean
  phase: GoogleAuthPhase
  /** The consent link, once the child has printed it. */
  url: string | null
  accountId: string | null
  error: string | null
  /** Refreshed on every poll so the page updates itself when a flow lands. */
  accounts: GoogleAccountRow[]
  /** False means the install cannot authorize at all yet. */
  clientPresent: boolean
  /** Non-null when GOOGLE refused, not us -- the page opens the walkthrough. */
  blocked: GoogleFailureKind
  /** For the deep link into the right Cloud Console project. Never a secret. */
  projectId: string | null
  /** Set when the token landed under a DIFFERENT key than the one asked for --
   *  a different address signed in, so the script saved a new account instead
   *  of overwriting this one. The page says so; silence would be a lie. */
  savedAs: string | null
}

function idleStatus(
  phase: GoogleAuthPhase = 'idle',
  error: string | null = null,
  blocked: GoogleFailureKind = null,
): GoogleAuthStatus {
  return {
    active: false, phase, url: null, accountId: null, error,
    accounts: listGoogleAccounts(), clientPresent: googleOauthClientPresent(),
    blocked, projectId: googleOauthProjectId(), savedAs: null,
  }
}

function killFlow(): void {
  if (flow?.child && flow.exitCode === null) {
    try { flow.child.kill('SIGTERM') } catch { /* already gone */ }
  }
}

/**
 * Begin authorizing a new (or a re-authorized) address.
 *
 * The child stays alive on purpose: it is also the loopback server, so on a
 * machine where the browser CAN reach localhost:47921 the flow completes with
 * no paste at all. The paste is the fallback, not the happy path -- which
 * matters here, because pasting a URL is the step a non-programmer drops.
 */
export function startGoogleAuth(
  accountId: string,
  opts: { force?: boolean } = {},
): { ok: boolean; error?: string; code?: 'busy'; busyAccountId?: string } {
  const id = (accountId || '').trim().toLowerCase()
  if (!isValidAccountId(id)) {
    return { ok: false, error: 'A fiók neve csak kisbetű, szám és aláhúzás lehet (pl. "munka" vagy "lackor2").' }
  }
  if (!googleOauthClientPresent()) {
    return { ok: false, error: 'Hiányzik a Google OAuth kliens-fájl (store/google-oauth-client.json). A Beállítás varázslóban van leírva, hogyan szerezd meg.' }
  }
  // Busy travels as a CODE, not as Hungarian prose the page would have to parse.
  // Boss, 2026-08-15: "Már fut egy Google-bejelentkeztetés (freeberischeaper).
  // Fejezd be, vagy szakítsd meg. ha ilyen van mit tegyek?" -- the sentence was
  // true and useless: the page it appeared on had no way to end that flow. With
  // the code and the name, the page can offer exactly one named action.
  if (flow && !flow.finished && flow.exitCode === null && Date.now() - flow.startedAt < AUTH_MAX_AGE_MS) {
    const busyAccountId = flow.accountId
    if (!opts.force) {
      return {
        ok: false, code: 'busy', busyAccountId,
        error: `Már fut egy Google-bejelentkeztetés (${busyAccountId}). Fejezd be, vagy szakítsd meg.`,
      }
    }
    logger.info({ accountId: id, replaced: busyAccountId }, 'google-auth: replacing a running authorization on request')
  }
  killFlow()

  let child: ReturnType<typeof spawn>
  try {
    child = spawn(python(), [SCRIPT, 'auth', id], {
      cwd: PROJECT_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
    })
  } catch (err) {
    logger.warn({ err }, 'google-auth: could not start the authorization process')
    return { ok: false, error: 'A folyamatot nem sikerült elindítani.' }
  }

  const state: AuthFlow = { startedAt: Date.now(), accountId: id, output: '', child, exitCode: null, finished: false, error: null, blocked: null }
  const absorb = (buf: Buffer) => {
    // Bounded: the child runs for up to ten minutes and nothing downstream
    // needs more than the first screenful.
    if (state.output.length < 64 * 1024) state.output += buf.toString('utf-8')
  }
  child.stdout?.on('data', absorb)
  child.stderr?.on('data', absorb)
  child.on('exit', (code) => { state.exitCode = typeof code === 'number' ? code : 1 })
  child.on('error', (err) => {
    logger.warn({ err }, 'google-auth: authorization process failed')
    state.exitCode = 1
  })
  flow = state
  // Account id only. Not the URL, not the state, not the code.
  logger.info({ accountId: id }, 'google-auth: authorization started')
  return { ok: true }
}

/** Where the flow stands. Safe to poll; it must never throw. */
export function googleAuthStatus(): GoogleAuthStatus {
  if (!flow) return idleStatus()

  if (flow.finished) {
    const accountId = flow.accountId
    flow = null
    return { ...idleStatus('done'), accountId }
  }

  if (flow.exitCode !== null) {
    const accountId = flow.accountId
    // Exit 0 means the loopback redirect landed and the script exchanged the
    // code itself -- the no-paste path, and the one we would rather see.
    if (flow.exitCode === 0) {
      // The script prints the key it saved under, which is not always the one
      // we asked for -- see parseSavedAccountId.
      const saved = parseSavedAccountId(flow.output)
      const savedAs = saved && saved !== accountId ? saved : null
      invalidateGoogleProbe(savedAs ? undefined : accountId)
      // The no-paste path adds an account without going through any of the
      // mutators below, so the list has to be dropped here or the operator
      // would watch a successful sign-in not appear.
      invalidateAccountList()
      flow = null
      return { ...idleStatus('done'), accountId: savedAs || accountId, savedAs }
    }
    const message = flow.output.split('\n').map(l => l.trim()).find(l => l.startsWith('HIBA'))
    // Pressing "Cancel" on the consent screen -- and, on some paths, the 403
    // refusal itself -- comes back to the loopback as `error=access_denied`, so
    // the child's own output is a second place the refusal shows up.
    const blocked = flow.blocked || classifyGoogleFailure(flow.output)
    flow = null
    return { ...idleStatus('failed', message || 'A jóváhagyás nem fejeződött be.', blocked), accountId }
  }

  if (Date.now() - flow.startedAt > AUTH_MAX_AGE_MS) {
    killFlow()
    const accountId = flow.accountId
    const blocked = flow.blocked
    flow = null
    return { ...idleStatus('failed', 'A jóváhagyás túl sokáig tartott, megszakítottam.', blocked), accountId }
  }

  const url = extractConsentUrl(flow.output)
  return {
    active: true,
    phase: url ? 'consent' : 'starting',
    url,
    accountId: flow.accountId,
    error: flow.error,
    accounts: listGoogleAccounts(),
    clientPresent: true,
    blocked: flow.blocked,
    projectId: googleOauthProjectId(),
    // Only knowable once the script has finished writing the token.
    savedAs: null,
  }
}

/**
 * Finish the flow with the link the operator copied out of the address bar.
 *
 * Run synchronously rather than fired at the child, because `exchange` is a
 * separate invocation with its own exit code -- and a failed exchange has to
 * say WHY (expired code, wrong link, revoked consent) instead of leaving the
 * page spinning.
 */
export async function submitGooglePaste(value: string): Promise<{ ok: boolean; error?: string; blocked?: GoogleFailureKind; savedAs?: string | null }> {
  const mine = flow
  if (!mine || mine.finished) return { ok: false, error: 'Nincs futó Google-bejelentkeztetés.' }
  const paste = (value || '').trim()

  // BEFORE the usability check, and that ordering is the whole point.
  //
  // When Google refuses (403 access_denied), the operator has an error page in
  // front of them and does exactly what step 3 tells them: pastes what is in
  // the address bar -- or the text off the screen. Neither carries a `code=`,
  // so the old answer was "paste the link with code= in it", which is both
  // useless and wrong: there will never BE such a link until the address is on
  // the test-user list. Recognise the refusal and hand over the fix instead.
  // Only the test-user refusal is decided from the paste: "expired" is about a
  // token that used to work, which a paste cannot be.
  if (classifyGoogleFailure(paste) === 'test-user') {
    mine.blocked = 'test-user'
    return { ok: false, blocked: 'test-user', error: GOOGLE_TEST_USER_HELP }
  }
  if (!isUsablePaste(paste)) return { ok: false, error: PASTE_HELP }

  // Async: the exchange is a network call with a 60s timeout, and freezing the
  // dashboard for a minute because Google is slow is not an option.
  const { code, stdout, stderr } = await runScriptAsync(['exchange', paste, mine.accountId], 60_000)
  // The flow can be cancelled -- or replaced by a different one -- while the
  // exchange is in flight. Act on the flow this call belongs to, never on
  // whatever happens to be current now.
  if (flow !== mine) return { ok: false, error: 'Ez a bejelentkeztetés közben megszakadt.' }
  if (code !== 0) {
    const text = `${stdout}\n${stderr}`
    const message = text.split('\n').map(l => l.trim()).find(l => l.startsWith('HIBA'))
    // The flow stays open: an expired paste is worth a second try, and tearing
    // the whole thing down would make the operator start from the link again.
    mine.error = (message || 'A beillesztett linket nem sikerült beváltani.').slice(0, 300)
    // Google can also refuse at the exchange rather than at the consent screen.
    mine.blocked = classifyGoogleFailure(text)
    return { ok: false, error: mine.error, blocked: mine.blocked }
  }
  // Where the token ACTUALLY landed. The script saves under a new key rather
  // than overwriting a slot that belongs to a different address, so "done" has
  // to name the account that now exists.
  const saved = parseSavedAccountId(`${stdout}\n${stderr}`)
  const savedAs = saved && saved !== mine.accountId ? saved : null
  killFlow()
  mine.finished = true
  // A key we never asked for has no cache entry, but the one we did ask for may
  // hold the OLD account's failure -- clear everything in that case.
  invalidateGoogleProbe(savedAs ? undefined : mine.accountId)
  invalidateAccountList()
  logger.info({ accountId: savedAs || mine.accountId, requested: mine.accountId }, 'google-auth: account authorized')
  return { ok: true, savedAs }
}

/** Abandon the flow. The pending-state file is the script's to clean up; a
 *  stale one is harmless because the next `auth` overwrites it. */
export function cancelGoogleAuth(): void {
  killFlow()
  flow = null
}

// --- managing the accounts that already exist --------------------------------

function readTokensFile(): Record<string, unknown> {
  if (!existsSync(TOKENS_PATH)) return {}
  try {
    const parsed = JSON.parse(readFileSync(TOKENS_PATH, 'utf-8'))
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
  } catch (err) {
    logger.warn({ err }, 'google-auth: token store is unreadable')
    return {}
  }
}

/** Read-modify-write of the token store, preserving 0600 and every value it
 *  holds. Nothing in here inspects a token; keys only. */
function writeTokensFile(data: Record<string, unknown>): boolean {
  try {
    atomicWriteFileSync(TOKENS_PATH, JSON.stringify(data, null, 2), { mode: 0o600 })
    // Belt and braces: the store holds refresh tokens, and a mode slip here is
    // a credential exposure rather than an inconvenience.
    chmodSync(TOKENS_PATH, 0o600)
    return true
  } catch (err) {
    logger.warn({ err }, 'google-auth: could not write the token store')
    return false
  }
}

/**
 * How many addresses are connected -- what the setup wizard ticks on.
 *
 * The SAME list the page draws, deliberately: a wizard that says "done" over a
 * page that says "no accounts" is worse than either answer alone. Cheap now
 * that the list is a cached file read.
 */
export function connectedGoogleAccountCount(): number {
  return readAccountList().length
}

/** Which address unqualified calls use. With ten connected, this is the one
 *  question the operator will actually ask about. */
export function setDefaultGoogleAccount(id: string): { ok: boolean; error?: string } {
  if (!isValidAccountId(id)) return { ok: false, error: 'Érvénytelen fiók-azonosító.' }
  const data = readTokensFile()
  if (!(id in data)) return { ok: false, error: 'Nincs ilyen bekötött Google-fiók.' }
  data._default = id
  if (!writeTokensFile(data)) return { ok: false, error: 'A beállítást nem sikerült elmenteni.' }
  invalidateAccountList()
  logger.info({ accountId: id }, 'google-auth: default account changed')
  return { ok: true }
}

/**
 * Disconnect an address.
 *
 * Local only: it drops Marveen's token, it does not revoke the grant at
 * Google. The page says so, because "removed" that leaves a live grant behind
 * is a promise we would not be keeping.
 */
export function removeGoogleAccount(id: string): { ok: boolean; error?: string } {
  if (!isValidAccountId(id)) return { ok: false, error: 'Érvénytelen fiók-azonosító.' }
  const data = readTokensFile()
  if (!(id in data)) return { ok: false, error: 'Nincs ilyen bekötött Google-fiók.' }
  delete data[id]
  // A dangling default is worse than none: every unqualified call would fail
  // with "no token for '<removed>'". Hand it to whoever is left.
  if (data._default === id) {
    const remaining = Object.keys(data).filter(k => k !== '_default')
    if (remaining.length > 0) data._default = remaining[0]
    else delete data._default
  }
  if (!writeTokensFile(data)) return { ok: false, error: 'A törlést nem sikerült elmenteni.' }
  invalidateGoogleProbe(id)
  invalidateAccountList()
  logger.info({ accountId: id }, 'google-auth: account removed')
  return { ok: true }
}

/** Test seam. */
export function _resetGoogleAuthForTest(): void {
  killFlow()
  flow = null
  probeCache.clear()
  probesInFlight.clear()
  invalidateAccountList()
}
