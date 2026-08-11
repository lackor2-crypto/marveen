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
 * The most recently crossed boundary that is WORTH waking for, or null.
 *
 * "Worth waking for" is part of the selection, not a filter applied after it.
 * The first version picked the most recent crossed boundary and only then
 * checked its percentage -- so a weekly window sitting at 20% that rolled over
 * an hour after an exhausted five-hour window SUPPRESSED the wake the exhausted
 * window had earned (lackor3's review, 2026-08-11): windows =
 * [5h{100%, 10:00}, 7d{20%, 11:00}] at 12:00 picked the weekly row, 20 < 50,
 * and the agent stayed dead with a reset window. Exactly the failure this
 * module exists to prevent, reintroduced by the ranking.
 *
 * Windows without a usage figure are ignored -- a boundary with no percentage
 * behind it says nothing about whether the agent was ever held up.
 */
export function crossedWindow(
  windows: LimitWindow[],
  now: number,
  minUsedPct: number = WAKE_MIN_USED_PCT,
): { resetsAt: number; usedPct: number } | null {
  let best: { resetsAt: number; usedPct: number } | null = null
  for (const w of windows) {
    if (w.resetsAt === null || w.usedPct === null) continue
    if (!Number.isFinite(w.resetsAt) || !Number.isFinite(w.usedPct)) continue
    if (w.resetsAt > now) continue
    if (w.usedPct < minUsedPct) continue
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
  // A lastWakeAt in the FUTURE means the clock moved backwards (WSL2 resume
  // drift, an NTP correction, a manual change). Subtracting it would make the
  // gap negative and silence every wake until real time caught up -- possibly
  // for days (lackor3's review). An impossible timestamp is treated as "never".
  const sinceLastWake = state.lastWakeAt > now ? Number.POSITIVE_INFINITY : now - state.lastWakeAt
  if (sinceLastWake < MIN_WAKE_GAP_MS) return null

  const crossed = crossedWindow(candidate.windows, now)
  if (crossed && state.lastResetAt !== crossed.resetsAt) {
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

/**
 * Advance state for a wake ATTEMPT, before anything is sent.
 *
 * This consumes the 30-minute gap and nothing else: it is the throttle that
 * stops a failing send from being retried every tick. The boundary is NOT
 * consumed here -- see recordWakeSuccess.
 */
export function recordWakeAttempt(state: WakeState, now: number): WakeState {
  return { ...state, lastWakeAt: now }
}

/**
 * Consume the boundary, once the wake is known to have been accepted.
 *
 * Split from the attempt after lackor3's review (2026-08-11) found that a
 * single transient failure -- a 500 from the dashboard, a curl timeout, tmux
 * hiccuping -- permanently swallowed the wake: the boundary was marked as
 * reported before the send, and no new boundary can appear while the agent is
 * asleep (an asleep agent takes no turn, so its snapshot never advances). The
 * agent stayed silent until the next dashboard restart, in precisely the
 * situation this feature exists for.
 *
 * A startup wake never consumes a boundary: the reset edge is still unreported
 * and must remain free to fire once the gap elapses.
 */
export function recordWakeSuccess(state: WakeState, decision: WakeDecision): WakeState {
  if (decision.reason !== 'limit-reset') return state
  return { ...state, lastResetAt: decision.resetAt }
}

/** Batch form: the runner's whole decision, given every candidate at once. */
/**
 * Batch form. `startupPass` is asked PER AGENT, not once for the whole sweep.
 *
 * It used to be a single boolean the runner kept in a global flag, and lackor3's
 * second review found what that costs: one account with no tmux session keeps
 * proposing a startup wake, the flag can never be marked done, and the startup
 * branch therefore stays armed forever -- re-waking every OTHER idle account
 * about twice an hour, each time a paid turn and an owner notification. That is
 * the "state-based waking pings an idle account forever" failure this module's
 * header warns about, returning through the back door.
 */
export function decideWakes(
  candidates: WakeCandidate[],
  states: Record<string, WakeState>,
  now: number,
  startupPass: (agent: string) => boolean,
): WakeDecision[] {
  const out: WakeDecision[] = []
  for (const c of candidates) {
    const decision = decideWake(c, states[c.agent] ?? INITIAL_WAKE_STATE, now, startupPass(c.agent))
    if (decision) out.push(decision)
  }
  return out
}
