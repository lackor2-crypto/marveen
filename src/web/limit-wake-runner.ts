// Limit-reset wake runner: the I/O half of src/limit-wake.ts (kanban 7951be7d).
//
// Reads what we know about every named Claude account's usage windows, asks the
// pure decision module whether any of them should be woken, and -- when one
// should -- runs scripts/agent-wake.sh for exactly those agents.
//
// Why shell out instead of sending the message from here: agent-wake.sh already
// owns the wake text, the "skip an agent with no tmux session" rule, the
// verify+retry send through scripts/agent-msg.sh (CLAUDE.md's reliable-send
// rule: a curl exit code of 0 does NOT mean the server accepted the message),
// and the store/agent-wake.log audit trail. Re-implementing any of that here
// would give Boss two wake paths that drift apart -- and the hand-run script is
// the one he already trusts.
import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { logger } from '../logger.js'
import { LIMIT_WAKE_ENABLED, MAIN_AGENT_ID, PROJECT_ROOT, STORE_DIR } from '../config.js'
import { readRateLimitSnapshot, readScrapedUsage } from './rate-limit-status-io.js'
import { readClaudePlans } from './claude-plans.js'
import { agentSessionName, sessionExistsOnHost } from './agent-process.js'
import { MAIN_CHANNELS_SESSION } from './main-agent.js'
import { atomicWriteFileSync } from './atomic-write.js'
import { sendAlert } from './channel-monitor.js'
import {
  decideWakes,
  recordWakeAttempt,
  recordWakeSuccess,
  INITIAL_WAKE_STATE,
  type LimitWindow,
  type WakeCandidate,
  type WakeDecision,
  type WakeReason,
  type WakeState,
} from '../limit-wake.js'

// Boss, 2026-08-11: "remelem nem kell varni 5 percet hogy ha a token hasznalat
// resetelodik es ujra mukodhetne az agent akkor azonnal mukodjon. ne 5 perc
// mulva." So the sweep is fast, and the tick is built to deserve it: it reads a
// handful of small JSON files and nothing else. The tmux check (the only
// expensive part) is deferred until the decision is already made, so a quiet
// tick -- which is nearly every tick -- costs no process spawns at all.
//
// The initial delay is the odd one out: on a boot run the fleet's sessions are
// still coming up, and waking an agent that is 10 seconds from existing wastes
// the wake on a session that cannot receive it.
export const LIMIT_WAKE_INITIAL_DELAY_MS = 45_000
export const LIMIT_WAKE_INTERVAL_MS = 20_000

const STATE_PATH = join(STORE_DIR, 'limit-wake-state.json')
const WAKE_SCRIPT = join(PROJECT_ROOT, 'scripts', 'agent-wake.sh')

// The in-memory copy is the AUTHORITY; the file is best-effort persistence.
//
// It used to be the other way round -- every tick re-read the file -- and
// lackor3's review found the consequence: if the store is not writable (full
// disk, read-only mount, a permissions slip), writeStates only warns, the file
// keeps whatever it had, and lastWakeAt stays 0 forever. The 30-minute gap then
// never engages and the watcher spawns a wake plus an owner notification every
// 20 seconds, indefinitely. Memory-first degrades the same failure into "the
// throttle is lost across restarts", which is survivable.
let states: Record<string, WakeState> | null = null

function loadStates(): Record<string, WakeState> {
  if (states === null) states = readStates()
  return states
}

function readStates(): Record<string, WakeState> {
  try {
    const raw = JSON.parse(readFileSync(STATE_PATH, 'utf-8'))
    if (!raw || typeof raw !== 'object') return {}
    const out: Record<string, WakeState> = {}
    for (const [agent, v] of Object.entries(raw as Record<string, unknown>)) {
      if (!v || typeof v !== 'object') continue
      const o = v as Record<string, unknown>
      out[agent] = {
        lastWakeAt: typeof o.lastWakeAt === 'number' && Number.isFinite(o.lastWakeAt) ? o.lastWakeAt : 0,
        lastResetAt: typeof o.lastResetAt === 'number' && Number.isFinite(o.lastResetAt) ? o.lastResetAt : null,
      }
    }
    return out
  } catch {
    // No state yet, or unreadable. Starting from empty can cost one extra wake
    // per agent; losing the file must never stop the watcher.
    return {}
  }
}

function writeStates(states: Record<string, WakeState>): void {
  try {
    atomicWriteFileSync(STATE_PATH, JSON.stringify(states, null, 2))
  } catch (err) {
    // Worth a line: without persistence every dashboard restart re-arms the
    // startup wake, which is exactly the ping storm the cooldown prevents.
    logger.warn({ err, path: STATE_PATH }, 'limit-wake: could not persist state')
  }
}

/** The account-backed agents, i.e. the same set the Overview's account rows
 *  cover: the main agent plus every registered Claude plan. Discovered, never
 *  listed -- an account added tomorrow must be woken too, without a code edit. */
function collectCandidates(): WakeCandidate[] {
  const ids = [MAIN_AGENT_ID, ...readClaudePlans().map(p => p.id).filter(id => id !== MAIN_AGENT_ID)]
  return ids.map(id => {
    const snap = readRateLimitSnapshot(id)
    const scraped = readScrapedUsage(id)
    const windows: LimitWindow[] = []
    if (snap?.fiveHour) windows.push(snap.fiveHour)
    if (snap?.sevenDay) windows.push(snap.sevenDay)
    if (scraped) windows.push({ usedPct: scraped.usedPct, resetsAt: scraped.resetsAt })
    const times = [snap?.updatedAt ?? 0, scraped?.capturedAt ?? 0].filter(t => t > 0)
    return {
      agent: id,
      lastDataAt: times.length ? Math.max(...times) : null,
      windows,
    }
  })
}

/** Whether this agent could receive a wake at all. Costs a tmux round, so it
 *  runs only for an agent the decision already picked. */
function hasLiveSession(agent: string): boolean {
  const session = agent === MAIN_AGENT_ID ? MAIN_CHANNELS_SESSION : agentSessionName(agent)
  return sessionExistsOnHost(null, session)
}

// One line, accent-free -- the router injects it into a tmux pane, same
// constraint the channel-monitor texts follow.
//
// STATEMENT OF FACT, NOT AN ORDER -- and specifically not an order to send
// anything outward.
//
// The first version of this text asked the woken agent to announce itself on
// its own Telegram channel, because the owner judges liveness by what he sees
// in the chat. lackor3 correctly REFUSED (2026-08-11 18:2x): a wake arrives
// through the inter-agent queue, which wraps it as untrusted third-party data,
// and an agent must not perform outbound actions because untrusted content told
// it to. Pressuring it to comply would have trained away a security property
// worth far more than the notification.
//
// So the announcement moved to the party that is actually trusted here: this
// runner (see notifyOwner below). The wake keeps only what an agent may safely
// act on -- the fact that its window reset -- and leaves the decision to resume
// to the agent itself. Taking the turn is what refreshes the limit figures, and
// that happens whatever the agent decides to do with the news.
export function wakeMessage(reason: WakeReason): string {
  return reason === 'limit-reset'
    ? 'Rendszer-jelzes (nem utasitas): a keret-ablakod visszaallt, megint van kereted. Ha volt felfuggesztett munkad, magadtol folytathatod.'
    : 'Rendszer-jelzes (nem utasitas): a rendszer ujraindult vagy visszajott a kapcsolat. A keret-allapotod ezzel a fordulóval frissul.'
}

/** Tell the owner, on his channel, that an agent was woken.
 *
 *  Boss, 2026-08-11: "mar mukoddhetne de telegrammon nem kapott automatan
 *  uzenetet". A wake that only shows up in a log file is, from where he sits,
 *  no wake at all. This is the trusted path for that sentence: the dashboard
 *  knows the wake happened and owns the owner channel, so nobody has to talk an
 *  agent into speaking on its behalf. */
function notifyOwner(reason: WakeReason, agents: string[]): void {
  const what = reason === 'limit-reset'
    ? 'visszaallt a keret-ablaka, felebresztettem'
    : 'ujraindulas/kapcsolat-visszateres utan felebresztettem'
  sendAlert(`🔔 ${agents.join(', ')}: ${what}. Ha volt felfuggesztett munkaja, folytathatja.`)
}

/** Run agent-wake.sh for the decided agents. Resolves to true when the script
 *  reported every send as accepted. */
function runWakeScript(agents: string[], message: string): Promise<boolean> {
  return new Promise(resolve => {
    if (!existsSync(WAKE_SCRIPT)) {
      logger.warn({ script: WAKE_SCRIPT }, 'limit-wake: wake script missing; nothing sent')
      resolve(false)
      return
    }
    execFile(
      '/usr/bin/env',
      ['bash', WAKE_SCRIPT],
      {
        timeout: 120_000,
        env: {
          ...process.env,
          MARVEEN_WAKE_TARGETS: agents.join(' '),
          MARVEEN_WAKE_MESSAGE: message,
          MARVEEN_ROOT: PROJECT_ROOT,
          MARVEEN_STORE: STORE_DIR,
        },
      },
      (err, _stdout, stderr) => {
        if (err) {
          logger.warn({ err, stderr: String(stderr).slice(0, 500), agents }, 'limit-wake: wake script reported a failure')
          resolve(false)
          return
        }
        resolve(true)
      },
    )
  })
}

// The startup trigger is consumed PER AGENT and only inside a short window
// after the process came up. A single global "done" flag was the bug lackor3
// found in the second review: one account with no tmux session kept the flag
// permanently un-set, which left the startup branch armed forever and re-woke
// every other idle account about twice an hour. Two independent bounds now
// close that: an agent is struck off once its startup wake has been attempted,
// and the whole window expires regardless.
const STARTUP_WINDOW_MS = 5 * 60_000
let startupDeadline: number | null = null
const startupDone = new Set<string>()

/** Test seam. */
export function _resetLimitWakeForTest(): void {
  startupDeadline = null
  startupDone.clear()
  states = null
}

async function tick(): Promise<void> {
  // Fenced like the other watchers: this is a setInterval callback, and an
  // escaped throw would reach the uncaughtException handler and take the
  // dashboard down over a missing tmux binary.
  try {
    const now = Date.now()
    if (startupDeadline === null) startupDeadline = now + STARTUP_WINDOW_MS
    const startupOpen = now < startupDeadline
    const startupPassFor = (agent: string) => startupOpen && !startupDone.has(agent)

    const candidates = collectCandidates()
    const current = loadStates()
    const proposed = decideWakes(candidates, current, now, startupPassFor)
    if (proposed.length === 0) return

    // Only now does anything cost a process spawn. An agent with no session is
    // dropped WITHOUT recording anything: its boundary stays unconsumed, so the
    // wake still happens once the session is back, instead of being silently
    // swallowed while it was down.
    const decisions = proposed.filter((d: WakeDecision) => {
      if (hasLiveSession(d.agent)) {
        // Struck off here rather than after the send: whether the script
        // succeeds or not, this agent has had its one startup evaluation.
        if (d.reason === 'startup') startupDone.add(d.agent)
        return true
      }
      // No session yet (45s after a boot is not always enough for the fleet to
      // come up). The agent keeps its startup slot so a later tick can retry --
      // but only until the window closes, which is what stops this from
      // becoming a permanent re-wake loop.
      logger.info({ limitWake: true, agent: d.agent, reason: d.reason }, 'limit-wake: no session to wake; leaving the trigger pending')
      return false
    })
    if (decisions.length === 0) return

    // The ATTEMPT is recorded before the send -- that is the throttle, so a
    // failing send cannot be retried every tick. The boundary is consumed only
    // after the script reports the wake accepted (recordWakeSuccess below).
    for (const d of decisions) {
      states![d.agent] = recordWakeAttempt(states![d.agent] ?? INITIAL_WAKE_STATE, now)
    }
    writeStates(states!)

    // Grouped by reason: the two wakes say different things, and a batch can
    // legitimately contain both (one account's window rolled over in the same
    // tick the dashboard came up).
    for (const reason of ['limit-reset', 'startup'] as WakeReason[]) {
      const agents = decisions.filter((d: WakeDecision) => d.reason === reason).map(d => d.agent)
      if (agents.length === 0) continue
      logger.info({ limitWake: true, reason, agents }, 'limit-wake: waking account agents')
      const ok = await runWakeScript(agents, wakeMessage(reason))
      if (ok) {
        // Only a wake the script actually delivered consumes the boundary.
        for (const d of decisions.filter((x: WakeDecision) => x.reason === reason)) {
          states![d.agent] = recordWakeSuccess(states![d.agent] ?? INITIAL_WAKE_STATE, d)
        }
        writeStates(states!)
        notifyOwner(reason, agents)
      } else {
        logger.warn({ limitWake: true, reason, agents }, 'limit-wake: wake attempt did not complete cleanly; the boundary stays unconsumed, retry after the cooldown')
      }
    }
  } catch (err) {
    logger.warn({ err }, 'limit-wake: tick error')
  }
}

export function startLimitWakeRunner(): NodeJS.Timeout | undefined {
  if (!LIMIT_WAKE_ENABLED) return undefined
  setTimeout(() => { void tick() }, LIMIT_WAKE_INITIAL_DELAY_MS).unref()
  return setInterval(() => { void tick() }, LIMIT_WAKE_INTERVAL_MS)
}
