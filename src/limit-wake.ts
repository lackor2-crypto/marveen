// Pure logic for the limit-reset wake (kanban 7951be7d).
//
// Why this exists (Boss, 2026-08-11 15:26, with a screenshot): the Overview
// correctly showed that the Usalackor account's five-hour window had reset --
// "visszaallt (uj adat az ugynok kovetkezo munkajakor)" -- while the agent
// itself sat silent on Telegram: "lathatod hogy alul a telegramban te nem
// csinalsz semmit sem. nem indultal el. nem valaszolsz. es nincs ott az
// udvozlo uzenet amit kertem hogy ezzel ebreszd fel amikor visszajott a
// kapcsolat vagy a % lenullazodott."
//
// The mechanism to wake an account already existed (scripts/agent-wake.sh) and
// worked -- but NOTHING CALLED IT. store/agent-wake.log held only hand-started
// runs. An agent blocked by a full window therefore stayed blocked long after
// the window rolled over, because the only thing that would have revived it
// was Boss noticing and typing.
//
// The trap this has to avoid is the mirror image: an idle account ALWAYS has
// stale figures (the statusline only ticks while the CLI renders, so idleness
// is indistinguishable from absence at the data level). "Wake whenever the
// data is stale" would therefore ping every account forever, and each ping is
// a paid Claude turn. So both triggers here are EDGES, not states:
//
//   - 'limit-reset': a window boundary we already knew about has passed, and
//     no data has arrived since -> wake once PER BOUNDARY. Naturally bounded:
//     at most one wake per window per agent (~1/5h).
//   - 'startup': the dashboard process just came up (boot, service restart,
//     connection back) and this agent's data is stale -> wake once per
//     process start, floored by a persisted per-agent cooldown so the
//     build-restart-build loop cannot turn it into a ping storm.
//
// The I/O (snapshots, tmux, the state file, running agent-wake.sh) lives in
// src/web/limit-wake-runner.ts; this module is dependency-free so the decision
// is unit-testable without a clock or a filesystem.

/** One rate-limit window as captured by statusline.py / the pane scrape. */
export interface LimitWindow {
  usedPct: number | null
  resetsAt: number | null
}

export interface WakeCandidate {
  agent: string
  /** Freshest evidence that this agent took a turn (ms), or null if we have none. */
  lastDataAt: number | null
  /** Every window we know about for this agent (5h, 7d, pane scrape). */
  windows: LimitWindow[]
}
// NOTE: "is the session actually running" is deliberately NOT part of this
// decision. It costs a tmux round per agent, and Boss wants the reset noticed
// within seconds ("ne 5 perc mulva"), so the runner polls fast and only pays
// for tmux once this module has already said a wake is due -- an agent with no
// session is then dropped WITHOUT consuming its boundary, so it still gets its
// wake when the session comes back.

/** Per-agent memory, persisted so a dashboard restart cannot replay wakes. */
export interface WakeState {
  /** When this agent was last woken by the watcher (ms), 0 if never. */
  lastWakeAt: number
  /** The boundary that wake was for, so the same reset never fires twice. */
  lastResetAt: number | null
}

export const INITIAL_WAKE_STATE: WakeState = Object.freeze({ lastWakeAt: 0, lastResetAt: null })

export type WakeReason = 'limit-reset' | 'startup'

export interface WakeDecision {
  agent: string
  reason: WakeReason
  /** The crossed boundary for a 'limit-reset' wake; null for 'startup'. */
  resetAt: number | null
}

/** Floor between two wakes of the SAME agent, whatever the reason. Wide on
 *  purpose: a wake is a paid turn whose only product is a refreshed number. */
export const MIN_WAKE_GAP_MS = 30 * 60_000

/** Data older than this counts as "the agent has not worked recently" for the
 *  startup trigger. Matches STALE_AFTER_MS in rate-limit-status.ts -- the same
 *  line the Overview draws when it stops trusting a reading. */
export const STARTUP_STALE_AFTER_MS = 30 * 60_000

/** Below this, a reset changes nothing worth a turn: an account that used 3%
 *  of its window was never blocked, and its figure is not misleading enough to
 *  pay for. The blocked case -- the one Boss hit -- reads 100. */
export const WAKE_MIN_USED_PCT = 50

/**
 * The most recently crossed window boundary, or null if none has passed.
 *
 * "Most recent" rather than "first": after a long silence both the five-hour
 * and the weekly boundary may lie in the past, and the newer one is the edge
 * that describes the current state. Windows without a usage figure are
 * ignored -- a boundary with no percentage behind it says nothing about
 * whether the agent was ever held up.
 */
export function crossedWindow(windows: LimitWindow[], now: number): { resetsAt: number; usedPct: number } | null {
  let best: { resetsAt: number; usedPct: number } | null = null
  for (const w of windows) {
    if (w.resetsAt === null || w.usedPct === null) continue
    if (!Number.isFinite(w.resetsAt) || !Number.isFinite(w.usedPct)) continue
    if (w.resetsAt > now) continue
    if (!best || w.resetsAt > best.resetsAt) best = { resetsAt: w.resetsAt, usedPct: w.usedPct }
  }
  return best
}

/** Decide whether one agent should be woken, and why. Null = leave it alone. */
export function decideWake(
  candidate: WakeCandidate,
  state: WakeState,
  now: number,
  startupPass: boolean,
): WakeDecision | null {
  if (now - state.lastWakeAt < MIN_WAKE_GAP_MS) return null

  const crossed = crossedWindow(candidate.windows, now)
  if (crossed && crossed.usedPct >= WAKE_MIN_USED_PCT && state.lastResetAt !== crossed.resetsAt) {
    // Data that arrived AFTER the boundary means the agent already took a turn
    // in the new window: the figures are current and nothing is stuck.
    const dataSinceReset = candidate.lastDataAt !== null && candidate.lastDataAt >= crossed.resetsAt
    if (!dataSinceReset) return { agent: candidate.agent, reason: 'limit-reset', resetAt: crossed.resetsAt }
  }

  if (startupPass) {
    const stale = candidate.lastDataAt === null || now - candidate.lastDataAt >= STARTUP_STALE_AFTER_MS
    if (stale) return { agent: candidate.agent, reason: 'startup', resetAt: null }
  }

  return null
}

/** Advance an agent's state for a wake that was actually sent. */
export function recordWake(state: WakeState, decision: WakeDecision, now: number): WakeState {
  return {
    lastWakeAt: now,
    // A startup wake must not consume a pending boundary: the reset edge is
    // still unreported, and the next tick should be free to fire for it once
    // the gap has elapsed.
    lastResetAt: decision.reason === 'limit-reset' ? decision.resetAt : state.lastResetAt,
  }
}

/** Batch form: the runner's whole decision, given every candidate at once. */
export function decideWakes(
  candidates: WakeCandidate[],
  states: Record<string, WakeState>,
  now: number,
  startupPass: boolean,
): WakeDecision[] {
  const out: WakeDecision[] = []
  for (const c of candidates) {
    const decision = decideWake(c, states[c.agent] ?? INITIAL_WAKE_STATE, now, startupPass)
    if (decision) out.push(decision)
  }
  return out
}
