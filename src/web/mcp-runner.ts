// I/O half of the Claude-Code connector view. The parsing -- and the
// measurements that justify this shape -- live in ./mcp-connectors.ts.
//
// Two jobs:
//   1. Say, per Claude account, which connectors work. `claude mcp list`
//      health-checks every server, so it is SLOW (measured: 8-20s for four
//      connectors) and must never block a page render. Hence: serve the cache,
//      refresh in the background, and tell the page a refresh is running.
//   2. Walk the operator through a sign-in. The CLI refuses to authenticate
//      without a TTY ("stdin isn't a terminal"), so the login runs in a tmux
//      window -- the same trick claude-auth-runner.ts uses, for the same reason.
//
// Nothing here logs an authorize URL: it carries the OAuth state.
import { execFile, execFileSync } from 'node:child_process'
import { logger } from '../logger.js'
import { makeLazyBinResolver } from '../platform.js'
import { readClaudePlans, resolveAgentConfigDir } from './claude-plans.js'
import { listAgentNames } from './agent-config.js'
import { exactTmuxTarget } from './tmux-target.js'
import {
  parseMcpList,
  summarizeMcp,
  readMcpLoginPane,
  MCP_EXIT_MARKER,
  type McpAccountView,
  type McpSummary,
  type McpLoginPaneState,
} from './mcp-connectors.js'

const tmuxBin = makeLazyBinResolver('tmux')
const claudeBin = makeLazyBinResolver('claude')

const LOGIN_SESSION = 'marveen-mcp-login'
// Same 400 columns as the Claude login pane, for the same measured reason: a
// wrapped authorize URL can break mid-escape-sequence and arrive corrupted.
const PANE_WIDTH = 400
const PANE_HEIGHT = 40

/** Health checks are network calls; ten minutes is long enough to keep the
 *  page cheap and short enough that a fixed connector shows up on its own. */
const STATUS_TTL_MS = 10 * 60_000
/** A single `claude mcp list` that has not answered by then is not going to. */
const LIST_TIMEOUT_MS = 90_000

// --- which accounts exist, and who runs on them ------------------------------

interface AccountTarget {
  /** Plan id, or null for the install default (~/.claude). */
  id: string | null
  label: string
  /** CLAUDE_CONFIG_DIR, or null to let the CLI use its default. */
  configDir: string | null
}

function accountTargets(): AccountTarget[] {
  const out: AccountTarget[] = [{ id: null, label: '', configDir: null }]
  for (const plan of readClaudePlans()) {
    out.push({ id: plan.id, label: plan.label, configDir: plan.configDir })
  }
  return out
}

/**
 * Which agents run on which account.
 *
 * This is what makes the matrix readable. The operator does not think in config
 * directories -- they think "north" and "gypsy", and the only sentence that
 * lands is "north uses this account, so sign in HERE if you want north to see
 * your Drive".
 */
export function agentsByAccount(): Map<string | null, string[]> {
  const byDir = new Map<string, string[]>()
  const onDefault: string[] = []
  for (const name of listAgentNames()) {
    let dir: string | null = null
    try { dir = resolveAgentConfigDir(name).configDir } catch { dir = null }
    if (!dir) { onDefault.push(name); continue }
    const list = byDir.get(dir) ?? []
    list.push(name)
    byDir.set(dir, list)
  }
  const out = new Map<string | null, string[]>()
  out.set(null, onDefault)
  for (const target of accountTargets()) {
    if (target.id === null || !target.configDir) continue
    out.set(target.id, byDir.get(target.configDir) ?? [])
  }
  return out
}

// --- status, cached and refreshed off the render path ------------------------

interface StatusEntry { at: number; view: McpAccountView }
const statusCache = new Map<string, StatusEntry>()
let refreshing = false
let lastRefreshAt = 0

function cacheKey(target: AccountTarget): string {
  return target.id ?? '__default__'
}

function runMcpList(configDir: string | null): Promise<{ stdout: string; error: string | null }> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1' }
    if (configDir) env.CLAUDE_CONFIG_DIR = configDir
    let bin: string
    try { bin = claudeBin() } catch {
      resolve({ stdout: '', error: 'A "claude" parancs nem található ezen a gépen.' })
      return
    }
    execFile(bin, ['mcp', 'list'], { timeout: LIST_TIMEOUT_MS, encoding: 'utf-8', env, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        // A non-zero exit still prints the list (a failing connector is not a
        // failing command), so stdout is used either way and the error is only
        // reported when there is nothing to show.
        const text = stdout ? String(stdout) : ''
        if (err && !text.trim()) {
          resolve({ stdout: '', error: 'A kapcsolatok lekérdezése nem sikerült.' })
          return
        }
        resolve({ stdout: text, error: null })
      })
  })
}

/**
 * Re-probe every account, one at a time.
 *
 * Sequential on purpose: each probe opens connections to every configured
 * connector, and firing five accounts' worth in parallel turns a status page
 * into a small port scan of the operator's own integrations.
 */
export async function refreshMcpStatus(): Promise<void> {
  if (refreshing) return
  refreshing = true
  try {
    for (const target of accountTargets()) {
      const { stdout, error } = await runMcpList(target.configDir)
      statusCache.set(cacheKey(target), {
        at: Date.now(),
        view: {
          accountId: target.id,
          label: target.label,
          agents: [],
          servers: error ? [] : parseMcpList(stdout),
          error,
        },
      })
    }
    lastRefreshAt = Date.now()
  } catch (err) {
    logger.warn({ err }, 'mcp: status refresh failed')
  } finally {
    refreshing = false
  }
}

export interface McpStatusResponse extends McpSummary {
  /** True while a background probe is running, so the page can say "checking"
   *  instead of showing an empty matrix as if nothing were connected. */
  refreshing: boolean
  /** When the numbers were last true, ms epoch; 0 means never. */
  checkedAt: number
}

/**
 * The whole picture, served from cache.
 *
 * Never blocks: a stale (or empty) cache kicks off a background refresh and
 * returns what it has. The first call on a fresh boot therefore answers
 * immediately with `refreshing: true` and no rows, which is honest -- and the
 * page polls.
 */
export function mcpStatus(force = false): McpStatusResponse {
  const targets = accountTargets()
  const agents = agentsByAccount()
  const stale = force || targets.some(t => {
    const hit = statusCache.get(cacheKey(t))
    return !hit || Date.now() - hit.at > STATUS_TTL_MS
  })
  if (stale && !refreshing) void refreshMcpStatus()

  const views: McpAccountView[] = targets.map(t => {
    const hit = statusCache.get(cacheKey(t))
    const base: McpAccountView = hit ? hit.view : {
      accountId: t.id, label: t.label, agents: [], servers: [], error: null,
    }
    return { ...base, label: t.label, agents: agents.get(t.id) ?? [] }
  })
  return { ...summarizeMcp(views), refreshing, checkedAt: lastRefreshAt }
}

// --- the guided sign-in ------------------------------------------------------

interface LoginFlow {
  startedAt: number
  accountId: string | null
  server: string
  pasteSubmitted: boolean
}
let loginFlow: LoginFlow | null = null

/** The CLI either finishes in seconds (claude.ai connectors) or waits for a
 *  paste; five minutes covers both without leaving a live OAuth challenge open. */
const LOGIN_MAX_AGE_MS = 5 * 60_000

function tmuxSafe(args: string[], timeout = 5_000): string {
  try {
    return execFileSync(tmuxBin(), args, { timeout, encoding: 'utf-8', maxBuffer: 4 * 1024 * 1024 })
  } catch {
    return ''
  }
}

function loginSessionExists(): boolean {
  try {
    execFileSync(tmuxBin(), ['has-session', '-t', exactTmuxTarget(LOGIN_SESSION)], { timeout: 5_000, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function killLoginSession(): void {
  try {
    execFileSync(tmuxBin(), ['kill-session', '-t', exactTmuxTarget(LOGIN_SESSION)], { timeout: 5_000, stdio: 'ignore' })
  } catch { /* not running */ }
}

/**
 * Start authorizing one connector on one account.
 *
 * The server name comes from the CLI's own list and is passed as a single
 * argv entry -- but it is ALSO interpolated into the shell line that keeps the
 * pane alive, so it is validated against what the account actually reports
 * rather than trusted from the request body.
 */
export function startMcpLogin(accountId: string | null, server: string): { ok: boolean; error?: string } {
  const target = accountTargets().find(t => t.id === (accountId ?? null))
  if (!target) return { ok: false, error: 'Nincs ilyen Claude-fiók.' }

  const known = statusCache.get(cacheKey(target))?.view.servers ?? []
  if (!known.some(s => s.name === server)) {
    // Not pedantry: the name reaches a shell command line below.
    return { ok: false, error: 'Ez a kapcsolat nem szerepel a fiók listájában. Frissíts, és próbáld újra.' }
  }
  if (loginFlow && Date.now() - loginFlow.startedAt < LOGIN_MAX_AGE_MS && loginSessionExists()) {
    return { ok: false, error: 'Már fut egy bejelentkeztetés. Fejezd be, vagy szakítsd meg.' }
  }
  killLoginSession()

  let bin: string
  try { bin = claudeBin() } catch {
    return { ok: false, error: 'A "claude" parancs nem található ezen a gépen.' }
  }
  const quoted = [bin, 'mcp', 'login', server, '--no-browser']
    .map(a => `'${a.replace(/'/g, `'\\''`)}'`).join(' ')
  // The shell outlives the command so a failure leaves its message ON the pane
  // instead of taking the window down with it.
  const command = `${quoted}; printf '\\n${MCP_EXIT_MARKER}%s\\n' "$?"; sleep 600`
  const args = [
    'new-session', '-d', '-s', LOGIN_SESSION,
    '-x', String(PANE_WIDTH), '-y', String(PANE_HEIGHT),
    '-e', 'NO_COLOR=1',
  ]
  // The pane would otherwise inherit the TMUX SERVER's environment, and that
  // server outlives reboots -- MEASURED on this box: `bun` is on the dashboard's
  // PATH but missing from a non-interactive shell's, which is exactly how a
  // connector can be reported working by the status probe (dashboard env) and
  // then fail inside the login pane (tmux env). Same environment for both.
  if (process.env.PATH) args.push('-e', `PATH=${process.env.PATH}`)
  if (target.configDir) args.push('-e', `CLAUDE_CONFIG_DIR=${target.configDir}`)
  args.push('sh', '-c', command)
  try {
    execFileSync(tmuxBin(), args, { timeout: 10_000 })
  } catch (err) {
    logger.warn({ err }, 'mcp-login: could not start the session')
    return { ok: false, error: 'A bejelentkeztetést nem sikerült elindítani.' }
  }
  loginFlow = { startedAt: Date.now(), accountId: target.id, server, pasteSubmitted: false }
  // Server and account only -- never the URL.
  logger.info({ accountId: target.id, server }, 'mcp-login: started')
  return { ok: true }
}

export interface McpLoginStatus extends McpLoginPaneState {
  active: boolean
  accountId: string | null
  server: string | null
  /** Agents that must be restarted before they can see the new connector. */
  restartAgents: string[]
}

export function mcpLoginStatus(): McpLoginStatus {
  if (!loginFlow) {
    return { active: false, phase: 'starting', url: null, error: null, restartRequired: false, accountId: null, server: null, restartAgents: [] }
  }
  const { accountId, server } = loginFlow
  const restartAgents = agentsByAccount().get(accountId) ?? []

  if (Date.now() - loginFlow.startedAt > LOGIN_MAX_AGE_MS) {
    killLoginSession()
    loginFlow = null
    return { active: false, phase: 'failed', url: null, error: 'A bejelentkeztetés túl sokáig tartott, megszakítottam.', restartRequired: false, accountId, server, restartAgents }
  }
  if (!loginSessionExists()) {
    loginFlow = null
    return { active: false, phase: 'failed', url: null, error: 'A bejelentkeztető ablak bezárult.', restartRequired: false, accountId, server, restartAgents }
  }

  const pane = readMcpLoginPane(
    tmuxSafe(['capture-pane', '-p', '-J', '-t', exactTmuxTarget(LOGIN_SESSION)]),
    loginFlow.pasteSubmitted,
  )
  // The status stays cached until the operator refreshes: the CLI itself says
  // the connector only becomes available on the next Claude Code start, so
  // re-probing the instant the URL appears would just re-report the old answer.
  return { ...pane, active: pane.phase !== 'failed', accountId, server, restartAgents }
}

/** Hand the pasted redirect URL to a CLI that is waiting for one. */
export function submitMcpPaste(value: string): { ok: boolean; error?: string } {
  if (!loginFlow || !loginSessionExists()) return { ok: false, error: 'Nincs futó bejelentkeztetés.' }
  const clean = (value || '').trim()
  if (!clean || /[\r\n\t\0]/.test(clean) || clean.length > 2000) {
    return { ok: false, error: 'A beillesztett link formátuma nem megfelelő.' }
  }
  try {
    // '--' so a value starting with a hyphen is read as text, not as options.
    execFileSync(tmuxBin(), ['send-keys', '-t', exactTmuxTarget(LOGIN_SESSION), '-l', '--', clean], { timeout: 5_000 })
    execFileSync(tmuxBin(), ['send-keys', '-t', exactTmuxTarget(LOGIN_SESSION), 'Enter'], { timeout: 5_000 })
  } catch (err) {
    logger.warn({ err }, 'mcp-login: could not deliver the paste')
    return { ok: false, error: 'A linket nem sikerült átadni.' }
  }
  loginFlow.pasteSubmitted = true
  return { ok: true }
}

/** Close the flow. Called when the operator says they are done in the browser,
 *  and by the cancel button -- the CLI has already exited in the claude.ai
 *  case, so this is mostly tidying the pane away. */
export function finishMcpLogin(): void {
  killLoginSession()
  loginFlow = null
}

/** Test seam. */
export function _resetMcpForTest(): void {
  statusCache.clear()
  loginFlow = null
  refreshing = false
  lastRefreshAt = 0
}
