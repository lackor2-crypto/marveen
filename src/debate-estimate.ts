import { isFlatRate } from './debate-claude-cli.js'
// Cost estimate of a debate round (#597, phase 4), shown BEFORE the owner presses the button.
//
// It is an estimate and says so: the input is counted from the text that will be sent (about 3.5 characters a
// token), the output from what the same model wrote in earlier rounds (else a fixed guess), and the price is
// OpenRouter's list price per model. A model without a known price is named, never counted as free.

export interface ModelPrice { promptPrice: number; completionPrice: number } // USD per 1M tokens

export const CHARS_PER_TOKEN = 3.5
/** What a model is assumed to write when we have not seen it write in this debate. */
export const DEFAULT_OUT_TOKENS = 1800
/** What the closing write-up is assumed to cost in output. */
export const CONCLUDE_OUT_TOKENS = 900

export function approxTokens(chars: number): number {
  return Math.max(0, Math.ceil(chars / CHARS_PER_TOKEN))
}

export interface EstimateCall {
  model: string
  /** Characters sent in this call: the system prompt and the user message. */
  chars: number
  /** Output tokens seen from this model in earlier rounds (average), or null. */
  seenOut: number | null
}

export interface CallEstimate { model: string; tokensIn: number; tokensOut: number; usd: number | null }

export interface Estimate {
  calls: CallEstimate[]
  /** The sum over the calls whose price is known. */
  usd: number
  /** Models with no known price: the sum above does not include them. */
  unpriced: string[]
  /** Models that use the paid web-search plugin (":online"): its fee comes on top. */
  webSearch: string[]
  /** True when every call is on a free model. */
  free: boolean
}

function baseModel(spec: string): string {
  return spec.endsWith(':online') ? spec.slice(0, -':online'.length) : spec
}

/** A subscription, Z.ai plan or local model costs nothing per token. */
const FLAT_PRICE: ModelPrice = { promptPrice: 0, completionPrice: 0 } as ModelPrice

export function estimateCalls(calls: readonly EstimateCall[], prices: ReadonlyMap<string, ModelPrice>): Estimate {
  const out: CallEstimate[] = []
  const unpriced = new Set<string>()
  const web = new Set<string>()
  let usd = 0
  let free = calls.length > 0
  for (const c of calls) {
    const tokensIn = approxTokens(c.chars)
    const tokensOut = c.seenOut && c.seenOut > 0 ? Math.round(c.seenOut) : DEFAULT_OUT_TOKENS
    const price = isFlatRate(c.model) ? FLAT_PRICE : prices.get(baseModel(c.model))
    if (c.model.endsWith(':online')) web.add(c.model)
    let cost: number | null = null
    if (price) {
      cost = (tokensIn * price.promptPrice + tokensOut * price.completionPrice) / 1_000_000
      usd += cost
      if (cost > 0) free = false
    } else {
      unpriced.add(c.model)
      free = false
    }
    out.push({ model: c.model, tokensIn, tokensOut, usd: cost })
  }
  return { calls: out, usd, unpriced: [...unpriced], webSearch: [...web], free }
}
