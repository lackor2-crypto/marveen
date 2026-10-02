// Pure logic for the agent-availability watchdog (kanban #463).
//
// Why this exists: after an agent's quota window reset, the main agent kept
// believing the old "exhausted" reading for hours and never handed it work
// until the owner asked. A reading is an event at one moment, not a fact, so a
// watcher measures every agent on a clock, keeps the last state, and reports
// the EDGES (blocked -> available and back). The edge into "available" is the
// one that matters: whoever just became able to work is told so directly and
// carries on with their own pending work -- nobody has to notice and relay it.
//
// No I/O here: the measurement inputs and the previous state are passed in, so
// the decision is testable without a clock, tmux or a filesystem.
import { candidateUsable, type BrokerCandidate } from './context-broker.js'
import { CRITICAL_THRESHOLD_PCT } from './rate-limit-status.js'

export type AvailabilityReason = 'ok' | 'stopped' | 'quota'

export interface AgentAvailability {
  agent: string
  available: boolean
  reason: AvailabilityReason
  /** Epoch ms since which this exact state (available + reason) holds. */
  since: number
  /** Epoch ms when a spent quota window rolls over, or null when none is known.
   *  Set for a stopped agent too, when its window is spent as well. */
  resetsAt: number | null
  /** Epoch ms of this measurement. */
  measuredAt: number
}

export interface AvailabilityWindow {
  usedPct: number | null
  resetsAt: number | null
}

export interface AvailabilityTransition {
  agent: string
  to: 'available' | 'blocked'
  /** What the agent was before / is now blocked by. */
  fromReason: AvailabilityReason
  reason: AvailabilityReason
  at: number
}

/** Persisted watcher state: last measurement per agent, plus when each was last told. */
export interface AvailabilityState {
  agents: Record<string, AgentAvailability>
  /** Epoch ms of the last "you are available" message per agent. */
  notifiedAt: Record<string, number>
}

export const EMPTY_AVAILABILITY_STATE: AvailabilityState = Object.freeze({ agents: {}, notifiedAt: {} }) as AvailabilityState

/** Floor between two "you are available" messages to the SAME agent. A flapping
 *  window (95% <-> 94%) must not turn into a message storm. */
export const MIN_NOTIFY_GAP_MS = 10 * 60_000

/** When the blocking window rolls over: the latest future resetsAt among the
 *  windows that are at the critical line. Null when none qualifies. */
export function blockingResetsAt(windows: AvailabilityWindow[], now: number): number | null {
  let latest: number | null = null
  for (const w of windows) {
    if (w.usedPct === null || w.usedPct < CRITICAL_THRESHOLD_PCT) continue
    if (w.resetsAt === null || w.resetsAt <= now) continue
    if (latest === null || w.resetsAt > latest) latest = w.resetsAt
  }
  return latest
}

/** Measure one agent. `prev` only supplies `since`, so a state that did not
 *  change keeps its original start time. */
export function measureAvailability(
  candidate: BrokerCandidate,
  windows: AvailabilityWindow[],
  now: number,
  prev?: AgentAvailability,
): AgentAvailability {
  // A window whose reset time has passed no longer counts, however fresh the
  // snapshot that recorded it: waiting for the snapshot to go stale would delay
  // the "you are back" edge by up to half an hour after the actual reset.
  const live = windows.filter((w) => w.usedPct !== null && (w.resetsAt === null || w.resetsAt > now))
  // The other direction of the same rule: a spent window whose reset is still
  // ahead stays spent however OLD the snapshot is. An exhausted agent stops
  // writing snapshots, so trusting only fresh ones reported it "available" --
  // and sent it a "your quota is back" message -- half an hour after it ran out.
  // It is tied to the KNOWN reset time (blockedUntil), not to "the snapshot
  // never ages": a spent reading with no reset time must still age into
  // "unknown", or that agent would read exhausted forever -- the very belief
  // this watcher exists to end.
  const effective: BrokerCandidate = windows.length
    ? {
        ...candidate,
        usedPct: live.length ? Math.max(...live.map((w) => w.usedPct as number)) : null,
        blockedUntil: blockingResetsAt(windows, now),
      }
    : candidate
  const available = candidateUsable(effective, now)
  const reason: AvailabilityReason = available ? 'ok' : (candidate.running ? 'quota' : 'stopped')
  const same = prev !== undefined && prev.available === available && prev.reason === reason
  return {
    agent: candidate.agent,
    available,
    reason,
    since: same ? prev.since : now,
    // Reported for a stopped agent too: starting a session whose window is
    // still spent gains nothing, and the reader has to be able to see that.
    resetsAt: available ? null : (effective.blockedUntil ?? null),
    measuredAt: now,
  }
}

/** Edges between the stored state and a fresh measurement. An agent with no
 *  previous entry yields NO transition: the first reading after install or a
 *  dashboard restart is a baseline, not news (otherwise every restart would
 *  announce the whole fleet). */
export function planTransitions(
  prev: Record<string, AgentAvailability>,
  next: AgentAvailability[],
): AvailabilityTransition[] {
  const out: AvailabilityTransition[] = []
  for (const n of next) {
    const p = prev[n.agent]
    if (!p || p.available === n.available) continue
    out.push({
      agent: n.agent,
      to: n.available ? 'available' : 'blocked',
      fromReason: p.reason,
      reason: n.reason,
      at: n.measuredAt,
    })
  }
  return out
}

/** Whether a "you are available" message may go out now (not within the gap). */
export function mayNotify(state: AvailabilityState, agent: string, now: number): boolean {
  const last = state.notifiedAt[agent]
  return last === undefined || now - last >= MIN_NOTIFY_GAP_MS
}

/** What the watcher could read about the work an agent already owns. */
export interface PendingSummary {
  cards: { seq?: number; title: string }[]
  memories: { id: number; content: string }[]
  /** Inter-agent messages still waiting for this agent. */
  waitingMessages: number
  /** The store could not be read: "nothing found" would be a guess. */
  unreadable: boolean
}

export interface PendingPlan {
  send: boolean
  /** Body of the message; empty when nothing is sent. */
  text: string
  /** One line for the edge log. */
  note: string
}

/**
 * Decide whether the agent that just came back gets a message, and what it
 * lists. Zero has two meanings here: "nothing is waiting" is silence, "could
 * not look" is NOT -- the agent is still told it is back, and that its list
 * could not be read, so it checks for itself instead of sitting idle.
 */
export function planPendingText(p: PendingSummary): PendingPlan {
  if (p.unreadable) {
    return {
      send: true,
      text: 'A fuggo munkad listajat most nem sikerult kiolvasni: nezd meg magad a kanbant es az uzeneteidet.',
      note: 'message sent (pending work unreadable)',
    }
  }
  if (p.cards.length === 0 && p.waitingMessages === 0) {
    return { send: false, text: '', note: 'no message (no pending work)' }
  }
  const lines: string[] = []
  if (p.cards.length) {
    lines.push('FUGGO KANBAN KARTYAK (in_progress, neked cimezve):')
    for (const c of p.cards) lines.push(`  - ${c.seq != null ? `#${c.seq} ` : ''}${c.title}`)
  }
  if (p.memories.length) {
    lines.push('FRISS HOT-EMLEKEK (a legutobbi munkad):')
    for (const m of p.memories) lines.push(`  - [emlek ${m.id}] ${m.content}`)
  }
  if (p.waitingMessages > 0) lines.push(`Feldolgozatlan uzeneted: ${p.waitingMessages} db.`)
  return {
    send: true,
    text: lines.join('\n'),
    note: `message sent (${p.cards.length} card(s), ${p.waitingMessages} message(s))`,
  }
}

/** The message the agent that just became available receives. Names the work
 *  it already owns so it carries on by itself.
 *
 *  A statement of fact, not an order: it travels through the inter-agent queue,
 *  which frames a system sender as untrusted data, and an agent is right to
 *  refuse an instruction from there (the limit-wake text learned this first).
 *  What to DO with the fact is in the agent's own rule file (the availability
 *  rule in agent-scaffold.ts), which it does trust. */
export function availableMessage(agent: string, fromReason: AvailabilityReason, pendingText: string): string {
  const was = fromReason === 'quota' ? 'a keret-ablakod visszaallt' : 'a sessionod ujra fut'
  return [
    `[ELERHETO] ${agent}: rendszer-jelzes (nem utasitas) -- ${was}, megint tudsz dolgozni. A sajat fuggo munkad, amit magadtol folytathatsz (nem kell masra varnod):`,
    '',
    pendingText,
  ].join('\n')
}
