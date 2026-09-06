import {
  collectTokenUsage,
  getTokenSummary,
  getTokenTimeline,
  getTokenDetails,
  getModelDistribution,
  getToolStats,
  correlateWithKanban,
  getContextUsage,
  exportContextUsageMarkdown,
} from '../token-usage.js'
import { json, jsonMaybeGzip } from '../http-helpers.js'
import { logger } from '../../logger.js'
import type { RouteContext } from './types.js'

export async function tryHandleTokenUsage(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx

  if (path === '/api/token-usage/collect' && method === 'POST') {
    try {
      const result = await collectTokenUsage()
      correlateWithKanban()
      json(res, { ok: true, ...result })
    } catch (err) {
      logger.error({ err }, 'Token usage collection failed')
      json(res, { error: 'Collection failed' }, 500)
    }
    return true
  }

  if (path === '/api/token-usage/summary' && method === 'GET') {
    const from = url.searchParams.get('from')
    const to = url.searchParams.get('to')
    const summary = getTokenSummary(
      from ? parseInt(from) : undefined,
      to ? parseInt(to) : undefined,
    )
    jsonMaybeGzip(req, res, summary)
    return true
  }

  if (path === '/api/token-usage/timeline' && method === 'GET') {
    const bucketMinutes = parseInt(url.searchParams.get('bucket') || '60')
    const from = url.searchParams.get('from')
    const to = url.searchParams.get('to')
    const agent = url.searchParams.get('agent') || undefined
    const timeline = getTokenTimeline(
      bucketMinutes,
      from ? parseInt(from) : undefined,
      to ? parseInt(to) : undefined,
      agent,
    )
    json(res, timeline)
    return true
  }

  if (path === '/api/token-usage/model-dist' && method === 'GET') {
    const from = url.searchParams.get('from')
    const to = url.searchParams.get('to')
    const agent = url.searchParams.get('agent') || undefined
    json(res, getModelDistribution(
      from ? parseInt(from) : undefined,
      to ? parseInt(to) : undefined,
      agent,
    ))
    return true
  }

  if (path === '/api/token-usage/tool-stats' && method === 'GET') {
    const from = url.searchParams.get('from')
    const to = url.searchParams.get('to')
    const agent = url.searchParams.get('agent') || undefined
    json(res, getToolStats(
      from ? parseInt(from) : undefined,
      to ? parseInt(to) : undefined,
      agent,
    ))
    return true
  }

  if (path === '/api/token-usage' && method === 'GET') {
    const agent = url.searchParams.get('agent') || undefined
    const from = url.searchParams.get('from')
    const to = url.searchParams.get('to')
    const limit = parseInt(url.searchParams.get('limit') || '100')
    const offset = parseInt(url.searchParams.get('offset') || '0')
    const minTokens = url.searchParams.get('min_tokens')
    const q = url.searchParams.get('q') || undefined
    const details = getTokenDetails({
      agent,
      from: from ? parseInt(from) : undefined,
      to: to ? parseInt(to) : undefined,
      limit: Math.min(limit, 500),
      offset,
      minTokens: minTokens ? parseInt(minTokens) : undefined,
      q,
    })
    json(res, details)
    return true
  }

  // Kartya e0c9338e / docs/context-size-monitor.md: fordulonkenti felmeno
  // kontextus-meret, Boss-fordulo jelolessel + opcionalis md-export.
  if (path === '/api/context-usage' && method === 'GET') {
    const agent = url.searchParams.get('agent') || undefined
    const since = url.searchParams.get('since')
    const limit = url.searchParams.get('limit')
    const result = getContextUsage({
      agent,
      since: since ? parseInt(since) : undefined,
      limit: limit ? parseInt(limit) : undefined,
    })
    if (url.searchParams.get('format') === 'md') {
      const md = exportContextUsageMarkdown(result, Math.floor(Date.now() / 1000))
      res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' })
      res.end(md)
      return true
    }
    json(res, result)
    return true
  }

  return false
}
