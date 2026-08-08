// Pure logic for the OpenRouter remaining-balance widget (Boss, 2026-08-08
// follow-up to kanban ef06b18d): "mennyi pénzem maradt" is the same question
// as the Claude plan usage % -- both answer "meddig dolgozhatok" -- so this
// reuses the exact same tierForPct thresholds (90%/95% used = caution/
// critical) applied to (total_usage / total_credits) instead of a plan
// usage_percentage. The I/O (GET https://openrouter.ai/api/v1/credits,
// which needs a management/provisioning key -- NOT the regular runtime key
// the fleet uses for completions) lives in
// src/web/routes/openrouter-overview.ts.

import { tierForPct, type RateLimitTier } from './rate-limit-status.js'

export interface OpenRouterCreditsSnapshot {
  totalCredits: number
  totalUsage: number
}

export interface OpenRouterCreditsView {
  totalCredits: number
  totalUsage: number
  remaining: number
  usedPct: number | null
  tier: RateLimitTier
}

/** Derives remaining balance + usage tier from OpenRouter's raw credits response. */
export function deriveOpenRouterCreditsView(snap: OpenRouterCreditsSnapshot): OpenRouterCreditsView {
  const remaining = snap.totalCredits - snap.totalUsage
  const usedPct = snap.totalCredits > 0 ? (snap.totalUsage / snap.totalCredits) * 100 : null
  return {
    totalCredits: snap.totalCredits,
    totalUsage: snap.totalUsage,
    remaining,
    usedPct,
    tier: tierForPct(usedPct),
  }
}
