// Agent-availability watchdog, the I/O half of src/availability-transitions.ts (#463).
//
// Every minute it measures each agent (session alive, quota window), keeps the
// result in store/agent-availability.json (served by GET /api/agents/availability)
// and logs every edge to store/agent-availability.log. The edge into
// "available" is delivered to the agent that just woke, together with its own
// pending work, so it carries on without anyone relaying the news. It is NOT
// routed through the main agent: that one may itself be unavailable.
//
// Fail-open: any error in a tick is logged and swallowed; a watcher must never
// be able to stop the fleet.
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { logger } from '../logger.js'
import { MAIN_AGENT_ID, STORE_DIR } from '../config.js'
import { mainAgentEffectiveConfigDir } from './agent-config.js'
import { atomicWriteFileSync } from './atomic-write.js'
import { createAgentMessage, getPendingMessages } from '../db.js'
import { listBrokerCandidateNames, readAgentPane, readBrokerCandidate } from './context-broker-store.js'
import { paneShowsLimitBlock } from '../pane-state.js'
import { detectReauthNeeded } from './reauth-detect.js'
import { readRateLimitSnapshot } from './rate-limit-status-io.js'
import { defaultPendingWorkDeps, getPendingWork } from './pending-work.js'
import {
  availableMessage,
  credentialsSignedOut,
  mayNotify,
  measureAvailability,
  planPendingText,
  planTransitions,
  type AgentAvailability,
  type AvailabilityState,
  type AvailabilityTransition,
  type PendingSummary,
} from '../availability-transitions.js'

export const AVAILABILITY_INTERVAL_MS = 60_000
export const AVAILABILITY_INITIAL_DELAY_MS = 20_000
/** How many ticks in a row a failed "you are back" message is tried again
 *  before the edge is given up: a store that stays broken must not turn the
 *  edge log into one line a minute, forever. */
export const MAX_NOTIFY_ATTEMPTS = 5

const STATE_PATH = join(STORE_DIR, 'agent-availability.json')
const LOG_PATH = join(STORE_DIR, 'agent-availability.log')

export function readAvailabilityState(): AvailabilityState {
  try {
    if (!existsSync(STATE_PATH)) return { agents: {}, notifiedAt: {} }
    const raw = JSON.parse(readFileSync(STATE_PATH, 'utf-8'))
    return {
      agents: raw && typeof raw.agents === 'object' && raw.agents ? raw.agents : {},
      notifiedAt: raw && typeof raw.notifiedAt === 'object' && raw.notifiedAt ? raw.notifiedAt : {},
    }
  } catch {
    return { agents: {}, notifiedAt: {} }
  }
}

function writeAvailabilityState(state: AvailabilityState): void {
  atomicWriteFileSync(STATE_PATH, JSON.stringify(state, null, 2))
}

function logEdge(t: AvailabilityTransition, note: string): void {
  try {
    const when = new Date(t.at).toISOString()
    appendFileSync(LOG_PATH, `${when} ${t.agent} -> ${t.to} (${t.fromReason} -> ${t.reason}) ${note}\n`)
  } catch { /* the log is a trace, not a dependency */ }
}

/** #653: the main agent's isolated login, read from its credentials file. Best effort: any failure -> not signed out. */
function agentSignedOut(agent: string): boolean {
  if (agent !== MAIN_AGENT_ID) return false
  try {
    return credentialsSignedOut(readFileSync(join(mainAgentEffectiveConfigDir(), '.credentials.json'), 'utf-8'))
  } catch { return false }
}

/** How many non-empty pane lines at the bottom count as "what the session shows right now". */
const PANE_LIVE_LINES = 14

/** What the session's own screen says overrides the numbers (the owner, 2026-10-23: "you could not tell Marvin was
 *  not alive"). A snapshot only refreshes while the agent works, so a session sitting on "Usage limit reached" or a
 *  login prompt kept reading "ok" for hours; the screen is the one source that cannot be stale. Only a session that
 *  is running and measured available is overridden, and only by evidence in the live bottom of the pane. */
export function applyPaneEvidence(a: AgentAvailability, pane: string | null): AgentAvailability {
  if (!a.available || !pane) return a
  const live = pane.split('\n').filter((l) => l.trim()).slice(-PANE_LIVE_LINES).join('\n')
  if (detectReauthNeeded(live).needsReauth) return { ...a, available: false, reason: 'signed_out', since: a.measuredAt, resetsAt: null }
  if (paneShowsLimitBlock(live)) return { ...a, available: false, reason: 'quota', since: a.measuredAt, resetsAt: null }
  return a
}

/** Measure the whole fleet now (no I/O besides reading sessions and snapshots). */
export function measureFleet(prev: Record<string, AgentAvailability>, now: number): AgentAvailability[] {
  return listBrokerCandidateNames().map((agent) => {
    const snap = readRateLimitSnapshot(agent)
    const windows = [
      snap?.fiveHour ? { usedPct: snap.fiveHour.usedPct, resetsAt: snap.fiveHour.resetsAt } : null,
      // #569: the weekly window is marked as such -- it blocks only when spent, not from 95%.
      snap?.sevenDay ? { usedPct: snap.sevenDay.usedPct, resetsAt: snap.sevenDay.resetsAt, weekly: true } : null,
    ].filter((w): w is NonNullable<typeof w> => !!w)
    const cand = readBrokerCandidate(agent)
    const m = measureAvailability(cand, windows, now, prev[agent], agentSignedOut(agent))
    const seen = applyPaneEvidence(m, m.available ? readAgentPane(agent) : null)
    // Keep the previous "since" when the screen merely confirms the state that was already stored.
    return seen !== m && prev[agent]?.reason === seen.reason && prev[agent]?.available === seen.available ? { ...seen, since: prev[agent]!.since } : seen
  })
}

/** Tell the agent that just became available to carry on with its own work.
 *  Returns a short note for the log. Only sends when it actually has work. */
function notifyAvailable(t: AvailabilityTransition, state: AvailabilityState): string {
  // A session that just started replays its own pending work through the
  // SessionStart hook; a second message for the same moment would only repeat it.
  if (t.fromReason === 'stopped') return 'no message (session start replays pending work)'
  if (!mayNotify(state, t.agent, t.at)) return 'no message (within the gap since the last one)'
  const plan = planPendingText(readPendingSummary(t.agent))
  if (!plan.send) return plan.note
  createAgentMessage('system', t.agent, availableMessage(t.agent, t.fromReason, plan.text), 'availability-watch')
  state.notifiedAt[t.agent] = t.at
  return plan.note
}

/** What this agent already owns, read from the live store.
 *
 *  The list is built here rather than taken from getPendingWork's ready-made
 *  SessionStart text: that one opens with "this session started idle after a
 *  restart" and the greeting rules of a fresh session, neither of which is
 *  true for a session that ran all along and merely got its quota back. The
 *  task-state check is switched off for the same reason -- it exists so a
 *  SessionStart does not inject the same work twice, and there is no
 *  SessionStart here: with it on, an agent holding a saved task state would be
 *  read as having nothing to do. */
function readPendingSummary(agent: string): PendingSummary {
  const pending = getPendingWork(agent, { ...defaultPendingWorkDeps, hasActiveTaskState: () => false })
  let waitingMessages = 0
  let unreadable = pending.olvashatatlan
  try {
    waitingMessages = getPendingMessages(agent).length
  } catch {
    unreadable = true
  }
  return { cards: pending.cards, memories: pending.memories, waitingMessages, unreadable }
}

/** The served view: the watcher's state when fresh, otherwise a live measurement. */
export function currentAvailability(now: number = Date.now()): AgentAvailability[] {
  const state = readAvailabilityState()
  const stored = Object.values(state.agents)
  const fresh = stored.length > 0 && stored.every((a) => now - a.measuredAt < 3 * AVAILABILITY_INTERVAL_MS)
  return fresh ? stored : measureFleet(state.agents, now)
}

/** Failed sends in a row per agent. In memory on purpose: a dashboard restart
 *  is a fair reason to try again from the start. */
const notifyFailures = new Map<string, number>()

export function availabilityTick(now: number = Date.now()): void {
  try {
    const state = readAvailabilityState()
    const prev = state.agents
    const next = measureFleet(prev, now)
    const retry = new Set<string>()
    for (const t of planTransitions(prev, next)) {
      let note = 'logged'
      if (t.to === 'available') {
        try {
          note = notifyAvailable(t, state)
          notifyFailures.delete(t.agent)
        } catch (err) {
          const attempts = (notifyFailures.get(t.agent) ?? 0) + 1
          if (attempts < MAX_NOTIFY_ATTEMPTS) {
            notifyFailures.set(t.agent, attempts)
            retry.add(t.agent)
            note = `notify failed, will retry: ${(err as Error)?.message}`
          } else {
            notifyFailures.delete(t.agent)
            note = `notify failed ${attempts} times, giving up: ${(err as Error)?.message}`
          }
        }
      }
      logEdge(t, note)
      logger.info({ availability: true, agent: t.agent, to: t.to, reason: t.reason }, `agent availability: ${note}`)
    }
    // An edge whose message could not be sent is not consumed: that agent keeps
    // its previous entry, so the next tick sees the same edge and tries again.
    // Consuming it would lose the one message this watcher exists to deliver --
    // no second edge comes while the agent sits idle.
    state.agents = Object.fromEntries(next.map((a) => [a.agent, retry.has(a.agent) ? prev[a.agent]! : a]))
    writeAvailabilityState(state)
  } catch (err) {
    logger.warn({ err }, 'agent availability: tick error')
  }
}

export function startAvailabilityWatch(): NodeJS.Timeout | undefined {
  if (process.env.MARVEEN_AVAILABILITY_WATCH === '0') return undefined
  setTimeout(() => availabilityTick(), AVAILABILITY_INITIAL_DELAY_MS).unref()
  return setInterval(() => availabilityTick(), AVAILABILITY_INTERVAL_MS)
}

