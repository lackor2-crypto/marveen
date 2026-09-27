// #418 -- PR-throughput ledger, rebuilt from upstream 3877c61d (PRLEDGER907):
// pure decisions, the db upsert/window contract, the routes, and the UI.
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { initDatabase, upsertPrLedgerRows, listPrLedger, type PrLedgerRow } from '../db.js'
import { tryHandlePrLedger } from '../web/routes/pr-ledger.js'
import type { RouteContext } from '../web/routes/types.js'
import {
  collectDue,
  decideLive,
  isoDay,
  isValidDay,
  isValidOwner,
  mapPr,
  ownerFromRemoteUrl,
  prNumbersFromMessages,
  resolveLedgerOwner,
  summarize,
  PR_LEDGER_REFRESH_MS,
} from '../pr-ledger.js'

const ROOT = join(__dirname, '..', '..')
const src = (p: string) => readFileSync(join(ROOT, p), 'utf-8')

function fakeGet(pathAndQuery: string): { ctx: RouteContext; out: { status: number; body: any } } {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = {
    statusCode: 200,
    setHeader() {},
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (out.status === 0) out.status = res.statusCode; if (chunk) out.body = JSON.parse(chunk) },
  }
  const url = new URL(`http://localhost${pathAndQuery}`)
  return { ctx: { req: {} as any, res, path: url.pathname, method: 'GET', url } as RouteContext, out }
}

function row(o: Partial<PrLedgerRow>): PrLedgerRow {
  return {
    repo: 'r', number: 1, closed_date: '2026-09-10', base_branch: 'main', author: 'a',
    additions: 1, deletions: 1, files: 1, state: 'merged', title: 't',
    is_live: 1, live_since: '2026-09-10', measured_at: 1, ...o,
  }
}

describe('pure decisions', () => {
  it('isoDay takes the UTC day of an ISO stamp', () => {
    expect(isoDay('2026-09-07T23:59:00Z')).toBe('2026-09-07')
    expect(isoDay(null)).toBeNull()
    expect(isoDay('garbage')).toBeNull()
  })
  it('mapPr: merged uses mergedAt, rejected uses closedAt, open is dropped', () => {
    const m = mapPr('x', { number: 5, mergedAt: '2026-09-02T10:00:00Z', closedAt: '2026-09-03T10:00:00Z', baseRefName: 'main', author: { login: 'u' }, additions: 3, deletions: 2, changedFiles: 1, title: 'T' })
    expect(m).toMatchObject({ repo: 'x', number: 5, closed_date: '2026-09-02', state: 'merged', author: 'u', files: 1 })
    expect(mapPr('x', { number: 6, mergedAt: null, closedAt: '2026-09-04T00:00:00Z' })?.state).toBe('closed')
    expect(mapPr('x', { number: 7 })).toBeNull()
  })
  it('prNumbersFromMessages reads (#N) references', () => {
    expect([...prNumbersFromMessages(['feat: a (#12)', 'fix (#3) and (#4)', null, 'no ref'])].sort()).toEqual([12, 3, 4].sort())
  })
  it('decideLive: main merge live from its day; develop live unless unreleased; rejected/feature never', () => {
    const base = { number: 9, closed_date: '2026-09-01' }
    expect(decideLive({ ...base, state: 'merged', base_branch: 'main' }, new Set())).toEqual({ is_live: 1, live_since: '2026-09-01' })
    expect(decideLive({ ...base, state: 'merged', base_branch: 'develop' }, new Set([9]))).toEqual({ is_live: 0, live_since: null })
    expect(decideLive({ ...base, state: 'merged', base_branch: 'develop' }, new Set())).toEqual({ is_live: 1, live_since: null })
    expect(decideLive({ ...base, state: 'merged', base_branch: 'feat/x' }, new Set()).is_live).toBe(0)
    expect(decideLive({ ...base, state: 'closed', base_branch: 'main' }, new Set()).is_live).toBe(0)
  })
  it('summarize: the four numbers', () => {
    expect(summarize([{ state: 'merged', is_live: 1 }, { state: 'merged', is_live: 0 }, { state: 'closed', is_live: 0 }]))
      .toEqual({ closed: 3, merged: 2, rejected: 1, live: 1 })
  })
  it('owner: setting wins, empty falls back to origin, a bad setting does NOT fall back', () => {
    expect(ownerFromRemoteUrl('https://github.com/some-one/marveen.git')).toBe('some-one')
    expect(ownerFromRemoteUrl('git@github.com:org1/repo')).toBe('org1')
    expect(ownerFromRemoteUrl('https://gitlab.com/a/b.git')).toBe('')
    expect(resolveLedgerOwner('me', 'https://github.com/other/x.git')).toEqual({ owner: 'me', source: 'setting' })
    expect(resolveLedgerOwner('', 'https://github.com/other/x.git')).toEqual({ owner: 'other', source: 'origin' })
    expect(resolveLedgerOwner('', '')).toEqual({ owner: '', source: 'none' })
    expect(resolveLedgerOwner('bad name', 'https://github.com/other/x.git')).toEqual({ owner: '', source: 'invalid-setting' })
    expect(isValidOwner('-x')).toBe(false)
  })
  it('isValidDay rejects impossible dates', () => {
    expect(isValidDay('2026-02-28')).toBe(true)
    expect(isValidDay('2026-02-31')).toBe(false)
    expect(isValidDay('2026-9-1')).toBe(false)
  })
  it('collectDue: never run, or older than the refresh period', () => {
    expect(collectDue(null, 5)).toBe(true)
    expect(collectDue(0, PR_LEDGER_REFRESH_MS - 1)).toBe(false)
    expect(collectDue(0, PR_LEDGER_REFRESH_MS)).toBe(true)
  })
})

describe('db: upsert + window', () => {
  beforeEach(() => initDatabase(':memory:'))

  it('upsert is idempotent and re-derives is_live (a release flips it)', () => {
    upsertPrLedgerRows([{ row: row({ number: 1, base_branch: 'develop', is_live: 0, live_since: null }), preserveLive: false }])
    upsertPrLedgerRows([{ row: row({ number: 1, base_branch: 'develop', is_live: 1, live_since: null }), preserveLive: false }])
    const { rows, totalRows } = listPrLedger('2026-09-01', '2026-09-30')
    expect(totalRows).toBe(1)
    expect(rows[0].is_live).toBe(1)
  })
  it('degraded (preserveLive) keeps the stored is_live, and a new row enters not-live', () => {
    upsertPrLedgerRows([{ row: row({ number: 2, base_branch: 'develop', is_live: 0 }), preserveLive: false }])
    upsertPrLedgerRows([
      { row: row({ number: 2, base_branch: 'develop', is_live: 1, title: 'new title' }), preserveLive: true },
      { row: row({ number: 3, base_branch: 'develop', is_live: 1 }), preserveLive: true },
    ])
    const { rows } = listPrLedger('2026-09-01', '2026-09-30')
    const by = Object.fromEntries(rows.map(r => [r.number, r]))
    expect(by[2].is_live).toBe(0)
    expect(by[2].title).toBe('new title')
    expect(by[3].is_live).toBe(0)
  })
  it('window is inclusive and filters by repo; totalRows tells "nothing collected" from "nothing in window"', () => {
    upsertPrLedgerRows([
      { row: row({ repo: 'a', number: 1, closed_date: '2026-09-01' }), preserveLive: false },
      { row: row({ repo: 'b', number: 1, closed_date: '2026-09-30' }), preserveLive: false },
      { row: row({ repo: 'a', number: 2, closed_date: '2026-10-01' }), preserveLive: false },
    ])
    expect(listPrLedger('2026-09-01', '2026-09-30').rows).toHaveLength(2)
    expect(listPrLedger('2026-09-01', '2026-09-30', 'a').rows).toHaveLength(1)
    const empty = listPrLedger('2025-01-01', '2025-01-02')
    expect(empty.rows).toHaveLength(0)
    expect(empty.totalRows).toBe(3)
  })
})

describe('routes', () => {
  beforeEach(() => initDatabase(':memory:'))

  it('GET /api/pr-ledger validates the range and serves summary + rows', async () => {
    upsertPrLedgerRows([
      { row: row({ number: 1, state: 'merged', is_live: 1 }), preserveLive: false },
      { row: row({ number: 2, state: 'closed', is_live: 0 }), preserveLive: false },
    ])
    const bad = fakeGet('/api/pr-ledger?from=2026-09-31&to=2026-09-01')
    expect(await tryHandlePrLedger(bad.ctx)).toBe(true)
    expect(bad.out.status).toBe(400)
    const rev = fakeGet('/api/pr-ledger?from=2026-09-30&to=2026-09-01')
    await tryHandlePrLedger(rev.ctx)
    expect(rev.out.status).toBe(400)
    const ok = fakeGet('/api/pr-ledger?from=2026-09-01&to=2026-09-30')
    await tryHandlePrLedger(ok.ctx)
    expect(ok.out.body.summary).toEqual({ closed: 2, merged: 1, rejected: 1, live: 1 })
    expect(ok.out.body.totalRows).toBe(2)
  })
  it('unknown paths fall through', async () => {
    const x = fakeGet('/api/pr-ledgerx')
    expect(await tryHandlePrLedger(x.ctx)).toBe(false)
  })
})

describe('wiring and host-agnosticism', () => {
  it('web.ts registers the route and the runner, and clears it on shutdown', () => {
    const w = src('src/web.ts')
    expect(w).toMatch(/if \(await tryHandlePrLedger\(routeCtx\)\) return/)
    expect(w).toMatch(/startPrLedgerRunner\(\)/)
    expect(w).toMatch(/clearInterval\(prLedgerInterval\)/)
  })
  it('no owner is hard-coded; it comes from the setting or the origin remote', () => {
    const runner = src('src/web/pr-ledger-runner.ts')
    expect(runner).toMatch(/getEffectiveSettingValue\('PR_LEDGER_OWNER'\)/)
    expect(runner).toMatch(/readRemotes\(\)/)
    expect(runner).not.toMatch(/Szotasz|lackor/i)
    expect(src('src/config-registry.ts')).toMatch(/key: 'PR_LEDGER_OWNER',\s*type: 'string',\s*default: '',/)
  })
  it('a failed unreleased-set measurement never becomes an empty set', () => {
    const runner = src('src/web/pr-ledger-runner.ts')
    expect(runner).toMatch(/if \(!unreleased\.ok\) run\.degraded\.push/)
    expect(runner).toMatch(/preserveLive: true/)
  })
  it('the Updates page has the section, HU+EN, incl. the setup and zero states', () => {
    const html = src('web/index.html')
    for (const id of ['updatesPrLedger', 'prlFrom', 'prlTo', 'prlShowBtn', 'prlCollectBtn', 'prlStatus', 'prlNumbers', 'prlRows']) {
      expect(html).toContain(`id="${id}"`)
    }
    const keys = ['title', 'intro', 'no_owner', 'invalid_owner', 'no_key', 'never', 'running', 'last_ok', 'last_err', 'degraded', 'empty_window']
    for (const f of ['web/lang/hu.js', 'web/lang/en.js']) {
      const lang = src(f)
      for (const k of keys) expect(lang).toContain(`'updates.prl.${k}'`)
      expect(lang).toContain(`'settings.desc.PR_LEDGER_OWNER'`)
    }
    expect(src('web/app.js')).toMatch(/loadPrLedger\(\)/)
  })
})
