import type { AgentAvailability } from '../availability-transitions.js'

// #545: an account whose 5-hour window is spent must still say WHEN it comes back. The live usage API (and the
// agent's own snapshot) can come back with an empty 5-hour window exactly then, so the Overview row lost its reset
// time while the availability watcher still knew it (usalackor, 2026-10-10: available=false, reason=quota,
// resetsAt 16:20). The watcher's `resetsAt` is the reset of the window that BLOCKS the agent, so it only stands for
// the 5-hour row when the weekly window is not the one that matches it.

export interface AccountWindows {
  fiveHourPct: number | null
  fiveHourResetsAt: number | null
  sevenDayPct: number | null
  sevenDayResetsAt: number | null
}

export interface FiveHourFill<T extends AccountWindows> {
  account: T
  /** True when the 5-hour numbers came from the availability watcher, not from the usage reading. */
  filled: boolean
}

/** Resets of one and the same window differ by seconds between sources; two minutes is far above that. */
const SAME_RESET_MS = 2 * 60_000

export function fillFiveHourFromAvailability<T extends AccountWindows>(
  account: T,
  availability: AgentAvailability | undefined,
  now: number = Date.now(),
): FiveHourFill<T> {
  const missing = account.fiveHourResetsAt == null || account.fiveHourResetsAt <= now || account.fiveHourPct == null
  if (!missing || !availability) return { account, filled: false }
  if (availability.reason !== 'quota' || availability.resetsAt == null || availability.resetsAt <= now) return { account, filled: false }
  // The blocking window is the weekly one: the 5-hour reset is not known from here, and saying so beats guessing.
  if (account.sevenDayResetsAt != null && Math.abs(account.sevenDayResetsAt - availability.resetsAt) < SAME_RESET_MS) {
    return { account, filled: false }
  }
  return {
    account: { ...account, fiveHourPct: account.fiveHourPct ?? 100, fiveHourResetsAt: availability.resetsAt },
    filled: true,
  }
}
