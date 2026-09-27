import { listPrLedger } from '../../db.js'
import { isValidDay, summarize } from '../../pr-ledger.js'
import { json } from '../http-helpers.js'
import { collectPrLedger, prLedgerRunning, readLastPrLedgerRun, readPrLedgerConfig } from '../pr-ledger-runner.js'
import type { RouteContext } from './types.js'

// #418 -- PR-throughput ledger (rebuilt from upstream 3877c61d). The table is
// written only by src/web/pr-ledger-runner.ts; these routes read it, report
// whether collecting is possible at all, and start a collection on demand.

export async function tryHandlePrLedger(ctx: RouteContext): Promise<boolean> {
  const { res, path, method, url } = ctx

  if (path === '/api/pr-ledger' && method === 'GET') {
    const from = url.searchParams.get('from') ?? ''
    const to = url.searchParams.get('to') ?? ''
    const repo = url.searchParams.get('repo') || undefined
    if (!isValidDay(from) || !isValidDay(to)) {
      json(res, { error: 'bad-range', message: 'from and to are required as YYYY-MM-DD' }, 400)
      return true
    }
    if (to < from) {
      json(res, { error: 'bad-range', message: 'to must not precede from' }, 400)
      return true
    }
    const { rows, totalRows, repos } = listPrLedger(from, to, repo)
    json(res, { from, to, repo: repo ?? null, summary: summarize(rows), rows, totalRows, repos })
    return true
  }

  // What the UI needs to tell "not set up" / "never collected" / "collected,
  // nothing closed" apart: the live precheck AND the last run, separately.
  if (path === '/api/pr-ledger/status' && method === 'GET') {
    json(res, { config: readPrLedgerConfig(), lastRun: readLastPrLedgerRun(), running: prLedgerRunning() })
    return true
  }

  if (path === '/api/pr-ledger/refresh' && method === 'POST') {
    const cfg = readPrLedgerConfig()
    if (!cfg.owner) {
      json(res, { error: cfg.ownerSource === 'invalid-setting' ? 'invalid-owner' : 'no-owner' }, 400)
      return true
    }
    if (!cfg.account) {
      json(res, { error: 'no-key', owner: cfg.owner }, 400)
      return true
    }
    if (prLedgerRunning()) {
      json(res, { ok: true, started: false, running: true })
      return true
    }
    // Background: a large owner takes minutes; the UI polls the status.
    void collectPrLedger().catch(() => { /* the run records its own error */ })
    json(res, { ok: true, started: true, running: true })
    return true
  }

  return false
}
