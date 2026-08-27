// Pure logic for the account rate-limit / usage-window guard (kanban ef06b18d).
//
// Motivation: Boss wants the main assistant to watch its own Claude plan
// usage window (the rolling 5-hour and 7-day limits) and behave differently
// as it fills up -- at 90% only small tasks, at 95% no programming at all,
// info/search only. The data comes from Claude Code's own statusLine stdin
// JSON (rate_limits.five_hour / seven_day, each with used_percentage and
// resets_at), captured by scripts/hooks/statusline.py on every CLI render
// tick. That capture is a local, zero-token-cost operation -- statusLine
// scripts never call the model -- which matters because Boss explicitly
// rejected a polling-based approach (a more frequent heartbeat) over token
// cost (2026-08-08).
//
// This module only turns a captured snapshot into a tier; the I/O (reading
// the snapshot file, writing it) lives in src/web/rate-limit-status-io.ts.

export type RateLimitTier = 'normal' | 'caution' | 'critical'

// Boss's own thresholds (2026-08-08 voice message): 90% -> small tasks only,
// 95% -> no programming, info/search only.
export const CAUTION_THRESHOLD_PCT = 90
export const CRITICAL_THRESHOLD_PCT = 95

// A snapshot older than this is presumed stale (agent idle/off since the
// last statusLine tick): the CLI only ticks while the pane is actually
// rendering, so a long-idle or crashed agent leaves a frozen, misleading pct
// behind. Wider than the guard's own cooldowns (see context-guard.ts) since
// statusLine ticks are naturally sparser than tool calls.
export const STALE_AFTER_MS = 30 * 60_000

export interface RateLimitWindow {
  /** 0..100, or null if Claude Code did not report this window (e.g. API-key auth, not a Pro/Max plan). */
  usedPct: number | null
  /** Epoch ms when this window resets, or null if unknown. */
  resetsAt: number | null
}

export interface RateLimitSnapshot {
  agent: string
  model: string | null
  contextPct: number | null
  fiveHour: RateLimitWindow | null
  sevenDay: RateLimitWindow | null
  /** Epoch ms when this snapshot was captured. */
  updatedAt: number
  /**
   * Epoch ms when the PERCENTAGES themselves last changed.
   *
   * Nem ugyanaz, mint az `updatedAt`. A statusline minden kepernyo-frissiteskor
   * ujrairja a fajlt, de a `rate_limits` blokk csak akkor van benne, amikor a
   * Claude tenylegesen jelentette -- ilyenkor a szkript MEGTARTJA az elozo
   * szamokat (kulonben "nincs adat" villogna egy csak eppen tetlen agensnel).
   * Tehat egy friss `updatedAt` melle tartozhat orak ota valtozatlan szazalek.
   *
   * A kulonbseget a statusline 2026-08-11 ota rogziti (`windowsUpdatedAt`), de
   * TS oldalon eddig senki nem olvasta -- ezert mutathatott a felulet friss
   * szamkent egy reges-regi merest (Boss, 2026-08-15: a VS Code 81%-ot irt, a
   * Marveen ugyanarra a fiokra 11%-ot).
   */
  measuredAt: number
}

/** Tier for a single 0..100 percentage. */
export function tierForPct(pct: number | null): RateLimitTier {
  if (pct === null || !Number.isFinite(pct)) return 'normal'
  if (pct >= CRITICAL_THRESHOLD_PCT) return 'critical'
  if (pct >= CAUTION_THRESHOLD_PCT) return 'caution'
  return 'normal'
}

/** Worse of two tiers ('critical' > 'caution' > 'normal'). */
export function worseTier(a: RateLimitTier, b: RateLimitTier): RateLimitTier {
  const rank: Record<RateLimitTier, number> = { normal: 0, caution: 1, critical: 2 }
  return rank[a] >= rank[b] ? a : b
}

/** Overall tier for a snapshot: the worse of the 5h and 7d windows. Missing windows (null pct) don't count. */
export function tierForSnapshot(snapshot: Pick<RateLimitSnapshot, 'fiveHour' | 'sevenDay'>): RateLimitTier {
  const fiveTier = tierForPct(snapshot.fiveHour?.usedPct ?? null)
  const sevenTier = tierForPct(snapshot.sevenDay?.usedPct ?? null)
  return worseTier(fiveTier, sevenTier)
}

/** True when the snapshot is old enough that its percentages should not be trusted. */
export function isStale(updatedAt: number, nowMs: number, staleAfterMs: number = STALE_AFTER_MS): boolean {
  return nowMs - updatedAt >= staleAfterMs
}

/**
 * True when the account's own usage windows say it is fully out of quota and
 * the exhausted window has NOT yet reset. This is a DURABLE signal that
 * survives a pane restart, unlike the transient "You've hit your ... limit"
 * banner the CLI prints (paneShowsLimitBlock): the banner is gone the moment
 * the session is restarted, but the snapshot still knows the window is spent.
 *
 * Both windows count. Boss's WORK doctrine watches only the 5h window (the 7d
 * number is display-only for whether the agent should keep coding), but this
 * is a DISPLAY question -- "is it actually unable to work right now" -- and
 * Claude's own servers refuse a 7d-exhausted account regardless. So a 7d=100%
 * account really is stopped, and the label must say so.
 *
 * Why resetsAt is the authority, not `updatedAt` freshness: within a window
 * usedPct only ever grows until the reset, so a 100% reading stays true for as
 * long as resetsAt is in the future, however old the capture is. Once resetsAt
 * passes the window has rolled over and the account can work again -- so a
 * stale 100% with a past (or unknown) resetsAt is NOT treated as exhausted,
 * which is also what keeps this from lighting up on a freshly installed
 * Marveen that has never captured a snapshot (readRateLimitSnapshot -> null).
 */
export function snapshotShowsQuotaExhausted(
  snapshot: Pick<RateLimitSnapshot, 'fiveHour' | 'sevenDay'> | null,
  nowMs: number,
): boolean {
  if (!snapshot) return false
  const windowExhausted = (w: RateLimitWindow | null): boolean =>
    w != null && w.usedPct != null && w.usedPct >= 100 && w.resetsAt != null && w.resetsAt > nowMs
  return windowExhausted(snapshot.fiveHour) || windowExhausted(snapshot.sevenDay)
}
