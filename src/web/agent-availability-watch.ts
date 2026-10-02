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
import { STORE_DIR } from '../config.js'
import { atomicWriteFileSync } from './atomic-write.js'
import { createAgentMessage, getPendingMessages } from '../db.js'
import { listBrokerCandidateNames, readBrokerCandidate } from './context-broker-store.js'
import { readRateLimitSnapshot } from './rate-limit-status-io.js'
import { getPendingWork } from './pending-work.js'
import {
  availableMessage,
  mayNotify,
  measureAvailability,
  planTransitions,
  type AgentAvailability,
  type AvailabilityState,
  type AvailabilityTransition,
} from '../availability-transitions.js'

export const AVAILABILITY_INTERVAL_MS = 60_000
export const AVAILABILITY_INITIAL_DELAY_MS = 20_000

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

/** Measure the whole fleet now (no I/O besides reading sessions and snapshots). */
export function measureFleet(prev: Record<string, AgentAvailability>, now: number): AgentAvailability[] {
  return listBrokerCandidateNames().map((agent) => {
    const snap = readRateLimitSnapshot(agent)
    const windows = [snap?.fiveHour, snap?.sevenDay]
      .filter((w): w is NonNullable<typeof w> => !!w)
      .map((w) => ({ usedPct: w.usedPct, resetsAt: w.resetsAt }))
    return measureAvailability(readBrokerCandidate(agent), windows, now, prev[agent])
  })
}

/** Tell the agent that just became available to carry on with its own work.
 *  Returns a short note for the log. Only sends when it actually has work. */
function notifyAvailable(t: AvailabilityTransition, state: AvailabilityState): string {
  // A session that just started replays its own pending work through the
  // SessionStart hook; a second message for the same moment would only repeat it.
  if (t.fromReason === 'stopped') return 'no message (session start replays pending work)'
  if (!mayNotify(state, t.agent, t.at)) return 'no message (within the gap since the last one)'
  const pending = getPendingWork(t.agent)
  const waiting = getPendingMessages(t.agent).length
  if (pending.cards.length === 0 && waiting === 0) return 'no message (no pending work)'
  const lines: string[] = []
  if (pending.additionalContext) lines.push(pending.additionalContext)
  else if (pending.cards.length) lines.push(pending.cards.map((c) => `- #${c.seq} ${c.title}`).join('\n'))
  if (waiting > 0) lines.push(`Feldolgozatlan uzeneted: ${waiting} db.`)
  createAgentMessage('system', t.agent, availableMessage(t.agent, t.fromReason, lines.join('\n')), 'availability-watch')
  state.notifiedAt[t.agent] = t.at
  return `message sent (${pending.cards.length} card(s), ${waiting} message(s))`
}

/** The served view: the watcher's state when fresh, otherwise a live measurement. */
export function currentAvailability(now: number = Date.now()): AgentAvailability[] {
  const state = readAvailabilityState()
  const stored = Object.values(state.agents)
  const fresh = stored.length > 0 && stored.every((a) => now - a.measuredAt < 3 * AVAILABILITY_INTERVAL_MS)
  return fresh ? stored : measureFleet(state.agents, now)
}

export function availabilityTick(now: number = Date.now()): void {
  try {
    const state = readAvailabilityState()
    const next = measureFleet(state.agents, now)
    for (const t of planTransitions(state.agents, next)) {
      let note = 'logged'
      if (t.to === 'available') {
        try { note = notifyAvailable(t, state) } catch (err) { note = `notify failed: ${(err as Error)?.message}` }
      }
      logEdge(t, note)
      logger.info({ availability: true, agent: t.agent, to: t.to, reason: t.reason }, `agent availability: ${note}`)
    }
    state.agents = Object.fromEntries(next.map((a) => [a.agent, a]))
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

