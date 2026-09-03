import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { logger } from '../logger.js'
import { MAIN_AGENT_ID, PROJECT_ROOT } from '../config.js'
import { listAgentNames } from './agent-config.js'
import { agentSessionName, capturePane } from './agent-process.js'
import { detectPaneState } from '../pane-state.js'
import { detectsUsageLimit, usageLimitResetText } from '../model-fallback.js'
import { readContextReadingFromProjectDir } from './active-model.js'
import { markCompactionStarted, isCompactionInFlight } from './compaction-inflight.js'
import { COMPACT_COMMAND } from '../context-compaction-instructions.js'
import { MAIN_CHANNELS_SESSION } from './main-agent.js'
import { withSessionSendLock } from './session-send-lock.js'
import { getHardGuardPhase } from './context-guard-runner.js'
import { resolveAgentConfigDir } from './claude-plans.js'
import { readGateConfig, readGateRunState, readGateStatus, writeGateRunState, writeGateStatus } from './context-restart-gate-store.js'
import {
  getDispatchedPendingStats,
  hasOpenInboundQuestion,
  createAgentMessage,
} from '../db.js'
import { exactTmuxTarget } from './tmux-target.js'
import {
  decideGate,
  chooseReclaimAction,
  type GateInputs,
} from '../context-restart-gate.js'

// Fleet context-restart gate: proactively send /clear to an agent session
// before the context grows unwieldy, while holding the send lane and only
// when ALL gate conditions confirm no work is in flight.
//
// This complements the hard context-guard (context-guard-runner.ts), which
// acts at 90%/97% of the context window via hard process restarts. The soft
// gate acts much earlier (default 400k tokens) via /clear -- the SessionStart
// hooks (ledger-replay, taskstate-replay, daily-log-digest) then inject a rich
// context snapshot into the fresh session automatically.
//
// The runner starts 3 minutes after dashboard boot (offset from context-guard's
// 4.5 min so the two sweeps do not fire simultaneously) and then sweeps on each
// agent's configured retryIntervalMs.

const INITIAL_DELAY_MS = 3 * 60_000   // 3 min
// How often to re-check an agent that is ALREADY over its threshold, so a short
// idle gap is not missed for another five minutes (Boss, 2026-08-12).
const ABOVE_THRESHOLD_INTERVAL_MS = 60_000   // 1 min

// tmux path (matches other runners).
const TMUX = process.env.TMUX_BIN ?? '/usr/bin/tmux'

// Child-process measurement constants.
//
// Two-tier filter to separate "infrastructure" (MCP servers, telegram plugin,
// gmail runner) from "work" (Task-tool subagents, background Bash):
//
//   CHILD_MIN_AGE_S     -- lower bound: skip children younger than this to
//                          ignore transient exec() calls (<1s typical).
//
//   INFRA_AGE_DELTA_S   -- absolute delta upper bound: if a child's age is
//                          within this many seconds of the claude process age,
//                          it started near session boot and is infrastructure.
//                          Measured on this host: MCP servers start 1-3 seconds
//                          after claude (ratio 0.9996-0.9999). 60s is a generous
//                          but ABSOLUTE cap -- unlike a ratio, it does NOT loosen
//                          as session length grows. A Task-tool subagent running
//                          for 90 min in a 2h session would have a delta >> 60s.
//
// A child is treated as "possibly work" only when:
//   age >= CHILD_MIN_AGE_S  AND  age < claudeAgeS - INFRA_AGE_DELTA_S
//
// On ps failure (null age): fail-closed → treat as work.
const CHILD_MIN_AGE_S    = 3
const INFRA_AGE_DELTA_S  = 60   // seconds; 60s >> measured 3s max MCP startup delta

/**
 * Pure: true if a child process with the given age (seconds) should be treated
 * as infrastructure (MCP server, plugin runner) rather than in-flight work.
 * Exported for tests.
 *
 * Infrastructure is detected by absolute age delta from the claude process:
 *   - age < CHILD_MIN_AGE_S                          → transient exec() → infra
 *   - age >= claudeAgeS - INFRA_AGE_DELTA_S          → started within 60s of claude → infra
 *   - otherwise                                      → spawned during session → possibly work
 *
 * Using absolute delta (not ratio) is intentional: a ratio loosens with session
 * length, so a 90-min subagent in a 2h session would be misclassified. An
 * absolute 60s cap is generous yet immune to session age.
 */
export function isInfrastructureChild(childAgeS: number, claudeAgeS: number): boolean {
  if (childAgeS < CHILD_MIN_AGE_S) return true
  if (childAgeS >= claudeAgeS - INFRA_AGE_DELTA_S) return true
  return false
}

function sessionFor(name: string): string {
  return name === MAIN_AGENT_ID ? MAIN_CHANNELS_SESSION : agentSessionName(name)
}

function workingDirFor(name: string): string {
  if (name === MAIN_AGENT_ID) return PROJECT_ROOT
  return join(PROJECT_ROOT, 'agents', name)
}

function agentIdForLedger(name: string): string {
  // The main agent's ledger key is the MAIN_AGENT_ID (e.g. "bigme"), same as
  // returned by ledger_lib.agent_id_from_cwd for the project root.
  return name
}

// ---- Pane helpers -----------------------------------------------------------

function capturePaneOrNull(session: string): string | null {
  try { return capturePane(session) } catch { return null }
}

// ---- Child-process detection ------------------------------------------------
//
// Session shapes measured on this host (see review #938 rounds 1+2):
//
//   Direct shape (most sessions):
//     pane_pid comm=claude → the pane IS the claude process.
//     bigme-channels, agent-eddie/ford/slarti/trillian/zaphod all have this.
//
//   Wrapper shape (worker sessions):
//     pane_pid comm=BASH → the pane is a shell; claude is a child.
//     bigme-worker (pane=2797), bigme-worker-fast (pane=2888) both have this.
//     If we skip the comm check and assume pane_pid=claude, we look at BASH's
//     children instead of claude's -- in the wrapper shape, claude itself is a
//     child of BASH with age ≈ BASH age (ratio ≈ 1.0 → classified as infra) and
//     all real work children of claude are invisible. This is a false-allow.
//
// Solution: read comm of pane_pid first; if not 'claude', find the child whose
// comm IS 'claude'. That is the process whose children we inspect.
//
// Two-tier age filter separates infrastructure from work (see constants above):
//   - age < CHILD_MIN_AGE_S                  → transient exec(), skip
//   - age >= claude_age - INFRA_AGE_DELTA_S  → started near boot = infra, skip
//   - otherwise                              → spawned during session = possibly work
//
// On ps failure for any PID: fail-closed (return null → decideGate blocks).

function getPanePid(session: string): number | null {
  try {
    const raw = execFileSync(TMUX, ['list-panes', '-t', exactTmuxTarget(session), '-F', '#{pane_pid}'],
      { timeout: 3000, encoding: 'utf-8' })
    const pid = parseInt(raw.split('\n')[0]?.trim() ?? '', 10)
    return Number.isFinite(pid) && pid > 0 ? pid : null
  } catch { return null }
}

function getChildPids(parentPid: number): number[] {
  try {
    const out = execFileSync('/bin/ps', ['--ppid', String(parentPid), '-o', 'pid='],
      { timeout: 3000, encoding: 'utf-8' })
    return out.split('\n')
      .map(l => parseInt(l.trim(), 10))
      .filter(n => Number.isFinite(n) && n > 0)
  } catch { return [] }
}

function getPidAgeSeconds(pid: number): number | null {
  try {
    const out = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'etimes='],
      { timeout: 2000, encoding: 'utf-8' })
    const secs = parseInt(out.trim(), 10)
    return Number.isFinite(secs) ? secs : null
  } catch { return null }
}

function getChildArgsStr(pid: number): string | null {
  try {
    const out = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'args='],
      { timeout: 2000, encoding: 'utf-8' })
    return out.trim() || null
  } catch { return null }
}

function getCommForPid(pid: number): string | null {
  try {
    const out = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'comm='],
      { timeout: 2000, encoding: 'utf-8' })
    return out.trim() || null
  } catch { return null }
}

/**
 * Pure: given the pane process and its immediate children (comm already resolved),
 * returns the PID of the actual claude process in the tree.
 *
 * Direct shape (most sessions): pane comm=claude → pane IS claude.
 * Wrapper shape (worker sessions): pane comm=bash/BASH → claude is a child.
 * Returns null (fail-closed) if claude cannot be located in either position.
 *
 * Exported for tests.
 */
export function findClaudePidInTree(
  panePid: number,
  paneComm: string | null,
  children: ReadonlyArray<{ pid: number; comm: string | null }>,
): number | null {
  if (paneComm === null) return null
  if (paneComm === 'claude') return panePid
  for (const child of children) {
    if (child.comm === 'claude') return child.pid
  }
  return null
}

// ---- MCP process pattern helpers --------------------------------------------
//
// After a channel-mcp-reconnect.ts-triggered reconnect, the MCP server process
// restarts with a fresh (young) age. The age-based infra filter would classify
// it as possibly-work and block the gate for up to 2h. To avoid this, we also
// check whether a child process's args identify it as an MCP server by:
//
//   1. Matching known plugin cache paths (/plugins/cache/) -- all Claude Code
//      channel plugins run from the global plugin cache dir.
//
//   2. Matching package names extracted from the session's .mcp.json -- covers
//      npm/npx-started MCP servers (e.g. gmail-mcp-server@1.0.30).
//
// A process matching either criterion is infra even if young.
//
// Tokens like 'npx', 'npm', 'exec', 'bun', 'node' are skipped; only the
// package/script name that uniquely identifies the server is extracted.

const MCP_SKIP_ARGS = new Set([
  'npx', 'npm', 'exec', '-y', '--yes', 'bun', 'node', 'deno',
  'python3', 'python', 'ruby', 'uvx', 'run', 'start',
])

/**
 * Pure: extract identifying package names from an mcpServers config object.
 * Strips runtime launchers (npx, npm, bun, node...) and version suffixes.
 * Exported for tests.
 */
export function extractMcpPackageNames(mcpServers: Record<string, unknown>): string[] {
  const names: string[] = []
  for (const v of Object.values(mcpServers) as Record<string, unknown>[]) {
    const allArgs = [
      typeof v['command'] === 'string' ? v['command'] : '',
      ...((Array.isArray(v['args']) ? v['args'] : []) as string[]),
    ]
    for (const raw of allArgs) {
      if (!raw || typeof raw !== 'string') continue
      if (raw.startsWith('-')) continue
      // Take basename (strip absolute path prefix) then version suffix
      const base = raw.split('/').at(-1)?.replace(/@.*$/, '') ?? ''
      if (base.length < 5 || MCP_SKIP_ARGS.has(base.toLowerCase())) continue
      names.push(base)
    }
  }
  return names
}

function getMcpJsonPatterns(workingDir: string): string[] {
  try {
    const raw = JSON.parse(readFileSync(join(workingDir, '.mcp.json'), 'utf-8')) as Record<string, unknown>
    const servers = (raw['mcpServers'] ?? {}) as Record<string, unknown>
    return extractMcpPackageNames(servers)
  } catch { return [] }
}

/**
 * Pure: true if a child process (identified by its full args string) is an
 * MCP server and should be treated as infrastructure regardless of age.
 *
 * Two criteria (either is sufficient):
 *   - args contains '/plugins/cache/' → channel plugin (telegram, slack, etc.)
 *   - args contains a package name from mcpPatterns → .mcp.json MCP server
 *
 * Exported for tests.
 */
export function isMcpProcess(childArgs: string, mcpPatterns: string[]): boolean {
  if (childArgs.includes('/plugins/cache/')) return true
  return mcpPatterns.some(p => childArgs.includes(p))
}

/**
 * Returns true if the session's claude process has live children that look
 * like in-flight work (Task-tool subagents, background Bash), false if only
 * infrastructure children are found, null if the check cannot be completed
 * (fail-closed → decideGate blocks).
 */
function hasLiveChildProcesses(session: string, mcpPatterns: string[]): boolean | null {
  const panePid = getPanePid(session)
  if (panePid === null) return null

  // Locate the actual claude process -- may be the pane itself (direct shape)
  // or a child of the pane shell (wrapper shape, e.g. bigme-worker).
  const paneComm = getCommForPid(panePid)
  const panePidChildren = getChildPids(panePid)
  const claudePid = findClaudePidInTree(
    panePid,
    paneComm,
    panePidChildren.map(pid => ({ pid, comm: getCommForPid(pid) })),
  )
  if (claudePid === null) return null   // can't locate claude -- fail-closed

  const claudeAge = getPidAgeSeconds(claudePid)
  if (claudeAge === null) return null

  // Inspect claude's own children (MCP servers + possible Task-tool subagents).
  const claudeChildren = claudePid === panePid ? panePidChildren : getChildPids(claudePid)
  if (claudeChildren.length === 0) return false

  for (const pid of claudeChildren) {
    const age = getPidAgeSeconds(pid)
    if (age === null) return null   // fail-closed
    if (isInfrastructureChild(age, claudeAge)) continue   // age-based infra
    // Age alone is not enough: a reconnected MCP server starts fresh (young).
    // Check process args to identify MCP servers regardless of age.
    const args = getChildArgsStr(pid) ?? ''
    if (isMcpProcess(args, mcpPatterns)) continue   // pattern-based infra
    return true   // live work child
  }
  return false
}

// ---- Task-state helper ------------------------------------------------------

// A taskstate record survives restarts by design (taskstate-replay re-injects
// it). Its mere existence does not mean work is running NOW -- an open thread
// can live for days. Only a RECENTLY-WRITTEN record (written during the current
// work session, not hours/days ago by a prior one) is a reliable signal of
// actively in-flight work. 10 minutes covers a PreCompact or a proactive write
// at the start of a task; anything older than that is a stale thread.
export const TASKSTATE_FRESH_WINDOW_MS = 10 * 60 * 1000  // 10 min

function hasLiveTaskStateFile(name: string, nowMs: number): boolean {
  const path = join(PROJECT_ROOT, 'store', 'agent-taskstate', `${name}.json`)
  if (!existsSync(path)) return false
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>
    if (raw.consumed === true) return false
    const nextAction = String(raw.nextAction ?? '').trim()
    if (!nextAction) return false
    // Only block if the record was written recently (active work session).
    const ts = typeof raw.ts === 'number' ? raw.ts : 0
    return ts > 0 && nowMs - ts <= TASKSTATE_FRESH_WINDOW_MS
  } catch { return false }
}

/**
 * True if the agent's local drain queue still holds unprocessed inbound. Sweeps
 * every channel provider under <workingDir>/.claude/channels and counts both
 * inbox-pending.jsonl AND any claimed inbox-draining-*.jsonl (an interrupted
 * earlier drain leaves the latter, still holding real messages). Card de5c046f:
 * a /clear fired while these are non-empty would silently eat them.
 */
function hasPendingInboxQueue(workingDir: string): boolean {
  const chDir = join(workingDir, '.claude', 'channels')
  if (!existsSync(chDir)) return false
  try {
    for (const provider of readdirSync(chDir)) {
      let files: string[] = []
      try { files = readdirSync(join(chDir, provider)) } catch { continue }
      for (const f of files) {
        if (f === 'inbox-pending.jsonl' || f.startsWith('inbox-draining-')) {
          try {
            if (readFileSync(join(chDir, provider, f), 'utf-8').split('\n').some(l => l.trim())) return true
          } catch { /* unreadable -> ignore */ }
        }
      }
    }
  } catch { /* channels dir vanished mid-sweep -> treat as none */ }
  return false
}

/**
 * Collect args strings of live work children for diagnostic logging.
 * Called only on the alert path (infrequent) so the extra ps calls are fine.
 */
function getLiveWorkChildArgs(session: string, mcpPatterns: string[]): string[] {
  try {
    const panePid = getPanePid(session)
    if (panePid === null) return []
    const paneComm = getCommForPid(panePid)
    const panePidChildren = getChildPids(panePid)
    const claudePid = findClaudePidInTree(
      panePid, paneComm,
      panePidChildren.map(pid => ({ pid, comm: getCommForPid(pid) })),
    )
    if (claudePid === null) return []
    const claudeAge = getPidAgeSeconds(claudePid)
    if (claudeAge === null) return []
    const children = claudePid === panePid ? panePidChildren : getChildPids(claudePid)
    const result: string[] = []
    for (const pid of children) {
      const age = getPidAgeSeconds(pid)
      if (age === null || isInfrastructureChild(age, claudeAge)) continue
      const args = getChildArgsStr(pid) ?? ''
      if (isMcpProcess(args, mcpPatterns)) continue
      result.push(args || `PID ${pid}`)
    }
    return result
  } catch { return [] }
}

// ---- Gate check for one agent -----------------------------------------------

async function checkAgent(name: string, nowMs: number): Promise<void> {
  const cfg = readGateConfig(name)
  if (!cfg.enabled) return   // fast-exit without touching state

  const session = sessionFor(name)
  const workingDir = workingDirFor(name)

  // Gather inputs (all deterministic, no AI inference).
  const paneRaw = capturePaneOrNull(session)
  const paneState = paneRaw !== null ? detectPaneState(paneRaw) : null
  const paneUsageLimited = paneRaw !== null ? detectsUsageLimit(paneRaw) : false
  // Lifted verbatim from the banner so the block reason can say WHEN the wall
  // ends. A gate status that reads "waiting until Aug 20, 8pm" is not the same
  // message as "blocked", and the difference is what stops a capped session
  // from being mistaken for a wedged one.
  const paneLimitReset = paneRaw !== null ? usageLimitResetText(paneRaw) : null

  const hardGuardPhase = getHardGuardPhase(name)

  // The config dir is NOT optional here. An agent launched on its own Claude
  // account runs with CLAUDE_CONFIG_DIR pointing at store/accounts/<acct>, and
  // its transcripts live under that root -- so reading without it finds no
  // transcript, returns null, and the gate blocks on
  // "context-tokens-unmeasurable (fail-closed)" forever. That is exactly what
  // happened: lackor3 sat at 300207 tokens against a 100000 threshold with the
  // gate enabled, and every sweep for months reported null. The hard guard
  // (context-guard-runner) always passed it; this runner never did.
  const configDir = name === MAIN_AGENT_ID ? undefined : (resolveAgentConfigDir(name).configDir ?? undefined)
  const contextReading = readContextReadingFromProjectDir(workingDir, configDir)
  const contextTokens = contextReading.tokens

  const dispatchedStats = (() => {
    try { return getDispatchedPendingStats(name, nowMs, cfg.staleCutoffMs) }
    catch { return null }
  })()

  const openQuestion = (() => {
    try { return hasOpenInboundQuestion(agentIdForLedger(name)) }
    catch { return false }
  })()

  const liveTaskState = hasLiveTaskStateFile(name, nowMs)

  const mcpPatterns = getMcpJsonPatterns(workingDir)
  const childProcesses = (() => {
    try { return hasLiveChildProcesses(session, mcpPatterns) }
    catch { return null }
  })()

  // If the DB query for dispatched stats failed, fail-closed by treating it as
  // if there are pending messages (count=1). Log the failure.
  if (dispatchedStats === null) {
    logger.warn({ agent: name }, 'context-restart-gate: dispatched-stats query failed (fail-closed)')
  }

  const inputs: GateInputs = {
    nowMs,
    contextTokens,
    contextState:           contextReading.state,
    contextQuota:           contextReading.quota ?? null,
    paneState,
    paneUsageLimited,
    paneLimitResetText:     paneLimitReset,
    hardGuardPhase,
    pendingOutboundCount:   dispatchedStats === null ? 1 : dispatchedStats.count,
    hasStaleOutbound:       dispatchedStats?.hasStale ?? false,
    hasChildProcesses:      childProcesses,
    hasOpenQuestion:        openQuestion,
    hasLiveTaskState:       liveTaskState,
    hasPendingInbox:        hasPendingInboxQueue(workingDir),
  }

  const runState = readGateRunState(name)

  // Remember the smallest context seen since the last compaction was
  // dispatched. chooseReclaimAction needs to know whether that compaction EVER
  // shrank the session; measuring against the live number instead scores
  // ordinary regrowth as a failed compaction (and used to wipe the session for
  // it). Recorded on every sweep, so it survives the agent working afterwards.
  if (runState.lastCompactAt !== null && contextTokens !== null &&
      (runState.lastCompactMinSeen === null || contextTokens < runState.lastCompactMinSeen)) {
    runState.lastCompactMinSeen = contextTokens
    writeGateRunState(name, runState)
  }

  const decision = decideGate(inputs, cfg, runState.firstBlockedAt)

  logger.debug({ agent: name, action: decision.action, reason: decision.reason,
    contextTokens, paneState, hardGuardPhase }, 'context-restart-gate: decision')

  // Publish the live decision so the mechanism stops being invisible.
  //
  // Boss reported twice (2026-08-12) that "the cleanup does not work": the
  // dashboard showed a 100000 threshold while the agent sat at 165000, and by
  // the afternoon at 300207 -- three times over, with the gate enabled. Nothing
  // was wrong with the gate's logic; it is fail-closed and a working agent is
  // almost never idle-with-nothing-pending, so it blocked every five minutes for
  // hours. But every one of those decisions was logged at DEBUG while the
  // logger runs at info, so there was no way to see that, or why. A number
  // presented as a threshold, with no sign that it is conditional, reads as a
  // promise -- and the user was right to call it broken.
  writeGateStatus(name, {
    ts: Date.now(),
    action: decision.action,
    reason: decision.reason,
    contextTokens,
    contextState: contextReading.state,
    thresholdTokens: cfg.thresholdTokens,
    enabled: cfg.enabled,
    aboveThreshold: contextTokens !== null && contextTokens >= cfg.thresholdTokens,
  })

  switch (decision.action) {
    case 'allow': {
      if (decision.noteStaleOutbound) {
        logger.info({ agent: name },
          'context-restart-gate: opening despite stale dispatched messages (beyond staleCutoffMs)')
      }
      // A compaction already running is not visible in the pane -- the spinner
      // carries none of the busy markers detectPaneState looks for, so the pane
      // reads IDLE while it works (see compaction-inflight.ts). Without this
      // check the sweep sends a second /compact into a session that is already
      // compacting, every 60s, which is precisely the thrashing being fixed.
      // The end-of-turn ceiling route has always checked this; the sweep never
      // did.
      if (isCompactionInFlight(name, nowMs)) {
        logger.debug({ agent: name }, 'context-restart-gate: compaction already in flight, skipping')
        break
      }
      // The gate only ever compacts. /clear is not reachable from here by
      // design -- see chooseReclaimAction. A pane that is truly idle accepts
      // /compact immediately, and the SessionStart(compact) hooks re-inject the
      // task-state snapshot afterwards.
      const reclaim = chooseReclaimAction({
        lastCompactAt: runState.lastCompactAt,
        lastCompactTokens: runState.lastCompactTokens,
        lastCompactMinSeen: runState.lastCompactMinSeen,
        nowMs,
      })
      if (reclaim.action === 'hold') {
        // Compaction cannot help this session. Say so and stop: retrying on a
        // timer would burn tokens for nothing, and escalating would wipe work.
        logger.info({ agent: name, contextTokens, why: reclaim.reason },
          'context-restart-gate: holding -- compaction is not reclaiming this session')
        writeGateStatus(name, {
          ts: nowMs,
          action: 'hold',
          reason: reclaim.reason,
          contextTokens,
          thresholdTokens: cfg.thresholdTokens,
          enabled: cfg.enabled,
          aboveThreshold: true,
        })
        break
      }
      // Compaction runs with OUR instructions, not a bare summarize (see
      // context-compaction-instructions.ts).
      const command = COMPACT_COMMAND
      try {
        await withSessionSendLock(session, null, 'deliver', async () => {
          execFileSync(TMUX, ['send-keys', '-t', exactTmuxTarget(session), '-l', command], { timeout: 5000 })
          execFileSync(TMUX, ['send-keys', '-t', exactTmuxTarget(session), 'Enter'], { timeout: 5000 })
        })
        logger.info({ agent: name, contextTokens, command, why: reclaim.reason },
          `context-restart-gate: ${reclaim.action} sent`)
        // The card's Terminal button reads "working" from the pane, and the
        // compaction spinner carries none of the busy signals a normal turn
        // does. Record that we started one so the agent does not look idle for
        // the minute it runs (Boss, 2026-08-12).
        markCompactionStarted(name, contextTokens, nowMs)
        writeGateRunState(name, {
          ...runState,
          firstBlockedAt: null,
          // Record the size we compacted FROM, and reset the low-water mark so
          // the next sweeps measure THIS compaction rather than the last one.
          lastCompactAt: nowMs,
          lastCompactTokens: contextTokens,
          lastCompactMinSeen: null,
        })
        writeGateStatus(name, {
          ts: nowMs,
          action: reclaim.action,
          reason: `${command} sent -- ${reclaim.reason}`,
          contextTokens,
          thresholdTokens: cfg.thresholdTokens,
          enabled: cfg.enabled,
          aboveThreshold: true,
        })
      } catch (err) {
        logger.warn({ err, agent: name }, 'context-restart-gate: reclaim command send failed')
      }
      break
    }

    case 'block-alert': {
      // Continuous blocking for >= persistentBlockAlertMs. Alert bigme, but
      // only once per persistentBlockAlertMs to avoid message spam.
      const alertDue = runState.lastAlertAt === null
        || nowMs - runState.lastAlertAt >= cfg.persistentBlockAlertMs
      if (alertDue) {
        const blockedSinceMin = runState.firstBlockedAt !== null
          ? Math.round((nowMs - runState.firstBlockedAt) / 60_000)
          : '?'
        try {
          // When the block reason is child processes, include their args so
          // bigme can identify the culprit at a glance (no post-hoc investigation).
          let childInfo = ''
          if (decision.reason.startsWith('live-child-processes')) {
            const workArgs = getLiveWorkChildArgs(session, mcpPatterns)
            if (workArgs.length > 0) {
              childInfo = ` Blokkolo gyerekfolyamatok: ${workArgs.slice(0, 5).join('; ')}`
            }
          }
          createAgentMessage(
            name,
            MAIN_AGENT_ID,
            `[CONTEXT-RESTART-GATE] A(z) "${name}" agens kapuja ${blockedSinceMin} perce folyamatosan blokkolt. Ok: ${decision.reason}.${childInfo} A(z) ${Math.round(cfg.thresholdTokens / 1000)}k tokenes kuszob ele ert, de a kapu nem enged -- ellenorizd hogy nincs-e elakadt munka.`,
            'context-restart-gate persistent-block alert',
          )
          logger.warn({ agent: name, reason: decision.reason, blockedSinceMin },
            'context-restart-gate: persistent-block alert sent')
          writeGateRunState(name, {
            ...runState,
            firstBlockedAt: runState.firstBlockedAt ?? nowMs,
            lastAlertAt: nowMs,
          })
        } catch (alertErr) {
          logger.warn({ alertErr, agent: name }, 'context-restart-gate: alert message failed')
        }
      }
      break
    }

    case 'block': {
      // A kvota-fal ideje NEM szamit blokkolasi sorozatnak. A dontes maga soha
      // nem eszkalal falnal (lasd context-restart-gate.ts), de az ora eddig
      // futott tovabb alatta: a fal feloldasa utan az elso rendes mid-turn
      // blokkolas AZONNAL riasztott volna, "4320 perce folyamatosan blokkolt"
      // szoveggel -- vagyis pont az a felreertes szuletett volna ujra, ami miatt
      // ez az ag keszult. A varakozas oraja a falhoz tartozik, nem az agenshez.
      if (inputs.paneUsageLimited) {
        if (runState.firstBlockedAt !== null) writeGateRunState(name, { ...runState, firstBlockedAt: null })
        break
      }
      // Normal block: update firstBlockedAt if this is the first block in a streak.
      const firstBlockedAt = runState.firstBlockedAt ?? (
        // Only start the clock when we are above the threshold -- otherwise
        // every idle agent would accumulate a never-expiring blocking streak.
        inputs.contextTokens !== null && inputs.contextTokens >= cfg.thresholdTokens
          ? nowMs
          : null
      )
      if (firstBlockedAt !== runState.firstBlockedAt) {
        writeGateRunState(name, { ...runState, firstBlockedAt })
      }
      break
    }
  }
}

// ---- Runner -----------------------------------------------------------------

const sweepTimers = new Map<string, NodeJS.Timeout>()

// Publish that the gate is off for this agent, instead of leaving whatever
// status row the last enabled sweep wrote. Without this, a status.json entry
// from days ago (enabled:true, action:block) is indistinguishable from a live
// decision made five minutes ago -- the exact "frozen row reads as a working
// gate" defect this file exists to prevent (see the writeGateStatus call
// below for the fuller history). Kanban 2f7b6d4f, usalackor 2026-08-23.
function publishDisabledStatus(name: string, cfg: { thresholdTokens: number }): void {
  writeGateStatus(name, {
    ts: Date.now(),
    action: 'disabled',
    reason: 'gate disabled for this agent',
    contextTokens: null,
    thresholdTokens: cfg.thresholdTokens,
    enabled: false,
    aboveThreshold: false,
  })
}

function scheduleSweep(name: string, delayMs: number): void {
  sweepTimers.set(name, setTimeout(async () => {
    const cfg = readGateConfig(name)
    if (!cfg.enabled) {
      sweepTimers.delete(name)
      publishDisabledStatus(name, cfg)
      return
    }
    try { await checkAgent(name, Date.now()) }
    catch (err) { logger.debug({ err, agent: name }, 'context-restart-gate: sweep error') }
    // Re-schedule using the agent's current retryIntervalMs (may have changed).
    //
    // Above the threshold, look every minute instead (Boss approved, 2026-08-12).
    // Compaction can only run while the agent is idle, and an agent that works
    // in bursts is idle in gaps far shorter than five minutes -- so the sweep
    // interval, not the idleness, was what kept a heavy session heavy. Below the
    // threshold nothing changes: there is nothing to catch, and the sweep costs
    // a pane capture plus a transcript read per agent.
    const next = readGateConfig(name)
    const heavy = readGateStatus(name)?.aboveThreshold === true
    scheduleSweep(name, heavy ? Math.min(ABOVE_THRESHOLD_INTERVAL_MS, next.retryIntervalMs) : next.retryIntervalMs)
  }, delayMs))
}

export function startContextRestartGateRunner(): void {
  // Stagger each agent slightly so they don't all hit the DB simultaneously.
  const agents = [MAIN_AGENT_ID, ...listAgentNames()]
  const seen = new Set<string>()
  let offset = 0
  for (const name of agents) {
    if (seen.has(name)) continue
    seen.add(name)
    const cfg = readGateConfig(name)
    if (!cfg.enabled) {
      // Schedule a one-time check after the initial delay in case the config
      // changes at runtime; the per-agent sweep self-terminates when disabled.
      scheduleSweep(name, INITIAL_DELAY_MS + offset)
    } else {
      scheduleSweep(name, INITIAL_DELAY_MS + offset)
    }
    offset += 2_000  // 2s stagger per agent
  }
}

// Re-arm the sweep loop for one agent after its config changes at runtime.
//
// scheduleSweep's disabled branch deletes the agent's timer and stops
// rescheduling itself (see above) -- so once an agent's gate has been off for
// one tick, nothing brings the loop back when the UI flips it back on. The
// settings.ts POST handler that writes the new config calls this right after,
// so toggling the switch takes effect immediately instead of waiting for the
// next dashboard restart. Idempotent: if a timer is already pending for this
// agent (either an active enabled loop, or a disabled one-shot that has not
// fired yet), do nothing -- a second timer would just race the first.
// Kanban 2f7b6d4f, usalackor 2026-08-23 ("bekapcsolaskor hivjon egy
// exportalt ensureSweepScheduled(agent)-et").
export function ensureSweepScheduled(name: string): void {
  if (sweepTimers.has(name)) return
  scheduleSweep(name, INITIAL_DELAY_MS)
}
