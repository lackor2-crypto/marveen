// Real, provider-reported OpenRouter spend, per model.
//
// The OpenRouter page used to price every model from our own token_usage
// table. That estimate was wrong by an order of magnitude and Boss caught it
// against OpenRouter's own dashboard (2026-08-10): we showed ~$0.7772 for
// openai/gpt-5.6-sol over a week where OpenRouter billed $7.22. Our row for
// that model claimed 306 input tokens across 102 calls, which is impossible --
// the local counters miss cached and reasoning tokens, and anything a provider
// bills that never lands in a token_usage row at all.
//
// GET /api/v1/activity is the authority: daily rows, per model, with the USD
// OpenRouter actually charged. It needs a MANAGEMENT key (the fleet inference
// key gets 403) and only covers COMPLETED UTC days, so today is never in it --
// today still comes from the key endpoint's usage_daily. This module is the
// pure aggregation half; the fetch lives in web/routes/openrouter-overview.ts.

/** One daily, per-model row as returned by GET /api/v1/activity. */
export interface OpenRouterActivityRow {
  /** "YYYY-MM-DD 00:00:00", the UTC day the usage falls in. */
  date: string
  /** Stable model id ("openai/gpt-5.6-sol"). Prefer this over model_permaslug,
   *  which carries a dated suffix that will not match anything we store. */
  model?: string
  model_permaslug?: string
  /** USD actually billed for this model on this day. */
  usage?: number
  requests?: number
  prompt_tokens?: number
  completion_tokens?: number
  reasoning_tokens?: number
}

export interface ModelSpend {
  cost: number
  requests: number
  tokensIn: number
  tokensOut: number
  reasoningTokens: number
}

/** Parse an activity row's UTC day to epoch seconds, or null if unparseable. */
export function activityRowEpoch(date: string): number | null {
  // "2026-08-09 00:00:00" -- explicitly UTC, so do not let the host timezone
  // shift a row into the neighbouring day when the period boundary is close.
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(date)
  if (!m) return null
  return Math.floor(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 1000)
}

/**
 * Sum activity rows per model over everything at or after `sinceEpochSec`.
 * Rows are daily, so a period boundary mid-day includes that whole UTC day --
 * erring towards showing more real spend rather than silently dropping it.
 */
export function aggregateActivityByModel(
  rows: OpenRouterActivityRow[],
  sinceEpochSec: number,
): Map<string, ModelSpend> {
  const out = new Map<string, ModelSpend>()
  for (const row of rows) {
    const day = activityRowEpoch(row.date ?? '')
    if (day === null || day < sinceEpochSec) continue
    const model = row.model ?? row.model_permaslug
    if (!model) continue
    const prev = out.get(model) ?? { cost: 0, requests: 0, tokensIn: 0, tokensOut: 0, reasoningTokens: 0 }
    out.set(model, {
      cost: prev.cost + (row.usage ?? 0),
      requests: prev.requests + (row.requests ?? 0),
      tokensIn: prev.tokensIn + (row.prompt_tokens ?? 0),
      tokensOut: prev.tokensOut + (row.completion_tokens ?? 0),
      reasoningTokens: prev.reasoningTokens + (row.reasoning_tokens ?? 0),
    })
  }
  return out
}

/** Total real spend across every model in the aggregate. */
export function totalSpend(byModel: Map<string, ModelSpend>): number {
  let sum = 0
  for (const v of byModel.values()) sum += v.cost
  return sum
}
