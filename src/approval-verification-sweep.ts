// Stale approval-verification sweep (Boss 2026-08-23).
//
// The problem this exists for, measured on the live board that day: of 176
// verification tasks dispatched to the free OpenRouter agents since 08-09,
// 100 were still sitting in 'pending' -- some for two weeks. The approvals
// page therefore showed counters like "Folyamatban (0/4)" that could never
// resolve, and nothing in the fleet ever noticed. Four separate causes, all
// invisible from the dashboard:
//   * the agent's model was withdrawn from the provider (Ling), or every call
//     returned a provider 400 (North);
//   * the agent read the task, answered in its own pane, and never called the
//     verify-result endpoint (Nemotronnano, Nemotronnano9, Lagunas);
//   * the agent had never once produced a result (Gemma, Nemotronvision);
//   * the machine restarted and nothing re-dispatched what was in flight.
//
// The fix is deliberately not "retry forever": one nudge, then a terminal
// 'noresponse' state so the counter resolves and the reliability badge can
// see the failure. 'noresponse' is NOT a verdict on the change under review,
// which is why the UI paints it amber rather than red (Boss: "narancssarga,
// mert piros akkor baj van").
//
// The core is dependency-injected so it unit-tests without a database, a
// tmux session, or a clock.
import type { ApprovalVerification } from './db.js'

/** No answer this long after dispatch and the agent gets one reminder. */
export const VERIFICATION_REMINDER_MS = 10 * 60 * 1000
/** No answer this long after dispatch and the row is given up on. Deliberately
 *  generous: a real review of a real commit (git show, reading the file, curling
 *  the endpoint) took the Szakerto ~10 minutes on 2026-08-23, and marking a
 *  slow-but-working agent as "never answered" would both lie on the page and
 *  dent its reliability badge. Waiting costs nothing but a later counter. */
export const VERIFICATION_TIMEOUT_MS = 45 * 60 * 1000

/** Stored in `report` instead of a sentence, so the dashboard can render the
 *  explanation in the reader's own language (HU/EN) rather than whatever
 *  language the sweep happened to be written in. */
export const NO_RESPONSE_TIMEOUT = 'noresponse:timeout'
export const NO_RESPONSE_AGENT_GONE = 'noresponse:agent_gone'

export interface VerificationSweepDeps {
  /** Wall clock, ms. */
  now: number
  /** Pending rows requested at or before the given epoch-SECOND cutoff. */
  listPendingOlderThan(cutoffEpochSec: number): ApprovalVerification[]
  /** False when the agent directory is gone (deleted / renamed). */
  agentExists(agent: string): boolean
  /** Delivers the one-time nudge. Return false if it could not be queued. */
  sendReminder(row: ApprovalVerification): boolean
  markReminded(id: string, atEpochSec: number): boolean
  markNoResponse(id: string, reason: string, atEpochSec: number): boolean
}

export interface VerificationSweepResult {
  reminded: string[]
  expired: string[]
}

/**
 * One pass. Safe to run on every startup and on a timer: each row is nudged
 * at most once (reminded_at) and expired at most once (the UPDATE is guarded
 * on status = 'pending'), so a restart loop cannot spam anyone.
 */
export function runVerificationSweep(deps: VerificationSweepDeps): VerificationSweepResult {
  const nowSec = Math.floor(deps.now / 1000)
  const reminded: string[] = []
  const expired: string[] = []

  // One query for the widest window (the reminder), then split in memory --
  // the timeout set is a subset of it.
  const cutoffSec = Math.floor((deps.now - VERIFICATION_REMINDER_MS) / 1000)
  for (const row of deps.listPendingOlderThan(cutoffSec)) {
    const ageMs = deps.now - row.requested_at * 1000

    // An agent that no longer exists can never answer -- do not wait out the
    // full timeout for it, and never try to message it. This is the path that
    // clears rows left behind when an unreliable agent is removed.
    if (!deps.agentExists(row.agent)) {
      if (deps.markNoResponse(row.id, NO_RESPONSE_AGENT_GONE, nowSec)) expired.push(row.id)
      continue
    }

    if (ageMs >= VERIFICATION_TIMEOUT_MS) {
      if (deps.markNoResponse(row.id, NO_RESPONSE_TIMEOUT, nowSec)) expired.push(row.id)
      continue
    }

    if (row.reminded_at == null) {
      // Mark first: if the send throws or the router drops it, the row still
      // times out normally instead of being nudged again every sweep.
      if (deps.markReminded(row.id, nowSec)) {
        if (deps.sendReminder(row)) reminded.push(row.id)
      }
    }
  }

  return { reminded, expired }
}
