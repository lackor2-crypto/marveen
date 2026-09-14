// Can a scheduled task's target agent actually RUN an injected prompt right now?
//
// The scheduler used to pick an 'any' target by liveness alone (isAgentRunning):
// a tmux session that is up. But "up" is not "able to work". On 2026-09-14 the
// gold-analysis heartbeat fired five times into lackor3, whose weekly quota was
// exhausted: the session was alive, the prompt was injected, task_runs recorded
// 'fired' -- and nothing ran, because every turn was rejected on the usage wall.
// The recipient never produced the analysis and the operator's contact got
// nothing. 'fired' means "injected", never "executed".
//
// This module adds the missing predicate -- is the agent at its usage wall? --
// read from the same per-agent rate-limit snapshot the dashboard already shows
// (store/rate-limit-status/<agent>.json, written by the statusline hook for
// EVERY agent including the main one). It is a cheap file read, host-agnostic
// (per-agent file, no hard-coded names), and safe on a fresh install (no file
// yet -> not blocked -> fail-open).

import { readRateLimitSnapshot } from './rate-limit-status-io.js'
import type { RateLimitSnapshot } from '../rate-limit-status.js'

// A usage window at or above this percent is the account's ceiling, where
// Claude Code rejects every turn. This is the wall, not a warning -- an agent
// reading 100% cannot run the prompt we inject, so it must not be chosen.
export const QUOTA_BLOCK_PCT = 100

// A snapshot older than this is not trusted to prove a live block: the window
// may have reset since the reading was taken. Stale -> treat as NOT blocked
// (fail-open). The worst case of a false negative is the pre-existing behaviour
// (route to it, then the verify-started + retry queue re-delivers); a false
// positive would needlessly skip a healthy agent, so uncertainty must never
// read as "blocked".
export const QUOTA_SNAPSHOT_MAX_AGE_MS = 30 * 60_000

/** Pure: does this snapshot prove the agent is at a usage wall right now?
 *  Blocked when EITHER window (5-hour or 7-day) is at/above the ceiling and its
 *  reset is still in the future -- a 7-day wall is what silenced the gold
 *  analysis, so the doctrine's "only the 5-hour counts" (a rule about OUR own
 *  throttling choices) does NOT apply here: a 7-day-exhausted account literally
 *  cannot run a turn. A past resetsAt means the wall is already down, so that
 *  window does not block. */
export function snapshotSaysBlocked(
  snap: Pick<RateLimitSnapshot, 'fiveHour' | 'sevenDay' | 'measuredAt'> | null,
  now: number,
  maxAgeMs: number = QUOTA_SNAPSHOT_MAX_AGE_MS,
): boolean {
  if (!snap) return false
  if (snap.measuredAt && now - snap.measuredAt > maxAgeMs) return false
  const windowBlocks = (w: RateLimitSnapshot['fiveHour']): boolean =>
    !!w &&
    typeof w.usedPct === 'number' &&
    w.usedPct >= QUOTA_BLOCK_PCT &&
    (w.resetsAt == null || w.resetsAt > now)
  return windowBlocks(snap.fiveHour) || windowBlocks(snap.sevenDay)
}

/** Live: is the named agent at its usage wall right now? Any read failure
 *  returns false (fail-open: never skip a candidate on an unreadable snapshot). */
export function isAgentQuotaBlocked(agentName: string, now: number = Date.now()): boolean {
  try {
    return snapshotSaysBlocked(readRateLimitSnapshot(agentName), now)
  } catch {
    return false
  }
}

/** Pure: the first agent in preference order that is both awake AND able to work
 *  (not at its usage wall), or undefined if none qualifies. Used to route an
 *  'any' scheduled task -- and to re-route a queued retry off a dead agent onto
 *  one that can actually run it. */
export function firstWorkingAgent(
  ordered: string[],
  isRunning: (a: string) => boolean,
  isBlocked: (a: string) => boolean,
): string | undefined {
  return ordered.find(a => isRunning(a) && !isBlocked(a))
}

/** Pure: resolve the single target for an 'any' scheduled task.
 *  Prefer an agent that can actually work; if none can, fall back to the first
 *  awake one (so the never-abandon retry queue keeps trying and re-routes when
 *  one frees); if none is even awake, fall back to the main agent so the caller
 *  cold-starts it. Late beats never -- the fallback never returns empty. */
export function pickAnyTarget(
  ordered: string[],
  isRunning: (a: string) => boolean,
  isBlocked: (a: string) => boolean,
  fallbackMain: string,
): string {
  const working = firstWorkingAgent(ordered, isRunning, isBlocked)
  if (working) return working
  const awake = ordered.find(a => isRunning(a))
  return awake ?? fallbackMain
}

// --- verify-started: did an injected prompt actually begin running? ---
//
// After a task fires, the post-fire watchdog (taskInflightMap) polls the pane.
// It handled "started but stuck" (busy past a timeout) but NOT "never started":
// a prompt injected into a quota-blocked session leaves the pane on the usage
// limit screen, which reads as IDLE -- so the watchdog cleared the entry as if
// the task had completed. That is the exact hole that lost the gold analysis.
//
// The safe signal for "it never ran" is NOT "we didn't observe busy" (a fast
// task can finish between 15s sweeps -- re-firing on that would double-run it).
// It is a PROVABLE non-start: the agent is at its usage wall (blockedNow) and we
// never saw it go busy, once a grace window has passed. Only then do we hand the
// task back to the retry queue, which re-routes it (firstWorkingAgent) to an
// agent that can run it.

// Boss (2026-09-14): "a kiadott parancs utan ellenorizze is hogy elindult-e a
// folyamat, es ha nem akkor probalja ujra ... 5 perces szunettel." The verify
// window doubles as that spacing: we wait 5 minutes before declaring a
// non-start and re-queuing.
export const VERIFY_STARTED_WINDOW_MS = 5 * 60_000

export type VerifyStartedDecision = 'hold' | 'refire'

/** Pure: given what we know about a fired task's target, decide whether to keep
 *  waiting or to re-queue it for delivery to a working agent.
 *   - 'hold'   : window not elapsed, OR the agent started working, OR we cannot
 *                PROVE it never ran (agent not blocked). Never re-fire on doubt.
 *   - 'refire' : the window elapsed, the agent never went busy, and it is at its
 *                usage wall -> it could not have run the prompt. Safe to re-queue
 *                (the queue re-routes to a working agent; it never double-runs a
 *                task that actually executed, because a running agent is not
 *                blocked). */
export function decideVerifyStarted(
  i: { injectedAt: number; sawBusy: boolean; blockedNow: boolean },
  now: number,
  windowMs: number = VERIFY_STARTED_WINDOW_MS,
): VerifyStartedDecision {
  if (now - i.injectedAt < windowMs) return 'hold'
  if (i.sawBusy) return 'hold'
  if (!i.blockedNow) return 'hold'
  return 'refire'
}
