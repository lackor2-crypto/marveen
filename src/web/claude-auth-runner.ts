// I/O half of the dashboard-driven Claude account login (kanban #52, 61e9ed2b).
// The parsing -- and the measurements that justify this shape -- live in
// ../claude-auth.ts.
//
// The login runs inside a tmux window rather than as a plain child process for
// one measured reason: `claude auth login` needs a TTY. Spawned with pipes it
// prints nothing at all, so there would be no URL to show. tmux is also how the
// rest of this fork talks to Claude processes, so the same capture/send-keys
// vocabulary applies.
//
// PARALLEL, NOT SWAPPED. Each account owns a CLAUDE_CONFIG_DIR and is listed in
// store/claude-plans.json; a new login goes into a NEW directory, so the ones
// already signed in are never touched. That is the whole reason ten accounts can
// be logged in at once (Boss, 2026-08-12).
//
// ONE login flow at a time, though: they all drive the same tmux window, and two
// people pasting codes into one pane helps nobody.
import { execFileSync } from 'node:child_process'
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { logger } from '../logger.js'
import { resolveFromPath } from '../platform.js'
import { STORE_DIR } from '../config.js'
import { atomicWriteFileSync } from './atomic-write.js'
import { readClaudePlans, CLAUDE_PLANS_PATH } from './claude-plans.js'
import { exactTmuxTarget } from './tmux-target.js'
import {
  parseAuthStatus,
  readLoginPane,
  isLoginComplete,
  pickBrowserAuthUrl,
  planIdFromLabel,
  idsBlockingReuse,
  buildPlanEntry,
  UNKNOWN_IDENTITY,
  type AuthIdentity,
  type LoginPaneState,
} from '../claude-auth.js'

const TMUX = resolveFromPath('tmux')
const CLAUDE = resolveFromPath('claude')

// Not derived from an agent id: this is the INSTALL's own login flow, not any
// one agent's. Prefixed so it is obvious in `tmux ls` what it belongs to.
const LOGIN_SESSION = 'marveen-claude-login'

// The authorize URL is ~500 characters. A default-width pane wraps it, and even
// with capture-pane -J a wrap that lands mid-escape-sequence can corrupt the
// hyperlink. A very wide window sidesteps the whole class.
const PANE_WIDTH = 400
const PANE_HEIGHT = 40

/** Scratch space for ONE login flow: the browser stand-in and what it caught.
 *  Under STORE_DIR like everything else this install owns, so no path is
 *  assumed and a second install on the same machine keeps its own. */
function loginTmpDir(): string {
  return join(STORE_DIR, 'claude-login')
}

/**
 * Put a stand-in for a browser on the flow's PATH and hand back where it
 * writes.
 *
 * This is the whole automatic path. `claude auth login` opens the browser with
 * a DIFFERENT url than the one it prints (see claude-auth.ts): the printed one
 * goes to a hosted page that shows a code, the opened one comes back to a
 * loopback port the CLI itself is listening on. A detached tmux window has no
 * browser to open anything with, so that better url used to be built, handed to
 * a program that was not there, and lost. The shim catches it, and the page can
 * offer the ending that needs nothing typed.
 *
 * Failure here is not fatal: without a shim the flow behaves exactly as it did
 * before -- printed url, pasted code -- so the login still works.
 */
function prepareBrowserShim(): { shim: string; log: string } | null {
  try {
    const dir = loginTmpDir()
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const shim = join(dir, 'open-url.sh')
    const log = join(dir, 'browser-url.txt')
    // "$@": a browser is normally invoked with the address alone, but a wrapper
    // may put flags in front of it, and dropping those would drop the address.
    // Exit 0 always -- a non-zero here would look to the CLI like "no browser".
    writeFileSync(shim, '#!/bin/sh\nprintf \'%s\\n\' "$@" >> "$MARVEEN_LOGIN_URL_LOG"\nexit 0\n', { mode: 0o700 })
    // Truncated per flow, not appended to: a url left over from a cancelled
    // attempt is a live-looking link to a challenge that no longer exists.
    writeFileSync(log, '', { mode: 0o600 })
    return { shim, log }
  } catch (err) {
    logger.warn({ err }, 'claude-auth: no browser shim -- the pasted-code path still works')
    return null
  }
}

/** The automatic url this flow caught, if it caught one. Never logged: it
 *  carries the PKCE challenge and the state parameter. */
function readBrowserUrl(log: string | null): string | null {
  if (!log) return null
  try {
    return pickBrowserAuthUrl(readFileSync(log, 'utf-8'))
  } catch {
    // Not written yet is the normal case for the first second of a flow.
    return null
  }
}

/** Where a new account's credentials go. Same convention the existing plans
 *  already use (store/accounts/<id>), so nothing here invents a second layout. */
function accountsRoot(): string {
  return join(STORE_DIR, 'accounts')
}

interface LoginSession {
  startedAt: number
  /** Config dir this flow is logging INTO. `null` means the install's OWN
   *  login (~/.claude) -- the one the main agent uses -- rather than a new,
   *  parallel account. */
  configDir: string | null
  planId: string | null
  label: string
  codeSubmitted: boolean
  registered: boolean
  /** True when this flow REPAIRS an account that already existed, rather than
   *  adding one. The page says two different sentences: "added, you can pick it
   *  for an agent" is false after a repair. */
  reused: boolean
  /** Where the browser shim writes; `null` when the shim could not be put in
   *  place, which downgrades this flow to the pasted-code path. */
  urlLog: string | null
}
let current: LoginSession | null = null

/** Abandon a flow the user walked away from: the pane holds a live OAuth
 *  challenge, and leaving it open forever is neither tidy nor safe. */
const LOGIN_MAX_AGE_MS = 15 * 60_000

/** Ask the CLI who is logged in. `configDir` selects WHICH account -- omitted,
 *  it reports the install's default (~/.claude), which is where the main agent
 *  lives unless it was given a plan of its own. */
export function readIdentity(configDir?: string | null): AuthIdentity {
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1' }
    if (configDir) env.CLAUDE_CONFIG_DIR = configDir
    const out = execFileSync(CLAUDE, ['auth', 'status', '--json'], {
      timeout: 20_000, encoding: 'utf-8', env,
    })
    return parseAuthStatus(out)
  } catch (err) {
    // A missing CLI, a timeout, a directory never logged into: the page still
    // renders, it just cannot claim anyone is signed in there.
    logger.debug({ err, configDir }, 'claude-auth: status probe failed')
    return UNKNOWN_IDENTITY
  }
}

export interface AccountRow {
  /** Plan id, or null for the install default. */
  id: string | null
  label: string
  configDir: string | null
  isDefault: boolean
  planType: string | null
  channelsAllowed: boolean | null
  identity: AuthIdentity
}

/**
 * Every Claude login this install has, the default plus each registered plan.
 *
 * One `claude auth status` per account. That is a handful of ~100ms probes on a
 * page the operator opens by hand, not a polling loop, so the simplicity is
 * worth more than a cache that could show a stale account after a fresh login.
 */
// Cached because loginStatus() is polled every two seconds while a login runs,
// and listing means one `claude auth status` PROCESS per account. Without this a
// two-minute login spawned the CLI roughly two hundred times for a list that
// changes once. Ten seconds is short enough that a freshly added account appears
// on the next tick, and registering one invalidates the cache outright.
let accountCache: { at: number; rows: AccountRow[] } | null = null
const ACCOUNT_CACHE_MS = 10_000

export function invalidateAccountCache(): void { accountCache = null }

export function listAccounts(force = false): AccountRow[] {
  if (!force && accountCache && Date.now() - accountCache.at < ACCOUNT_CACHE_MS) return accountCache.rows
  const rows = buildAccountRows()
  accountCache = { at: Date.now(), rows }
  return rows
}

function buildAccountRows(): AccountRow[] {
  const rows: AccountRow[] = [{
    id: null,
    // No label from here: the row is marked isDefault and the PAGE names it, so
    // an English dashboard never gets a Hungarian word out of the backend.
    label: '',
    configDir: null,
    isDefault: true,
    planType: null,
    channelsAllowed: null,
    identity: readIdentity(null),
  }]
  for (const plan of readClaudePlans()) {
    rows.push({
      id: plan.id,
      label: plan.label,
      configDir: plan.configDir,
      isDefault: false,
      planType: plan.planType,
      channelsAllowed: plan.channelsAllowed,
      identity: readIdentity(plan.configDir),
    })
  }
  return rows
}

function sessionExists(): boolean {
  try {
    execFileSync(TMUX, ['has-session', '-t', exactTmuxTarget(LOGIN_SESSION)], { timeout: 5_000, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function killSession(): void {
  try {
    execFileSync(TMUX, ['kill-session', '-t', exactTmuxTarget(LOGIN_SESSION)], { timeout: 5_000, stdio: 'ignore' })
  } catch { /* not running: nothing to kill */ }
}

function capturePane(): string {
  try {
    // -e keeps the escape sequences, which is where the OSC-8 hyperlink (and
    // therefore the clean URL) lives; -J joins the wrapped lines.
    return execFileSync(TMUX, ['capture-pane', '-p', '-e', '-J', '-t', exactTmuxTarget(LOGIN_SESSION)], {
      timeout: 5_000, encoding: 'utf-8', maxBuffer: 4 * 1024 * 1024,
    })
  } catch {
    return ''
  }
}

/** Append the finished login to the registry, so an agent can be pointed at it.
 *  Read-modify-write of a small operator-owned file; the reader validates, so a
 *  malformed row would simply be ignored rather than breaking the fleet. */
function registerPlan(id: string, label: string, configDir: string): boolean {
  try {
    let raw: unknown = []
    if (existsSync(CLAUDE_PLANS_PATH)) raw = JSON.parse(readFileSync(CLAUDE_PLANS_PATH, 'utf-8'))
    const list = Array.isArray(raw) ? raw : []
    if (list.some(p => p && typeof p === 'object' && (p as { id?: unknown }).id === id)) return true
    list.push(buildPlanEntry(id, label, configDir))
    atomicWriteFileSync(CLAUDE_PLANS_PATH, JSON.stringify(list, null, 2))
    invalidateAccountCache()
    logger.info({ planId: id }, 'claude-auth: new account registered')
    return true
  } catch (err) {
    logger.warn({ err, planId: id }, 'claude-auth: could not register the new account')
    return false
  }
}

export interface StartLoginResult {
  ok: boolean
  error?: string
  planId?: string
  /** True when the flow targets the install's own ~/.claude login. */
  isDefault?: boolean
}

/**
 * Begin a login for a NEW account.
 *
 * `label` is what the operator will see in the agent dropdown; the id is derived
 * from it. `email` only pre-fills the address on Anthropic's page -- a
 * convenience, never a credential.
 */
/** tmux args for the login pane. A `null` configDir deliberately passes NO
 *  CLAUDE_CONFIG_DIR, so the CLI writes to ~/.claude -- the install's own
 *  login. Setting it to the literal home path instead would work today and
 *  break the moment the CLI changes where the default lives. */
function spawnArgs(
  configDir: string | null,
  command: string,
  shim: { shim: string; log: string } | null,
): string[] {
  return [
    'new-session', '-d', '-s', LOGIN_SESSION,
    '-x', String(PANE_WIDTH), '-y', String(PANE_HEIGHT),
    ...(configDir ? ['-e', `CLAUDE_CONFIG_DIR=${configDir}`] : []),
    ...(shim ? ['-e', `BROWSER=${shim.shim}`, '-e', `MARVEEN_LOGIN_URL_LOG=${shim.log}`] : []),
    '-e', 'NO_COLOR=1',
    'sh', '-c', command,
  ]
}

/**
 * Log in to the install's OWN account (~/.claude) -- what `/login` in a
 * terminal does, driven from the page instead.
 *
 * This is the repair path, not the add-an-account path: no directory is
 * created, nothing is written to store/claude-plans.json, and the existing
 * parallel accounts are untouched.
 */
function startDefaultLogin(opts: { email?: string; useConsole?: boolean; force?: boolean }): StartLoginResult {
  // Never silently overwrite a WORKING login: that is the one way this button
  // could make things worse than it found them. `force` is the deliberate
  // "yes, switch accounts" path, and the page has to ask for it.
  if (!opts.force) {
    const who = readIdentity(null)
    if (who.loggedIn) {
      return {
        ok: false,
        error: who.email
          ? `Ez a gép már be van jelentkezve (${who.email}). Ha másik fiókra váltanál, erősítsd meg.`
          : 'Ez a gép már be van jelentkezve. Ha másik fiókra váltanál, erősítsd meg.',
      }
    }
  }

  killSession()
  const args = ['auth', 'login', opts.useConsole ? '--console' : '--claudeai']
  if (opts.email && /^[^\s@]+@[^\s@]+$/.test(opts.email)) args.push('--email', opts.email)
  const quoted = [CLAUDE, ...args].map(a => `'${a.replace(/'/g, `'\\''`)}'`).join(' ')
  const command = `${quoted}; printf '\\nMARVEEN_LOGIN_EXIT=%s\\n' "$?"; sleep 900`
  const shim = prepareBrowserShim()
  try {
    execFileSync(TMUX, spawnArgs(null, command, shim), { timeout: 10_000 })
  } catch (err) {
    logger.warn({ err }, 'claude-auth: could not start the default login session')
    return { ok: false, error: 'A bejelentkezési folyamatot nem sikerült elindítani.' }
  }
  current = {
    startedAt: Date.now(), configDir: null, planId: null, label: '',
    codeSubmitted: false, registered: true, reused: true, urlLog: shim?.log ?? null,
  }
  logger.info('claude-auth: login session started for the install default (~/.claude)')
  return { ok: true, isDefault: true }
}

export function startLogin(
  opts: {
    label?: string
    email?: string
    useConsole?: boolean
    target?: 'default' | 'new'
    force?: boolean
    /** Log back INTO this existing account instead of adding one. The page
     *  sends the id, so a repair never depends on the operator re-typing the
     *  name the same way. */
    planId?: string
  } = {},
): StartLoginResult {
  // target 'default' logs into ~/.claude -- the login the MAIN AGENT uses.
  //
  // Boss, 2026-08-21: the wizard's "Claude bejelentkezés" step only linked to
  // claude.ai, which for an already-signed-in browser just opens the chat.
  // "nem jo a bejelentkezes folyamata. [...] semmi folyamat hogy a gepemen be
  // tudjam jelentkeztetni. [...] itt a bongeszoben nem ennek kelene
  // megjelennie hanem az autorizacios panelnak."
  //
  // The parallel-account flow below already does exactly the right thing --
  // authorize URL out, one-time code back -- it just always aimed at a NEW
  // config dir, so it could never repair the account that was actually broken.
  if (opts.target === 'default') return startDefaultLogin(opts)

  // Boss, 2026-08-29: he wanted to sign an account out and bring it back
  // through the page. Both halves of that live here -- the id path (the page
  // knows WHICH account, nothing is typed) and, below, a `taken` list that no
  // longer counts a signed-out account as an occupied name.
  const rows = listAccounts(true).filter(r => !r.isDefault && r.id)
  const reId = (opts.planId ?? '').trim()
  let planId: string
  let label: string
  let configDir: string
  // "Added" and "signed back in" are two different sentences on the page.
  let reused = false

  if (reId) {
    const row = rows.find(r => r.id === reId)
    if (!row || !row.configDir) {
      return { ok: false, error: 'Ezt a fiókot nem találom a listában. Frissítsd az oldalt, és próbáld újra.' }
    }
    if (row.identity.loggedIn) {
      return { ok: false, error: 'Ez a fiók be van jelentkezve. Előbb jelentkeztesd ki, és utána jelentkezz be újra.' }
    }
    planId = reId
    label = row.label || reId
    configDir = row.configDir
    reused = true
  } else {
    label = (opts.label ?? '').trim()
    if (!label) return { ok: false, error: 'Adj nevet a fióknak (pl. "Munkahelyi" vagy az e-mail címed).' }

    const taken = idsBlockingReuse(rows.map(r => ({ id: r.id as string, loggedIn: r.identity.loggedIn })))
    planId = planIdFromLabel(label, taken)
    // A registered plan may point somewhere other than store/accounts/<id>; when
    // the name resolves to one of them, repair THAT directory, not a lookalike.
    configDir = rows.find(r => r.id === planId)?.configDir ?? join(accountsRoot(), planId)
    reused = rows.some(r => r.id === planId)
    if (existsSync(configDir) && readIdentity(configDir).loggedIn) {
      // Never log INTO an account that is actually signed in: that would overwrite
      // a working login, the exact opposite of adding one.
      //
      // An EMPTY directory is a different thing entirely. A cancelled attempt
      // leaves one behind (removing directories on a cancel is the worse failure
      // mode), and refusing that name forever afterwards -- with "that account
      // already exists", which was not even true -- is a trap the operator can
      // neither see nor clear from the page.
      return { ok: false, error: 'Ilyen nevű fiók már be van jelentkezve. Válassz másik nevet.' }
    }
  }

  killSession()
  try {
    mkdirSync(configDir, { recursive: true, mode: 0o700 })
  } catch (err) {
    logger.warn({ err, configDir }, 'claude-auth: could not create the account directory')
    return { ok: false, error: 'A fiók mappáját nem sikerült létrehozni.' }
  }

  const args = ['auth', 'login', opts.useConsole ? '--console' : '--claudeai']
  if (opts.email && /^[^\s@]+@[^\s@]+$/.test(opts.email)) args.push('--email', opts.email)
  const quoted = [CLAUDE, ...args].map(a => `'${a.replace(/'/g, `'\\''`)}'`).join(' ')
  // Wrapped in a shell that outlives the command, so a failure leaves its
  // message ON the pane instead of taking the window down with it.
  const command = `${quoted}; printf '\\nMARVEEN_LOGIN_EXIT=%s\\n' "$?"; sleep 900`
  const shim = prepareBrowserShim()
  try {
    execFileSync(TMUX, spawnArgs(configDir, command, shim), { timeout: 10_000 })
  } catch (err) {
    logger.warn({ err }, 'claude-auth: could not start the login session')
    return { ok: false, error: 'A bejelentkezési folyamatot nem sikerült elindítani.' }
  }
  current = {
    startedAt: Date.now(), configDir, planId, label,
    codeSubmitted: false, registered: false, reused, urlLog: shim?.log ?? null,
  }
  // Deliberately no URL, no email, no code in this line.
  logger.info({ planId }, 'claude-auth: login session started for a new account')
  return { ok: true, planId }
}

export interface LoginStatus {
  active: boolean
  phase: LoginPaneState['phase']
  url: string | null
  /** The url that finishes BY ITSELF: it redirects to the CLI's own loopback
   *  port, so nothing has to be copied back. `null` means this flow only has
   *  the printed url, and the code must be pasted. The page must not promise
   *  "automatic" without this. */
  browserUrl: string | null
  error: string | null
  /** The account being added, while a flow is running. */
  label: string | null
  planId: string | null
  /** True once the new directory reports a signed-in account. */
  done: boolean
  /** True when the finished (or running) flow targeted ~/.claude itself. */
  isDefault?: boolean
  /** True when the flow signed an EXISTING account back in. */
  reused?: boolean
  /** Every login this install has, refreshed on each poll. */
  accounts: AccountRow[]
  /** State, not event: is ~/.claude signed in at this very moment? */
  defaultLoggedIn: boolean
}

// The default phase here is 'idle', not 'starting'. It used to be 'starting',
// and that one word cost Boss an afternoon (2026-08-21): once the flow ended --
// finished, timed out, or its `done` picked up by a SECOND dashboard window --
// every later poll answered "starting", and the wizard dutifully printed "indul
// a bejelentkeztetes, egy pillanat..." forever. "mennyi legyen az a pillanat? 5
// ora hossza?" Nothing was running; the status just had no word for that.
function idle(accounts: AccountRow[], phase: LoginPaneState['phase'] = 'idle', error: string | null = null): LoginStatus {
  return {
    active: false, phase, url: null, browserUrl: null, error, label: null, planId: null, done: false,
    accounts, defaultLoggedIn: isDefaultLoggedIn(accounts),
  }
}

/** Is the install's OWN account (~/.claude) signed in right now?
 *
 *  Reported on EVERY poll, deliberately. `done` is a one-shot edge: whichever
 *  poller observes the completion consumes it, and with two dashboard windows
 *  open that is not necessarily the window the operator is looking at. A page
 *  that reads this flag instead can tell the truth on every tick, no matter who
 *  saw the edge -- or whether the login happened in a terminal entirely. */
function isDefaultLoggedIn(accounts: AccountRow[]): boolean {
  return accounts.some(a => a.isDefault && a.identity.loggedIn)
}

/** Where the flow stands. Cheap enough to poll: two tmux calls plus one status
 *  probe per known account, and it must never throw. */
export function loginStatus(): LoginStatus {
  if (!current) return idle(listAccounts())

  // Completion is tested BEFORE the age limit, deliberately: a login that
  // finished at 14:59 must not be reported as a timeout because the poll landed
  // at 15:01. The credentials are on disk either way, and calling that a failure
  // would leave a working account unregistered.
  //
  // The CLI's own status in the NEW directory is the authority here, not the
  // pane text: the account is in once `claude auth status` says so there.
  const identity = readIdentity(current.configDir)
  if (isLoginComplete(identity)) {
    const { planId, label, configDir, reused } = current
    // The default login has no plan row to write: it IS the install's account.
    const registered = configDir === null || planId === null
      ? true
      : current.registered || registerPlan(planId, label, configDir)
    killSession(); current = null
    const accounts = listAccounts(true)
    const status = idle(accounts, 'done')
    return {
      ...status, done: true, planId, label, isDefault: configDir === null, reused,
      defaultLoggedIn: isDefaultLoggedIn(accounts),
      error: registered ? null : 'A fiók bejelentkezett, de a nyilvántartásba nem sikerült felvenni.',
    }
  }

  if (Date.now() - current.startedAt > LOGIN_MAX_AGE_MS) {
    killSession(); current = null
    return idle(listAccounts(), 'failed', 'A bejelentkezés túl sokáig tartott, megszakítottam.')
  }

  if (!sessionExists()) {
    current = null
    return idle(listAccounts(), 'failed', 'A bejelentkezési ablak bezárult, mielőtt befejeződött volna.')
  }

  const pane = readLoginPane(capturePane(), current.codeSubmitted)
  const accounts = listAccounts()
  return {
    active: true, phase: pane.phase, url: pane.url,
    browserUrl: readBrowserUrl(current.urlLog),
    error: pane.error,
    label: current.label, planId: current.planId, done: false,
    isDefault: current.configDir === null, accounts,
    defaultLoggedIn: isDefaultLoggedIn(accounts),
  }
}

/** Hand the pasted code to the waiting CLI. */
export function submitCode(code: string): { ok: boolean; error?: string } {
  if (!current || !sessionExists()) return { ok: false, error: 'Nincs futó bejelentkezés.' }
  const clean = code.trim()
  // Whitespace and control characters only: the value goes into send-keys, and
  // a newline of its own would submit half a code.
  if (!clean || /[\r\n\t]/.test(clean) || clean.length > 512) {
    return { ok: false, error: 'A beillesztett kód formátuma nem megfelelő.' }
  }
  try {
    // '--' so a code that happens to begin with a hyphen is read as the literal
    // text it is, not as an option.
    execFileSync(TMUX, ['send-keys', '-t', exactTmuxTarget(LOGIN_SESSION), '-l', '--', clean], { timeout: 5_000 })
    execFileSync(TMUX, ['send-keys', '-t', exactTmuxTarget(LOGIN_SESSION), 'Enter'], { timeout: 5_000 })
  } catch (err) {
    logger.warn({ err }, 'claude-auth: could not deliver the pasted code')
    return { ok: false, error: 'A kódot nem sikerült átadni.' }
  }
  current.codeSubmitted = true
  return { ok: true }
}

/** Give up on the flow and clean the pane away. The half-created directory is
 *  left alone: it holds no credentials, and removing directories on a cancel is
 *  a worse failure mode than an empty folder. */
export function cancelLogin(): void {
  killSession()
  current = null
}

/** Test seam. */
export interface LogoutResult {
  ok: boolean
  error?: string
  /** Who was signed out -- so the page can say it back instead of "done". */
  email?: string | null
}

/**
 * Sign an account OUT from the page.
 *
 * Boss, 2026-08-29: he wanted to test the login wizard the honest way -- sign
 * an account out, then bring it back through the page. There was no way to do
 * the first half: `claude auth logout` in a terminal was the only route, which
 * is precisely the terminal trip this whole card exists to remove.
 *
 * `planId` null means the install's OWN login (~/.claude), the one the main
 * agent uses. That is deliberately allowed -- refusing it would leave the most
 * important account as the one thing the page cannot repair -- but it is also
 * why the route hands the page a list of the agents this stops FIRST, and the
 * page asks before calling this.
 */
export function logoutAccount(planId: string | null): LogoutResult {
  // A live flow owns the tmux window and a half-finished OAuth challenge;
  // pulling the credentials out from under it would leave both in a state
  // neither side could explain.
  if (current) return { ok: false, error: 'Épp fut egy bejelentkezés. Előbb fejezd be vagy szakítsd meg.' }

  let configDir: string | null = null
  if (planId) {
    const row = listAccounts(true).find(r => r.id === planId)
    if (!row || !row.configDir) {
      return { ok: false, error: 'Ezt a fiókot nem találom a listában. Frissítsd az oldalt, és próbáld újra.' }
    }
    configDir = row.configDir
  }

  const before = readIdentity(configDir)
  if (!before.loggedIn) return { ok: false, error: 'Ez a fiók már nincs bejelentkezve.' }

  try {
    // The default account must NOT inherit a CLAUDE_CONFIG_DIR from whatever
    // started the dashboard: this is the one call here that destroys something,
    // so which directory it hits is stated outright rather than left to the
    // environment.
    const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1' }
    if (configDir) env.CLAUDE_CONFIG_DIR = configDir
    else delete env.CLAUDE_CONFIG_DIR
    execFileSync(CLAUDE, ['auth', 'logout'], { timeout: 30_000, stdio: 'ignore', env })
  } catch (err) {
    logger.warn({ err, planId }, 'claude-auth: logout failed')
    return { ok: false, error: 'A kijelentkeztetés nem sikerült. A részletek a dashboard naplójában vannak.' }
  }

  invalidateAccountCache()
  // Ask the CLI, do not assume: an exit code of 0 is not the same sentence as
  // "this account is signed out now".
  if (readIdentity(configDir).loggedIn) {
    return { ok: false, error: 'A parancs lefutott, de a fiók továbbra is be van jelentkezve.' }
  }
  logger.info({ planId }, 'claude-auth: account signed out')
  return { ok: true, email: before.email ?? null }
}

export function _resetClaudeAuthForTest(): void {
  current = null
  invalidateAccountCache()
}
