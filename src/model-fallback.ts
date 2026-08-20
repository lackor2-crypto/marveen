// Pure logic for the model-fallback-on-limit feature.
//
// Motivation: when an agent's Claude plan usage limit is reached, the Claude
// Code session pauses and prints a usage-limit banner in its tmux pane. Until
// the window resets (or the user intervenes) the agent is deaf. This feature
// detects that banner and downgrades the agent one step down a configured model
// chain (e.g. opus -> sonnet -> haiku), respawning the session so the cheaper
// model -- on a separate budget -- takes over without losing the conversation.
// After a revert window with no limit in sight, it climbs back to the primary.
//
// This module is dependency-free so every decision is unit-testable without a
// clock, tmux, or the filesystem. The I/O (capture-pane, model write, restart)
// lives in src/web/model-fallback-runner.ts; the config store lives in
// src/web/model-fallback-store.ts.

// Resolved full model IDs, mirroring MODEL_ALIASES in src/web/agent-config.ts.
// chain[0] is the primary (what we revert UP to); each subsequent entry is the
// next downgrade target. Kept as literals here to preserve the zero-import,
// trivially-testable property of this module.
export const DEFAULT_MODEL_CHAIN: readonly string[] = [
  'claude-opus-4-8[1m]',
  'claude-sonnet-5',
  'claude-haiku-4-5-20251001',
]

// Revert only well after the typical 5-hour plan window so we do not climb back
// to the primary just to re-trip the same limit. Configurable.
export const DEFAULT_REVERT_AFTER_MINUTES = 330

export interface ModelFallbackConfig {
  /** Master toggle. When false no agent is ever auto-switched. */
  enabled: boolean
  /** Primary-first model chain. Downgrades walk forward; revert goes to [0]. */
  chain: string[]
  /** Minutes a downgraded agent must stay limit-free before climbing back. */
  revertAfterMinutes: number
}

export const DEFAULT_MODEL_FALLBACK: ModelFallbackConfig = {
  enabled: false,
  chain: [...DEFAULT_MODEL_CHAIN],
  revertAfterMinutes: DEFAULT_REVERT_AFTER_MINUTES,
}

/** Coerce an untrusted parsed-JSON value into a valid config (defaults on junk). */
export function normalizeModelFallbackConfig(raw: unknown): ModelFallbackConfig {
  const o = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {}
  const enabled = o.enabled === true
  let chain = DEFAULT_MODEL_FALLBACK.chain
  if (Array.isArray(o.chain)) {
    const cleaned = o.chain.filter((m): m is string => typeof m === 'string' && m.trim().length > 0)
    // A chain needs at least a primary + one fallback to be meaningful.
    if (cleaned.length >= 2) chain = cleaned
  }
  let revertAfterMinutes = DEFAULT_MODEL_FALLBACK.revertAfterMinutes
  if (typeof o.revertAfterMinutes === 'number' && Number.isFinite(o.revertAfterMinutes) && o.revertAfterMinutes > 0) {
    revertAfterMinutes = Math.floor(o.revertAfterMinutes)
  }
  return { enabled, chain, revertAfterMinutes }
}

// The Claude Code usage-limit banner appears at the bottom of the pane (above
// the footer) when the plan budget is exhausted or nearly so. Match only the
// live banner region so a message body or scrollback that merely quotes the
// phrase does not trip a downgrade.
const USAGE_LIMIT_BANNER_REGION_LINES = 15

// Distinctive plan-limit phrasings. Deliberately NARROW: a generic "rate limit"
// / "API Error: 429" (transient overload, handled elsewhere) must NOT match --
// that is a momentary blip, not a plan-budget exhaustion that warrants a model
// switch.
//
// "hit your ... limit" names the WINDOW, not the word "usage": the live banner
// reads "You've hit your weekly limit - resets Aug 20, 8pm - progress saved".
// Matching only "hit your usage limit" left that phrasing to the incidental
// "/upgrade to increase your usage limit" hint line underneath -- which is not
// always rendered, so detection depended on a line the banner does not promise.
// Naming the windows keeps the pattern just as narrow (a 429 or a bare "rate
// limit" still does not match) while recognising the banner itself. Kept in
// sync with paneShowsLimitBlock() in pane-state.ts, which answers the same
// question for the Agents page's 'limited' label.
const USAGE_LIMIT_RX =
  /(usage limit reached|reached your usage limit|hit (?:your|the) (?:usage|weekly|session|\d+-hour) limit|approaching (?:your )?usage limit|usage limit (?:will )?reset|limit will reset at|\d+-hour limit reached|upgrade to increase your usage limit)/i

// The reset moment inside the banner: "resets Aug 20, 8pm (Europe/Budapest)",
// "reset at 9am". Bounded by the interpunct/pipe that separates the banner's
// segments, so trailing text ("progress saved") is not swallowed.
const USAGE_LIMIT_RESET_RX = /\breset(?:s)?(?:\s+at)?\s+([^·|\n]{2,48}?)\s*(?=[·|\n]|$)/i

/**
 * True when the live pane shows a Claude *plan usage-limit* banner (not a
 * transient API 429). Pure + dependency-free. Restricted to the bottom region
 * so quoted text in scrollback or a reply body cannot trigger it.
 */
export function detectsUsageLimit(pane: string): boolean {
  if (!pane || !pane.trim()) return false
  return USAGE_LIMIT_RX.test(usageLimitRegion(pane))
}

function usageLimitRegion(pane: string): string {
  return pane.split('\n').slice(-USAGE_LIMIT_BANNER_REGION_LINES).join('\n')
}

/**
 * When the pane shows a usage-limit banner that names its reset moment, that
 * moment verbatim ("Aug 20, 8pm (Europe/Budapest)"); null otherwise.
 *
 * Display only -- deliberately NOT parsed into a Date. The banner's wording and
 * timezone are Claude Code's to change, and a mis-parsed timestamp that drives a
 * decision is worse than no timestamp at all. Callers put the string in front of
 * a reader so "this session is waiting" can be told apart from "this session is
 * wedged" without opening the pane; that was the whole of the 2026-08-16
 * false alarm (see context-restart-gate.ts).
 */
export function usageLimitResetText(pane: string): string | null {
  if (!pane || !pane.trim()) return null
  const region = usageLimitRegion(pane)
  if (!USAGE_LIMIT_RX.test(region)) return null
  const m = USAGE_LIMIT_RESET_RX.exec(region)
  const text = m && m[1] ? m[1].trim() : ''
  return text ? text : null
}

/**
 * The next model one step down the chain from `current`, or null if already at
 * the bottom. An unrecognised current model is treated as the primary, so the
 * first downgrade target (chain[1]) applies.
 */
export function nextFallbackModel(current: string, chain: string[]): string | null {
  if (chain.length < 2) return null
  const idx = chain.indexOf(current)
  if (idx < 0) return chain[1] ?? null
  if (idx >= chain.length - 1) return null
  return chain[idx + 1]
}

export interface ModelFallbackFacts {
  /** Whether the agent's pane currently shows a usage-limit banner. */
  limitDetected: boolean
  /** The agent's current resolved model id. */
  currentModel: string
  /** Primary-first model chain. */
  chain: string[]
  /** When this agent was last downgraded (ms epoch), or null if on primary. */
  downgradedAt: number | null
  /** Current time (ms epoch). */
  now: number
  /** Revert window in ms. */
  revertAfterMs: number
}

export type ModelAction =
  | { kind: 'none' }
  | { kind: 'downgrade'; model: string }
  | { kind: 'revert'; model: string }

/**
 * Decide what to do for one agent. Pure: the runner gates the I/O (idle pane,
 * actual write+restart) separately.
 *
 *   - limit detected & a lower model exists -> downgrade to it.
 *   - limit detected & already at the bottom -> nothing (cannot go lower).
 *   - no limit & downgraded long enough ago -> revert to the primary (chain[0]).
 *   - otherwise -> nothing.
 */
export function decideModelAction(f: ModelFallbackFacts): ModelAction {
  if (f.limitDetected) {
    const next = nextFallbackModel(f.currentModel, f.chain)
    if (next && next !== f.currentModel) return { kind: 'downgrade', model: next }
    return { kind: 'none' }
  }
  if (f.downgradedAt !== null && f.now - f.downgradedAt >= f.revertAfterMs) {
    const primary = f.chain[0]
    if (primary && f.currentModel !== primary) return { kind: 'revert', model: primary }
  }
  return { kind: 'none' }
}
