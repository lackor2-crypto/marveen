import { logger } from '../logger.js'
import { isCompactionInFlight, markCompactionStarted, settleCompaction } from './compaction-inflight.js'

// Press Compact, land under the number you set. Boss, 2026-08-12: "tomoritesnel
// kezi gomb megnyomasanal a beallitott ertek alatt legyen mindenfelekeppen a
// tomorites nagysaga. ha veletlenul nagyobb lenne akkor meg tomoritsen rajta."
//
// One /compact is not a promise about the result -- the model summarizes what it
// can, and a context dominated by one enormous turn can survive a round almost
// untouched. So after a manual compaction lands we measure, and if it is still
// over the agent's configured threshold we go again.
//
// Bounded on purpose, three ways, because "keep compacting until it fits" is a
// loop that eats an agent's whole quota on a context that cannot shrink:
//   - at most MAX_ROUNDS extra attempts,
//   - stop the moment a round fails to shrink the context meaningfully,
//   - stop when the size cannot be measured at all (a quota-limited agent
//     reports no numbers, and hammering it would not change that).
export const MAX_ROUNDS = 2
export const MIN_REDUCTION = 0.1   // same evidence bar the gate uses

export interface FollowUpInput {
  /** Live context size after the compaction that just landed, or null. */
  tokens: number | null
  /** The agent's configured auto-compaction threshold, in tokens. */
  thresholdTokens: number
  /** How many EXTRA compactions we have already sent (0 on the first check). */
  round: number
  /** Size before the compaction that just landed, or null when unknown. */
  previousTokens: number | null
}

export interface FollowUpDecision { again: boolean; reason: string }

/** Pure: should we send one more /compact? */
export function decideFollowUp(input: FollowUpInput): FollowUpDecision {
  const { tokens, thresholdTokens, round, previousTokens } = input
  if (tokens === null) return { again: false, reason: 'context-unmeasurable (nothing to decide on)' }
  if (tokens < thresholdTokens) return { again: false, reason: `under the threshold (${tokens} < ${thresholdTokens})` }
  if (round >= MAX_ROUNDS) return { again: false, reason: `still ${tokens} but ${MAX_ROUNDS} extra rounds already spent` }
  if (previousTokens !== null && previousTokens > 0) {
    const reduction = (previousTokens - tokens) / previousTokens
    if (reduction < MIN_REDUCTION) {
      return { again: false, reason: `the last round barely moved it (${previousTokens} -> ${tokens}), another one will not either` }
    }
  }
  return { again: true, reason: `still ${tokens} >= ${thresholdTokens}, compacting again` }
}

// ---- Runner -----------------------------------------------------------------

const SETTLE_POLL_MS = 10_000
const SETTLE_TIMEOUT_MS = 150_000

export interface FollowUpDeps {
  /** Live context size for the agent, or null when unmeasurable. */
  readTokens: () => number | null
  /** The agent's configured threshold. */
  thresholdTokens: () => number
  /** Send another /compact. Resolves false when the agent was busy. */
  sendCompact: () => Promise<boolean>
  /** Test seam: wait. */
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

const running = new Set<string>()

/**
 * Watch a manual compaction to completion and top it up if it did not get the
 * agent under its threshold. Fire-and-forget; never throws into the caller.
 */
export async function followUpManualCompaction(agent: string, deps: FollowUpDeps): Promise<void> {
  if (running.has(agent)) return          // one watcher per agent is plenty
  running.add(agent)
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))
  const now = deps.now ?? Date.now
  try {
    for (let round = 0; ; round++) {
      // Wait for the round we just sent to land: the mark clears when the
      // context measurably shrank, or expires on its own.
      const deadline = now() + SETTLE_TIMEOUT_MS
      while (isCompactionInFlight(agent, now()) && now() < deadline) {
        await sleep(SETTLE_POLL_MS)
        settleCompaction(agent, deps.readTokens(), now())
      }
      const previousTokens = round === 0 ? null : lastSeen.get(agent) ?? null
      const tokens = deps.readTokens()
      lastSeen.set(agent, tokens ?? 0)
      const decision = decideFollowUp({ tokens, thresholdTokens: deps.thresholdTokens(), round, previousTokens })
      logger.info({ agent, tokens, round, again: decision.again, why: decision.reason },
        'manual-compact follow-up decision')
      if (!decision.again) return
      const sent = await deps.sendCompact()
      if (!sent) { logger.info({ agent }, 'manual-compact follow-up: agent busy, leaving it to the gate'); return }
      markCompactionStarted(agent, tokens, now())
    }
  } catch (err) {
    logger.warn({ err, agent }, 'manual-compact follow-up failed')
  } finally {
    running.delete(agent)
    lastSeen.delete(agent)
  }
}

const lastSeen = new Map<string, number>()

/** Test seam. */
export function clearFollowUpState(): void { running.clear(); lastSeen.clear() }
