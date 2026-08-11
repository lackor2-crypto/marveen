// I/O half of the dashboard-driven Claude account switch (kanban #52, 61e9ed2b).
// The parsing -- and the measurements that justify this shape -- live in
// ../claude-auth.ts.
//
// The login runs inside a tmux window rather than as a plain child process for
// one measured reason: `claude auth login` needs a TTY. Spawned with pipes it
// prints nothing at all, so there would be no URL to show. tmux is also how the
// rest of this fork talks to Claude processes, so the same capture/send-keys
// vocabulary applies.
//
// ONE login at a time, deliberately. This switches the identity of the account
// the whole install runs on; two concurrent flows racing to write the same
// credentials file is not a feature anyone needs.
import { execFileSync, execFile } from 'node:child_process'
import { logger } from '../logger.js'
import { resolveFromPath } from '../platform.js'
import {
  parseAuthStatus,
  readLoginPane,
  isSwitchComplete,
  UNKNOWN_IDENTITY,
  type AuthIdentity,
  type LoginPaneState,
} from '../claude-auth.js'

const TMUX = resolveFromPath('tmux')
const CLAUDE = resolveFromPath('claude')

// Not derived from an agent id: this is the INSTALL's own login, not any one
// agent's. Prefixed so it is obvious in `tmux ls` what it belongs to.
const LOGIN_SESSION = 'marveen-claude-login'

// The authorize URL is ~500 characters. A default-width pane wraps it, and even
// with capture-pane -J a wrap that lands mid-escape-sequence can corrupt the
// hyperlink. A very wide window sidesteps the whole class.
const PANE_WIDTH = 400
const PANE_HEIGHT = 40

/** A login attempt in flight. Null when nothing is running. */
interface LoginSession {
  startedAt: number
  /** Identity BEFORE the switch, so success can be told from "same account". */
  before: AuthIdentity
  codeSubmitted: boolean
  lastPhase: LoginPaneState['phase']
}
let current: LoginSession | null = null

/** Abandon a flow the user walked away from: the pane holds a live OAuth
 *  challenge, and leaving it open forever is neither tidy nor safe. */
const LOGIN_MAX_AGE_MS = 15 * 60_000

export function readIdentity(): AuthIdentity {
  try {
    const out = execFileSync(CLAUDE, ['auth', 'status', '--json'], {
      timeout: 20_000,
      encoding: 'utf-8',
      env: { ...process.env, NO_COLOR: '1' },
    })
    return parseAuthStatus(out)
  } catch (err) {
    // A missing CLI, a timeout, a broken install: the page still renders, it
    // just cannot claim anyone is logged in.
    logger.debug({ err }, 'claude-auth: status probe failed')
    return UNKNOWN_IDENTITY
  }
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
      timeout: 5_000,
      encoding: 'utf-8',
      maxBuffer: 4 * 1024 * 1024,
    })
  } catch {
    return ''
  }
}

export interface StartLoginResult {
  ok: boolean
  error?: string
}

/**
 * Begin a login. `email` only pre-fills the address on Anthropic's page; it is
 * a convenience, never a credential.
 *
 * `useConsole` picks the API-billing account type instead of the subscription,
 * mirroring the CLI's own --console flag rather than inventing a second concept.
 */
export function startLogin(opts: { email?: string; useConsole?: boolean } = {}): StartLoginResult {
  killSession()
  const before = readIdentity()
  const args = ['auth', 'login', opts.useConsole ? '--console' : '--claudeai']
  if (opts.email && /^[^\s@]+@[^\s@]+$/.test(opts.email)) args.push('--email', opts.email)

  // Wrapped in a shell that outlives the command, so a failure leaves its
  // message ON the pane instead of taking the window down with it.
  const inner = [CLAUDE, ...args].map(a => `'${a.replace(/'/g, `'\\''`)}'`).join(' ')
  const command = `${inner}; printf '\\nMARVEEN_LOGIN_EXIT=%s\\n' "$?"; sleep 900`
  try {
    execFileSync(TMUX, [
      'new-session', '-d', '-s', LOGIN_SESSION,
      '-x', String(PANE_WIDTH), '-y', String(PANE_HEIGHT),
      'sh', '-c', command,
    ], {
      timeout: 10_000,
      // BROWSER: the CLI tries to open one on the host. That is welcome on a
      // desktop install and pointless on a headless one, but either way the
      // dashboard shows the link itself, so nothing depends on it.
      env: { ...process.env, NO_COLOR: '1' },
    })
  } catch (err) {
    logger.warn({ err }, 'claude-auth: could not start the login session')
    return { ok: false, error: 'A bejelentkezési folyamatot nem sikerült elindítani.' }
  }
  current = { startedAt: Date.now(), before, codeSubmitted: false, lastPhase: 'starting' }
  // Deliberately no URL, no email, no code in this line.
  logger.info({ session: LOGIN_SESSION }, 'claude-auth: login session started')
  return { ok: true }
}

export interface LoginStatus {
  active: boolean
  phase: LoginPaneState['phase']
  url: string | null
  error: string | null
  /** Identity as the CLI reports it right now. */
  identity: AuthIdentity
  /** True once the CLI reports a different account than before the flow. */
  switched: boolean
}

/**
 * Where the flow stands. Called by the dashboard on a poll, so it must be cheap
 * and must never throw: two tmux calls and, only while a login is in flight, one
 * status probe.
 */
export function loginStatus(): LoginStatus {
  const identity = readIdentity()
  if (!current) {
    return { active: false, phase: 'starting', url: null, error: null, identity, switched: false }
  }
  if (Date.now() - current.startedAt > LOGIN_MAX_AGE_MS) {
    killSession()
    current = null
    return { active: false, phase: 'failed', url: null, error: 'A bejelentkezés túl sokáig tartott, megszakítottam.', identity, switched: false }
  }
  if (!sessionExists()) {
    const switched = isSwitchComplete(current.before, identity)
    current = null
    return { active: false, phase: switched ? 'done' : 'failed', url: null,
      error: switched ? null : 'A bejelentkezési ablak bezárult, mielőtt befejeződött volna.', identity, switched }
  }
  const pane = readLoginPane(capturePane(), current.codeSubmitted)
  current.lastPhase = pane.phase

  // The CLI's own status is the authority on success, not the pane text: the
  // account is switched when `claude auth status` says a different one is
  // logged in, whatever the terminal happens to be rendering.
  if (isSwitchComplete(current.before, identity)) {
    killSession()
    current = null
    logger.info('claude-auth: account switch completed')
    return { active: false, phase: 'done', url: null, error: null, identity, switched: true }
  }
  return { active: true, phase: pane.phase, url: pane.url, error: pane.error, identity, switched: false }
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

/** Give up on the flow and clean the pane away. */
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
