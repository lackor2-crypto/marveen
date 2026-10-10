// #543 (owner, 2026-10-10): "why pester the account while it is dead? ... no such message until it is online
// again." The menu watcher reported an agent whose quota had run out as "stuck in an interactive menu" and even
// sent an Escape to its panel. An agent that is PROVEN unavailable is left alone: no alert, no keystroke.
//
// Pure on purpose (no clock, no store), like availability-transitions.ts, so the rule is testable.
import type { AgentAvailability } from './availability-transitions.js'

export type QuietVerdict =
  | { quiet: false }
  | { quiet: true; reason: 'quota' | 'stopped'; resetsAt: number | null }

/**
 * Should the watchers stay silent about this agent right now?
 *
 * Silent ONLY when a fresh measurement says the agent cannot work. No row, an old row, or an empty agent name all
 * mean "I cannot see" -- and that is not the same as "it is unavailable", so the watcher behaves as before.
 */
export function quietForUnavailable(rows: AgentAvailability[], agent: string, now: number, maxAgeMs: number): QuietVerdict {
  const name = String(agent || '').trim()
  if (!name) return { quiet: false }
  const row = rows.find((r) => r.agent === name)
  if (!row || row.available !== false) return { quiet: false }
  if (row.reason !== 'quota' && row.reason !== 'stopped') return { quiet: false }
  if (!Number.isFinite(row.measuredAt) || now - row.measuredAt > maxAgeMs || now < row.measuredAt - maxAgeMs) return { quiet: false }
  return { quiet: true, reason: row.reason, resetsAt: row.resetsAt ?? null }
}
