// Which agents are in the middle of a /compact, right now.
//
// Boss, 2026-08-12, watching his own card while the gate compacted the session:
// "latom compacting van. csinalod is. de miert nem zold a kartyadon a terminal
// gomb ilyenkor? hiszen dolgozol!!!" He was right. The Activity feed derives
// "working" from the tmux pane, and the compaction spinner carries none of the
// busy signals a normal turn does (no token counter, no interrupt footer), so a
// session that was demonstrably busy for over a minute read as idle.
//
// Guessing at the compaction spinner's text would be the wrong fix: a line that
// stays rendered in the scrollback after the turn ends is exactly what pinned a
// session "busy" forever once before (94 consecutive scheduler retries), and
// this repo pays for that class of mistake with a stalled fleet.
//
// We do not have to guess. The dashboard SENDS the /compact -- from the gate or
// from the card's button -- so it knows the moment one starts. This module is
// that knowledge, deliberately time-boxed so a crash or a refused compaction can
// never leave an agent pinned:
//
//   - it expires on its own after MAX_COMPACTION_MS,
//   - it clears as soon as the context measurably shrank (the compaction landed).
//
// A compaction the OWNER types into the pane himself is not covered here; that
// one shows up (or does not) purely through pane state, unchanged.
const MAX_COMPACTION_MS = 120_000

interface Mark { startedAt: number; tokensAtStart: number | null }

const marks = new Map<string, Mark>()

export function markCompactionStarted(agent: string, tokensAtStart: number | null, nowMs = Date.now()): void {
  marks.set(agent, { startedAt: nowMs, tokensAtStart })
}

/** True when a compaction was started for this agent and has not been observed
 *  to finish. Cheap: no I/O. Callers that can measure the live context should
 *  follow up with settleCompaction() so the mark clears the moment it lands. */
export function isCompactionInFlight(agent: string, nowMs = Date.now()): boolean {
  const mark = marks.get(agent)
  if (!mark) return false
  if (nowMs - mark.startedAt >= MAX_COMPACTION_MS) { marks.delete(agent); return false }
  return true
}

/**
 * Report the live context size for an agent with a mark. A measurably smaller
 * context means the compaction finished, so the mark clears and this returns
 * false -- that transition is what lets the dashboard refresh the card the
 * instant the new (smaller) number exists, instead of at the next poll.
 *
 * A null reading (a quota-limited agent, an unreadable transcript) is not
 * evidence of anything, so the mark stands until it expires.
 */
export function settleCompaction(agent: string, currentTokens: number | null, nowMs = Date.now()): boolean {
  const mark = marks.get(agent)
  if (!mark) return false
  if (nowMs - mark.startedAt >= MAX_COMPACTION_MS) { marks.delete(agent); return false }
  if (currentTokens !== null && mark.tokensAtStart !== null && currentTokens < mark.tokensAtStart) {
    marks.delete(agent)
    return false
  }
  return true
}

/** Test seam. */
export function clearCompactionMarks(): void { marks.clear() }
