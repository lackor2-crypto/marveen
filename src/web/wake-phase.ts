// #799: the 5-hour frame has a "wake phase": the first minutes after a window opens (limit reset, first use
// after an idle stretch). Measured 2026-10-25: the window that opened at 11:10 stood at 75% by 11:27, and the
// 5h frame has no brake of its own. Boss's rule: in that phase new automatic work may use at most
// WAKE_PHASE_CEILING_PCT of the frame; once it is reached, no NEW automatic work starts until the phase is over.
// Boss's own messages (Telegram, the Workbench chat) and the post-restart greeting are exempt -- the callers
// decide that, this module only answers "is the wake budget spent right now?".
//
// Pure decision + a thin reader over the history jsonl that live-usage-sampler writes every minute.
import { wakePhaseCeilingPct, wakePhaseMinutes } from '../config.js'
import { readUsageHistory, usageHistoryPath, type UsageHistorySample } from './usage-history.js'

export const FIVE_HOUR_MS = 5 * 3_600_000
/** A reading older than this says nothing about now (no live credential, sampler down): never block on it. */
export const WAKE_PHASE_STALE_MS = 15 * 60_000

export interface WakePhaseConfig {
  /** Percent of the 5h frame new automatic work may use inside the phase. 0 = the guard is off. */
  ceilingPct: number
  /** How long after the window opened the phase lasts. 0 = the guard is off. */
  phaseMinutes: number
}

export type WakePhaseReason =
  | 'off'
  | 'no-data'
  | 'stale'
  | 'no-window'
  | 'phase-over'
  | 'under-ceiling'
  | 'ceiling-reached'

export interface WakePhaseState {
  /** True while new automatic work must wait. */
  blocked: boolean
  reason: WakePhaseReason
  /** When the current window opened (epoch ms), when known. */
  openedAt: number | null
  /** 5h percent used so far in this window (the window starts at 0), when known. */
  usedPct: number | null
  /** When the phase ends (epoch ms), when a phase is running. */
  phaseEndsAt: number | null
}

const NOT_BLOCKED = (reason: WakePhaseReason, extra: Partial<WakePhaseState> = {}): WakePhaseState =>
  ({ blocked: false, reason, openedAt: null, usedPct: null, phaseEndsAt: null, ...extra })

export function wakePhaseState(history: UsageHistorySample[], now: number, cfg: WakePhaseConfig): WakePhaseState {
  if (!(cfg.ceilingPct > 0) || !(cfg.phaseMinutes > 0)) return NOT_BLOCKED('off')
  const last = history[history.length - 1]
  if (!last) return NOT_BLOCKED('no-data')
  // Unknown is not "spent": a stale or missing reading must never freeze work (fail open).
  if (now - last.t > WAKE_PHASE_STALE_MS) return NOT_BLOCKED('stale')
  if (last.fiveHourResetsAt === null || last.fiveHourPct === null) return NOT_BLOCKED('no-window')
  const openedAt = last.fiveHourResetsAt - FIVE_HOUR_MS
  const phaseEndsAt = openedAt + cfg.phaseMinutes * 60_000
  const base = { openedAt, usedPct: last.fiveHourPct, phaseEndsAt }
  if (now >= phaseEndsAt) return NOT_BLOCKED('phase-over', base)
  if (last.fiveHourPct >= cfg.ceilingPct) return { blocked: true, reason: 'ceiling-reached', ...base }
  return NOT_BLOCKED('under-ceiling', base)
}

/** The task origins that are Boss's own words, never held by the wake phase. */
export const WAKE_EXEMPT_ORIGINS: ReadonlySet<string> = new Set(['telegram', 'workbench'])

export function wakePhaseHoldsOrigin(origin: string, state: WakePhaseState): boolean {
  return state.blocked && !WAKE_EXEMPT_ORIGINS.has(origin)
}

// --- I/O side ---------------------------------------------------------------------------------------------
let provider: ((now: number) => WakePhaseState) | null = null
/** Test hook: replace (or with null restore) the reader. */
export function setWakePhaseProviderForTest(p: ((now: number) => WakePhaseState) | null): void { provider = p }

let memo: { at: number; agentId: string; state: WakePhaseState } | null = null
const MEMO_MS = 15_000

export function currentWakePhase(agentId: string, now: number = Date.now()): WakePhaseState {
  if (provider) return provider(now)
  if (memo && memo.agentId === agentId && Math.abs(now - memo.at) < MEMO_MS) return memo.state
  let state: WakePhaseState
  try {
    state = wakePhaseState(readUsageHistory(usageHistoryPath(agentId)), now, {
      ceilingPct: wakePhaseCeilingPct(),
      phaseMinutes: wakePhaseMinutes(),
    })
  } catch {
    state = NOT_BLOCKED('no-data')
  }
  memo = { at: now, agentId, state }
  return state
}
