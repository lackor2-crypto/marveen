// Consolidated OpenRouter status for its own dashboard page (Boss, 2026-08-07:
// wants an "API-based admin surface" for OpenRouter -- not an iframe of
// openrouter.ai's own site, a Marveen-native view built from data Marveen
// already has). Deliberately does NOT duplicate existing infrastructure:
// - Model catalog + pricing + free-model search: already served by
//   GET /api/openrouter/models (routes/agents.ts) and rendered by the
//   existing openOpenrouterModal() browse popup in web/app.js -- this route
//   does not re-fetch or re-render that, the page just opens the same modal.
// - API key state + editing: already the Vault page (generic secret store).
// This route adds the ONE genuinely missing piece: "how much OpenRouter
// usage/cost has happened today".
//
// The cost total is NOT derived from the token_usage table (Boss, 2026-08-08:
// caught this understating real spend by ~10x -- $0.84 shown vs $7.81 actual
// after a round of Gypsy usage in "high effort"/deep-reasoning mode). Root
// cause: OpenRouter exposes an ANTHROPIC-COMPATIBLE endpoint, and Claude
// Code's own transcript only records the translated usage.output_tokens
// count -- for a reasoning model this does not include the (still-billed)
// reasoning/thinking tokens, so any price-per-token estimate built from that
// count silently undercounts. There is no local number that can be trusted
// for cost, so todayEstCost is now read directly from OpenRouter's own
// account API (GET /v1/key -> usage_daily), which is the actual amount
// charged -- the one place this can't be wrong. The per-model token/call
// breakdown below stays token_usage-derived (still fine for "which model got
// used how often"), it just no longer drives the headline cost number.

import { getModelDistribution } from '../token-usage.js'
import { fetchAllOpenRouterModels } from '../openrouter-models.js'
import { getSecret } from '../vault.js'
import { json } from '../http-helpers.js'
import { logger } from '../../logger.js'
import type { RouteContext } from './types.js'

interface OpenRouterKeyInfo {
  usage_daily?: number
}

// GET /v1/key returns the calling key's own real usage, billed-dollar-accurate
// (it is OpenRouter's own account ledger, not a client-side estimate).
export async function fetchRealDailyCostUSD(apiKey: string): Promise<number | null> {
  try {
    const resp = await fetch('https://openrouter.ai/api/v1/key', {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    if (!resp.ok) return null
    const data = await resp.json() as { data?: OpenRouterKeyInfo }
    const v = data.data?.usage_daily
    return typeof v === 'number' ? v : null
  } catch (err) {
    logger.warn({ err }, 'openrouter overview: real key-usage fetch failed')
    return null
  }
}

// GET /v1/credits returns the ACCOUNT-WIDE remaining balance (total_credits
// minus total_usage) -- distinct from GET /v1/key above, which only reports
// a single key's own usage/limit. OpenRouter requires a management/
// provisioning key for this endpoint (Boss confirmed live, 2026-08-08): the
// regular runtime key the fleet uses for completions returns limit=null
// here and cannot answer "how much money is left". Optional -- if no
// management key is in the vault, the overview route just omits this field.
export async function fetchOpenRouterCredits(managementKey: string): Promise<{ totalCredits: number; totalUsage: number } | null> {
  try {
    const resp = await fetch('https://openrouter.ai/api/v1/credits', {
      headers: { Authorization: `Bearer ${managementKey}` },
    })
    if (!resp.ok) return null
    const data = await resp.json() as { data?: { total_credits?: number; total_usage?: number } }
    const totalCredits = data.data?.total_credits
    const totalUsage = data.data?.total_usage
    if (typeof totalCredits !== 'number' || typeof totalUsage !== 'number') return null
    return { totalCredits, totalUsage }
  } catch (err) {
    logger.warn({ err }, 'openrouter overview: credits fetch failed')
    return null
  }
}

// UTC, not local midnight (Boss, 2026-08-08): OpenRouter's own usage_daily
// (fetched below) resets at UTC midnight. Filtering the local per-model
// breakdown on a LOCAL "today" boundary meant the two numbers disagreed
// about which rows even count as "today" -- a debate round that ran after
// local midnight-minus-N-hours but before UTC midnight showed up in
// OpenRouter's real total but silently dropped out of the per-model list
// (or vice versa), which read as "some of the spend just isn't shown
// anywhere". Matching the boundary OpenRouter itself uses keeps the two
// numbers describing the same window.
function startOfTodayEpoch(): number {
  const now = new Date()
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  return Math.floor(start / 1000)
}

// Boss 2026-08-10: "csinaljunk mar ide heti havi eves nezetet is". A lap eddig
// csak a MAI forgalmat mutatta, ezert egy agens korabbi koltese (pl. Gypsy 10
// dollarja) sehol nem latszott -- a kerdesre, hogy "mennyit koltottem eddig
// erre", a lap nem tudott valaszolni. A periodus a lekerdezes kezdo-idopontjat
// tolja vissza; az alapertelmezes tovabbra is 'today', tehat aki parameter
// nelkul hivja, ugyanazt kapja mint eddig.
const PERIOD_DAYS: Record<string, number> = { today: 0, '7d': 7, '30d': 30, '365d': 365 }

function periodStartEpoch(period: string): number {
  const days = PERIOD_DAYS[period] ?? 0
  if (days === 0) return startOfTodayEpoch()
  // Egesz napokra visszafele: a mai nap kezdete minusz N nap, igy a hatar nem
  // csuszik el a futtatas oraja szerint.
  return startOfTodayEpoch() - days * 86_400
}

export async function tryHandleOpenRouterOverview(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx

  if (path === '/api/openrouter/overview' && method === 'GET') {
    try {
      const apiKey = getSecret('openrouter-fleet-key')
      const configured = apiKey !== null

      // OpenRouter model ids are always "provider/model" (same discriminator
      // agent-process.ts uses to route to the OpenRouter env branch); plain
      // Claude/DeepSeek/Ollama ids never contain '/', so this cleanly isolates
      // OpenRouter-routed rows out of the shared token_usage table.
      const period = new URL(req.url ?? '/', 'http://x').searchParams.get('period') ?? 'today'
      const validPeriod = period in PERIOD_DAYS ? period : 'today'
      const dist = getModelDistribution(periodStartEpoch(validPeriod)).filter(d => d.model.includes('/'))

      const priceByModel = new Map<string, { promptPrice: number, completionPrice: number }>()
      let priceLookupFailed = false
      if (configured && dist.length) {
        try {
          const all = await fetchAllOpenRouterModels(Date.now())
          for (const m of all) priceByModel.set(m.id, { promptPrice: m.promptPrice, completionPrice: m.completionPrice })
        } catch (err) {
          logger.warn({ err }, 'openrouter overview: price fetch failed, cost will show as unavailable')
          priceLookupFailed = true
        }
      }

      let todayTokensIn = 0
      let todayTokensOut = 0
      // Per-model estCost is still token_usage-derived -- fine for relative
      // "which model got used how much" volume, but see the header comment:
      // it undercounts reasoning models, so it is NOT summed into the
      // headline todayEstCost below.
      const models = dist.map(d => {
        const price = priceByModel.get(d.model)
        const estCost = price ? (d.totalInput / 1_000_000) * price.promptPrice + (d.totalOutput / 1_000_000) * price.completionPrice : null
        todayTokensIn += d.totalInput
        todayTokensOut += d.totalOutput
        return { model: d.model, calls: d.count, tokensIn: d.totalInput, tokensOut: d.totalOutput, estCost }
      })

      // Az OpenRouter fiok-API-ja a MAI koltseget adja vissza -- hosszabb
      // idoszakra nincs ilyen hiteles szam, ezert ott a token-alapu becslest
      // adjuk, es a costSource meg is mondja melyikrol van szo. Egy mai
      // szamot "30 napos koltseg" cimke alatt mutatni rosszabb lenne, mint
      // vallalni hogy ez becsles.
      const isToday = validPeriod === 'today'
      const realDailyCost = isToday && configured ? await fetchRealDailyCostUSD(apiKey) : null
      if (isToday && configured && realDailyCost === null) priceLookupFailed = true
      const estTotal = models.reduce((sum, m) => sum + (m.estCost ?? 0), 0)

      json(res, {
        configured,
        period: validPeriod,
        todayTokensIn,
        todayTokensOut,
        todayEstCost: isToday ? realDailyCost : (models.some(m => m.estCost !== null) ? estTotal : null),
        costSource: isToday ? 'openrouter_account' : 'token_estimate',
        priceLookupFailed,
        models,
      })
    } catch (err) {
      logger.error({ err }, 'openrouter overview failed')
      json(res, { error: 'Failed to load OpenRouter overview' }, 500)
    }
    return true
  }

  return false
}
