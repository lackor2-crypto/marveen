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
import { execFileSync, execFile } from 'node:child_process'
import { mkdirSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { logger } from '../logger.js'
import { resolveFromPath } from '../platform.js'
import { STORE_DIR } from '../config.js'
import { atomicWriteFileSync } from './atomic-write.js'
import { readClaudePlans, CLAUDE_PLANS_PATH } from './claude-plans.js'
import {
  parseAuthStatus,
  readLoginPane,
  isLoginComplete,
  planIdFromLabel,
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

/** Where a new account's credentials go. Same convention the existing plans
 *  already use (store/accounts/<id>), so nothing here invents a second layout. */
function accountsRoot(): string {
  return join(STORE_DIR, 'accounts')
}

interface LoginSession {
  startedAt: number
  /** Config dir this flow is logging INTO -- never an existing account's. */
  configDir: string
  planId: string
  label: string
  codeSubmitted: boolean
  registered: boolean
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
export function listAccounts(): AccountRow[] {
  const rows: AccountRow[] = [{
    id: null,
    label: 'Alapértelmezett',
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
    execFileSync(TMUX, ['has-session', '-t', LOGIN_SESSION], { timeout: 5_000, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function killSession(): void {
  try {
    execFileSync(TMUX, ['kill-session', '-t', LOGIN_SESSION], { timeout: 5_000, stdio: 'ignore' })
  } catch { /* not running: nothing to kill */ }
}

function capturePane(): string {
  try {
    // -e keeps the escape sequences, which is where the OSC-8 hyperlink (and
    // therefore the clean URL) lives; -J joins the wrapped lines.
    return execFileSync(TMUX, ['capture-pane', '-p', '-e', '-J', '-t', LOGIN_SESSION], {
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
}

/**
 * Begin a login for a NEW account.
 *
 * `label` is what the operator will see in the agent dropdown; the id is derived
 * from it. `email` only pre-fills the address on Anthropic's page -- a
 * convenience, never a credential.
 */
export function startLogin(opts: { label?: string; email?: string; useConsole?: boolean } = {}): StartLoginResult {
  const label = (opts.label ?? '').trim()
  if (!label) return { ok: false, error: 'Adj nevet a fióknak (pl. "Munkahelyi" vagy az e-mail címed).' }

  const taken = readClaudePlans().map(p => p.id)
  const planId = planIdFromLabel(label, taken)
  const configDir = join(accountsRoot(), planId)
  if (existsSync(configDir)) {
    // Never log INTO an existing account's directory: that would overwrite a
    // working login, which is the exact opposite of adding one.
    return { ok: false, error: 'Ilyen nevű fiók már van. Válassz másik nevet.' }
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
  try {
    execFileSync(TMUX, [
      'new-session', '-d', '-s', LOGIN_SESSION,
      '-x', String(PANE_WIDTH), '-y', String(PANE_HEIGHT),
      '-e', `CLAUDE_CONFIG_DIR=${configDir}`,
      '-e', 'NO_COLOR=1',
      'sh', '-c', command,
    ], { timeout: 10_000 })
  } catch (err) {
    logger.warn({ err }, 'claude-auth: could not start the login session')
    return { ok: false, error: 'A bejelentkezési folyamatot nem sikerült elindítani.' }
  }
  current = { startedAt: Date.now(), configDir, planId, label, codeSubmitted: false, registered: false }
  // Deliberately no URL, no email, no code in this line.
  logger.info({ planId }, 'claude-auth: login session started for a new account')
  return { ok: true, planId }
}

export interface LoginStatus {
  active: boolean
  phase: LoginPaneState['phase']
  url: string | null
  error: string | null
  /** The account being added, while a flow is running. */
  label: string | null
  planId: string | null
  /** True once the new directory reports a signed-in account. */
  done: boolean
  /** Every login this install has, refreshed on each poll. */
  accounts: AccountRow[]
}

function idle(accounts: AccountRow[], phase: LoginPaneState['phase'] = 'starting', error: string | null = null): LoginStatus {
  return { active: false, phase, url: null, error, label: null, planId: null, done: false, accounts }
}

/** Where the flow stands. Cheap enough to poll: two tmux calls plus one status
 *  probe per known account, and it must never throw. */
export function loginStatus(): LoginStatus {
  if (!current) return idle(listAccounts())

  if (Date.now() - current.startedAt > LOGIN_MAX_AGE_MS) {
    killSession(); current = null
    return idle(listAccounts(), 'failed', 'A bejelentkezés túl sokáig tartott, megszakítottam.')
  }

  // The CLI's own status in the NEW directory is the authority on success, not
  // the pane text: the account is in once `claude auth status` says so there.
  const identity = readIdentity(current.configDir)
  if (isLoginComplete(identity)) {
    const { planId, label, configDir } = current
    const registered = current.registered || registerPlan(planId, label, configDir)
    killSession(); current = null
    const status = idle(listAccounts(), 'done')
    return {
      ...status, done: true, planId, label,
      error: registered ? null : 'A fiók bejelentkezett, de a nyilvántartásba nem sikerült felvenni.',
    }
  }

  if (!sessionExists()) {
    current = null
    return idle(listAccounts(), 'failed', 'A bejelentkezési ablak bezárult, mielőtt befejeződött volna.')
  }

  const pane = readLoginPane(capturePane(), current.codeSubmitted)
  return {
    active: true, phase: pane.phase, url: pane.url, error: pane.error,
    label: current.label, planId: current.planId, done: false, accounts: listAccounts(),
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
    execFileSync(TMUX, ['send-keys', '-t', LOGIN_SESSION, '-l', clean], { timeout: 5_000 })
    execFileSync(TMUX, ['send-keys', '-t', LOGIN_SESSION, 'Enter'], { timeout: 5_000 })
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
export function _resetClaudeAuthForTest(): void {
  current = null
}

/** Fire-and-forget cleanup for a login left running when the dashboard stops. */
export function stopLoginSessionAsync(): void {
  execFile(TMUX, ['kill-session', '-t', LOGIN_SESSION], () => {})
}
