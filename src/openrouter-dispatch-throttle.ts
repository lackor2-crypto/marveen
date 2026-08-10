// Pure logic for staggering multi-agent dispatch against OpenRouter's
// shared, ACCOUNT-WIDE free-model rate limit (kanban 45c3cfad).
//
// OpenRouter's ":free" models share a single 20-requests-per-minute budget
// across the WHOLE account -- not per model, not per agent (verified via
// OpenRouter's own docs, 2026-08-08). Dispatching a prompt to many free-tier
// agents in a tight loop (e.g. "Ellenőrzés indítása" fanning out to all 14
// fleet agents at once) makes them all call the model within the same few
// seconds, blowing through that shared budget -- observed live: several
// agents 429'd simultaneously during a 14-agent verification dispatch. A
// failed 429 request STILL counts against the daily quota too, so the
// bursting is pure waste on top of the immediate failure.
//
// This module only computes delays; the I/O (actually sleeping between
// dispatch calls) lives at the call site in src/web/routes/approvals.ts.

/** Requests per minute OpenRouter allows for :free models, account-wide. */
export const FREE_MODEL_RPM_LIMIT = 20

// Deliberately below the hard 20 RPM ceiling: dispatch timing (when we queue
// the prompt) isn't exactly when the agent's own turn calls the model --
// there's some jitter from tmux injection, the agent reading its prompt,
// thinking before the first tool/model call, etc. A safety margin keeps a
// realistic dispatch pattern from still clipping the true limit.
export const FREE_MODEL_RPM_SAFETY_MARGIN = 5
export const EFFECTIVE_FREE_MODEL_RPM = FREE_MODEL_RPM_LIMIT - FREE_MODEL_RPM_SAFETY_MARGIN

/** Minimum spacing (ms) between successive free-tier dispatches to stay under the effective RPM. */
export const MIN_DISPATCH_SPACING_MS = Math.ceil(60_000 / EFFECTIVE_FREE_MODEL_RPM)

/**
 * Given the dispatch time of the previous free-tier agent in this batch (or
 * null for the first one), how many ms to wait before dispatching the next
 * one. Pure function of (previous dispatch time, now) -- no clock reads
 * inside, so it's trivially testable.
 */
export function throttleDelayMs(previousDispatchAtMs: number | null, nowMs: number): number {
  if (previousDispatchAtMs === null) return 0
  const elapsed = nowMs - previousDispatchAtMs
  return Math.max(0, MIN_DISPATCH_SPACING_MS - elapsed)
}

/** True when `model` shares OpenRouter's free-tier rate-limit pool. */
export function isFreeOpenRouterModel(model: string | null | undefined): boolean {
  if (typeof model !== 'string') return false
  return model.toLowerCase().endsWith(':free')
}
