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
// This module owns the ACCOUNT-WIDE budget as process-wide state; the single
// call site that spends it is the message router's delivery loop
// (src/web/message-router.ts) -- see the window section at the bottom.

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

/** True when `model` shares OpenRouter's free-tier rate-limit pool. */
export function isFreeOpenRouterModel(model: string | null | undefined): boolean {
  if (typeof model !== 'string') return false
  return model.toLowerCase().endsWith(':free')
}

// ---- the shared, account-wide window ---------------------------------------
//
// The first version of this module only spaced out ONE batch: the caller kept
// the previous dispatch time in a local variable and slept between its own
// sends. That is not an account-level limiter, and a verification pass caught
// it (2026-08-10): two rounds started seconds apart each stayed under their own
// pace and together doubled the real request rate, right back over the shared
// ceiling. Anything that is per-call-site has the same hole -- the budget is
// per ACCOUNT, so the state that guards it has to be per PROCESS.
//
// Hence one window, consulted by every dispatch path. The paths do not consult
// it individually: they all enqueue through createAgentMessage, and the message
// router's delivery loop is the single choke point where a prompt actually
// reaches an agent's session. Gating there covers POST /api/approvals/:id/verify,
// the kanban in_progress dispatch, POST /api/messages and the schedule runner at
// once, and it needs no sleeping inside a request handler: a message that cannot
// get a slot right now just stays pending and is retried on the next 5s tick.

/** Rolling window length the RPM limit is measured over. */
export const FREE_WINDOW_MS = 60_000

// Dispatch timestamps inside the current rolling minute, oldest first. Callers
// pass a non-decreasing clock (Date.now() in production), which keeps this
// sorted and lets the prune below stop at the first live entry.
const freeDispatchWindow: number[] = []

function pruneWindow(nowMs: number): void {
  const cutoff = nowMs - FREE_WINDOW_MS
  let expired = 0
  while (expired < freeDispatchWindow.length && freeDispatchWindow[expired] <= cutoff) expired++
  if (expired > 0) freeDispatchWindow.splice(0, expired)
}

/**
 * 'interactive' is a human waiting on the other end of a channel message. It
 * still spends from the same budget -- the ceiling is the whole point -- but it
 * skips the anti-burst spacing, so a fleet fan-out in progress cannot make a
 * person wait out the queue behind it.
 */
export type DispatchPriority = 'normal' | 'interactive'

/**
 * Take one slot from the account-wide free-tier budget, or report that none is
 * available right now. Synchronous and side-effecting by design: the caller
 * must have decided it is dispatching, because a granted slot is spent.
 */
export function tryConsumeFreeDispatchSlot(nowMs: number = Date.now(), priority: DispatchPriority = 'normal'): boolean {
  pruneWindow(nowMs)
  // The account-level guarantee: never more than this many in any rolling
  // minute, no matter who is asking or how many fan-outs overlap.
  if (freeDispatchWindow.length >= EFFECTIVE_FREE_MODEL_RPM) return false
  // Anti-burst smoothing. Without it a fan-out spends the whole minute's budget
  // in one second, which is exactly the shape that produced the simultaneous
  // 429s -- staying under the per-minute total is not enough on its own.
  if (priority === 'normal') {
    const last = freeDispatchWindow[freeDispatchWindow.length - 1]
    if (last !== undefined && nowMs - last < MIN_DISPATCH_SPACING_MS) return false
  }
  freeDispatchWindow.push(nowMs)
  return true
}

/** Dispatches recorded in the current rolling minute (diagnostics, tests). */
export function freeDispatchesInWindow(nowMs: number = Date.now()): number {
  pruneWindow(nowMs)
  return freeDispatchWindow.length
}

/** Test seam: forget every recorded dispatch. */
export function _resetFreeDispatchWindowForTest(): void {
  freeDispatchWindow.length = 0
}
