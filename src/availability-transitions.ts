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
  /** Epoch ms when a blocking quota window rolls over, or null when unknown / not quota. */
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
  const effective: BrokerCandidate = windows.length
    // usageAt = now: usedPct only grows inside a window, so a reading whose reset
    // is still in the future stays true however old the snapshot is. Without
    // this an idle agent's old 100% would age into "unknown" and read available.
    ? { ...candidate, usageAt: now, usedPct: live.length ? Math.max(...live.map((w) => w.usedPct as number)) : null }
    : candidate
  const available = candidateUsable(effective, now)
  const reason: AvailabilityReason = available ? 'ok' : (candidate.running ? 'quota' : 'stopped')
  const same = prev !== undefined && prev.available === available && prev.reason === reason
  return {
    agent: candidate.agent,
    available,
    reason,
    since: same ? prev.since : now,
    resetsAt: reason === 'quota' ? blockingResetsAt(windows, now) : null,
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

/** The message the agent that just became available receives. Names the work
 *  it already owns (its pending-work text) so it carries on by itself. */
export function availableMessage(agent: string, fromReason: AvailabilityReason, pendingText: string): string {
  const was = fromReason === 'quota' ? 'a keret visszaallt' : 'a session ujra fut'
  return [
    `[ELERHETO] ${agent}: ${was}, most mar tudsz dolgozni. Folytasd a fuggo munkad, nem kell senkire varnod:`,
    '',
    pendingText,
  ].join('\n')
}
