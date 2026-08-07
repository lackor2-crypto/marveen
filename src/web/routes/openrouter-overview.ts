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
// usage/cost has happened today", computed by joining the existing token-
// usage table (already recording every model Claude Code CLI ran, including
// OpenRouter-routed sub-agent calls) against live OpenRouter pricing --
// no new usage-tracking table needed.

import { getModelDistribution } from '../token-usage.js'
import { fetchAllOpenRouterModels } from '../openrouter-models.js'
import { getSecret } from '../vault.js'
import { json } from '../http-helpers.js'
import { logger } from '../../logger.js'
import type { RouteContext } from './types.js'

function startOfTodayEpoch(): number {
  const now = new Date()
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  return Math.floor(start.getTime() / 1000)
}

export async function tryHandleOpenRouterOverview(ctx: RouteContext): Promise<boolean> {
  const { res, path, method } = ctx

  if (path === '/api/openrouter/overview' && method === 'GET') {
    try {
      const configured = getSecret('openrouter-fleet-key') !== null

      // OpenRouter model ids are always "provider/model" (same discriminator
      // agent-process.ts uses to route to the OpenRouter env branch); plain
      // Claude/DeepSeek/Ollama ids never contain '/', so this cleanly isolates
      // OpenRouter-routed rows out of the shared token_usage table.
      const dist = getModelDistribution(startOfTodayEpoch()).filter(d => d.model.includes('/'))

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
      let todayEstCost = 0
      let anyCostKnown = false
      const models = dist.map(d => {
        const price = priceByModel.get(d.model)
        const estCost = price ? (d.totalInput / 1_000_000) * price.promptPrice + (d.totalOutput / 1_000_000) * price.completionPrice : null
        todayTokensIn += d.totalInput
        todayTokensOut += d.totalOutput
        if (estCost !== null) { todayEstCost += estCost; anyCostKnown = true }
        return { model: d.model, calls: d.count, tokensIn: d.totalInput, tokensOut: d.totalOutput, estCost }
      })

      json(res, {
        configured,
        todayTokensIn,
        todayTokensOut,
        todayEstCost: anyCostKnown ? todayEstCost : null,
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
