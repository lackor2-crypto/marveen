// PR-throughput ledger -- the I/O half (kanban #418, rebuilt from upstream
// 3877c61d / PRLEDGER907). Pure decisions live in src/pr-ledger.ts.
//
// Upstream runs a standalone .mjs through the gh CLI for one hard-coded
// owner. Here it runs inside the dashboard, once a day, for the owner the
// user set (PR_LEDGER_OWNER) or -- when that is empty -- the owner of this
// install's own `origin` remote, and it reaches GitHub with the dashboard's
// own GitHub accounts (the key added on the Depot page, or an existing gh
// login). So a fresh install sets it up entirely from the UI.
//
// THE ZERO MEANS TWO THINGS. "No row" can be "never collected", "cannot
// collect" (no owner, no key) or "collected, nothing closed". The status
// endpoint reports the three separately (config precheck + last run), and a
// run that could not measure part of a repo says so in `degraded` instead of
// writing a guess.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { STORE_DIR } from '../config.js'
import { logger } from '../logger.js'
import { getEffectiveSettingValue } from '../settings-store.js'
import { upsertPrLedgerRows, type PrLedgerRow } from '../db.js'
import { githubRequest, hasGitToken, gitAccountsWithToken } from '../git-accounts.js'
import { readRemotes } from './git-remotes.js'
import { atomicWriteFileSync } from './atomic-write.js'
import {
  collectDue,
  decideLive,
  mapPr,
  prNumbersFromMessages,
  resolveLedgerOwner,
  type OwnerSource,
  type RawPr,
} from '../pr-ledger.js'

export const PR_LEDGER_INTERVAL_MS = 60 * 60_000
const PR_LEDGER_INITIAL_DELAY_MS = 7 * 60_000
const STATUS_PATH = join(STORE_DIR, 'pr-ledger-status.json')
// Newest-updated first, so a PR closed today is always in the first pages.
// 10 x 100: the idempotent upsert keeps older rows from earlier runs.
const PR_PAGES = 10
const REPO_PAGES = 5
const COMPARE_PAGES = 30
const REQUEST_TIMEOUT_MS = 30_000

export interface PrLedgerConfig {
  owner: string
  ownerSource: OwnerSource
  /** The GitHub account whose key is used; '' when none is usable. */
  account: string
}

export interface PrLedgerRun {
  ok: boolean
  owner: string
  account: string
  startedAt: number
  finishedAt: number
  reposScanned: number
  reposWithPrs: number
  rowsUpserted: number
  /** `<repo>:pr-list` / `<repo>:unreleased-set` -- parts NOT measured this run. */
  degraded: string[]
  /** GitHub's own error text for a failed run; never a guessed cause. */
  error: string
}

let running = false

export function readPrLedgerConfig(): PrLedgerConfig {
  let setting = ''
  try { setting = String(getEffectiveSettingValue('PR_LEDGER_OWNER') ?? '') } catch { /* unregistered: treat as empty */ }
  const remotes = readRemotes()
  const originUrl = remotes.readable ? remotes.origin?.url ?? '' : ''
  const { owner, source } = resolveLedgerOwner(setting, originUrl)
  let account = ''
  if (owner) {
    // The owner's own key first; else any registered account with a key
    // (a personal key commonly reads an organization's repos too).
    account = hasGitToken(owner) ? owner : (gitAccountsWithToken()[0] ?? '')
  }
  return { owner, ownerSource: source, account }
}

export function readLastPrLedgerRun(): PrLedgerRun | null {
  try {
    if (!existsSync(STATUS_PATH)) return null
    return JSON.parse(readFileSync(STATUS_PATH, 'utf-8')) as PrLedgerRun
  } catch { return null }
}

export function prLedgerRunning(): boolean { return running }

async function ghJson(account: string, path: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  const r = await githubRequest(account, path, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  const body = await r.json().catch(() => null)
  return { status: r.status, body }
}

async function gql(account: string, query: string, variables: Record<string, unknown>): Promise<any> {
  const { status, body } = await ghJson(account, '/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  })
  if (status !== 200) throw new Error(`GitHub ${status}: ${String(body?.message ?? '').slice(0, 200)}`)
  if (Array.isArray(body?.errors) && body.errors.length) {
    throw new Error(body.errors.map((e: any) => String(e?.message ?? '')).join('; ').slice(0, 300))
  }
  return body?.data
}

const REPOS_Q = `query($o:String!,$c:String){repositoryOwner(login:$o){repositories(first:100,after:$c,ownerAffiliations:OWNER,orderBy:{field:NAME,direction:ASC}){nodes{name} pageInfo{hasNextPage endCursor}}}}`

// SCOPE RULE (from upstream's measured mistake): every repo of the owner is
// scanned and the closed-PR listing decides. Never prefilter on open PRs or
// recent pushes -- a repo with no open PR can be the period's busiest.
async function listRepos(account: string, owner: string): Promise<string[]> {
  const out: string[] = []
  let cursor: string | null = null
  for (let page = 0; page < REPO_PAGES; page++) {
    const data = await gql(account, REPOS_Q, { o: owner, c: cursor })
    const conn = data?.repositoryOwner?.repositories
    if (!data?.repositoryOwner) throw new Error(`GitHub: no user or organization named "${owner}"`)
    for (const n of conn?.nodes ?? []) if (n?.name) out.push(String(n.name))
    if (!conn?.pageInfo?.hasNextPage) break
    cursor = conn.pageInfo.endCursor
  }
  return out
}

const PRS_Q = `query($o:String!,$r:String!,$c:String){repository(owner:$o,name:$r){pullRequests(first:100,after:$c,states:[CLOSED,MERGED],orderBy:{field:UPDATED_AT,direction:DESC}){nodes{number title author{login} baseRefName mergedAt closedAt additions deletions changedFiles} pageInfo{hasNextPage endCursor}}}}`

async function listClosedPrs(account: string, owner: string, repo: string): Promise<RawPr[]> {
  const out: RawPr[] = []
  let cursor: string | null = null
  for (let page = 0; page < PR_PAGES; page++) {
    const data = await gql(account, PRS_Q, { o: owner, r: repo, c: cursor })
    const conn = data?.repository?.pullRequests
    for (const n of conn?.nodes ?? []) if (n) out.push(n as RawPr)
    if (!conn?.pageInfo?.hasNextPage) break
    cursor = conn.pageInfo.endCursor
  }
  return out
}

/**
 * The not-yet-released PR set: commit subjects in <release>...develop.
 *
 * A FAILED measurement must never look like an empty one (an empty set flips
 * every develop merge live). The develop branch's existence is asked on its
 * own: a 404 there is the legit "no develop" case. This only runs AFTER the
 * repo's PR listing succeeded, so a 404 cannot mean "no such repo".
 */
async function unreleasedInfo(account: string, owner: string, repo: string): Promise<{ ok: true; set: Set<number> } | { ok: false }> {
  const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`
  try {
    const b = await ghJson(account, `${base}/branches/develop`)
    if (b.status === 404) return { ok: true, set: new Set() }
    if (b.status !== 200) return { ok: false }
    for (const release of ['main', 'master']) {
      const subjects: string[] = []
      let status = 200
      for (let page = 1; page <= COMPARE_PAGES; page++) {
        const c = await ghJson(account, `${base}/compare/${release}...develop?per_page=100&page=${page}`)
        status = c.status
        if (status !== 200) break
        const commits = Array.isArray(c.body?.commits) ? c.body.commits : []
        for (const cm of commits) subjects.push(String(cm?.commit?.message ?? '').split('\n')[0])
        if (commits.length < 100) break
      }
      if (status === 200) return { ok: true, set: prNumbersFromMessages(subjects) }
      if (status !== 404) return { ok: false }
    }
    return { ok: false }
  } catch {
    return { ok: false }
  }
}

/** One full collection. Returns null when a run is already in progress. */
export async function collectPrLedger(nowFn: () => number = Date.now): Promise<PrLedgerRun | null> {
  if (running) return null
  running = true
  const startedAt = nowFn()
  const cfg = readPrLedgerConfig()
  const run: PrLedgerRun = {
    ok: false, owner: cfg.owner, account: cfg.account, startedAt, finishedAt: startedAt,
    reposScanned: 0, reposWithPrs: 0, rowsUpserted: 0, degraded: [], error: '',
  }
  try {
    if (!cfg.owner) throw new Error(cfg.ownerSource === 'invalid-setting' ? 'invalid-owner' : 'no-owner')
    if (!cfg.account) throw new Error('no-key')
    const repos = await listRepos(cfg.account, cfg.owner)
    run.reposScanned = repos.length
    const measuredAt = Math.floor(nowFn() / 1000)
    for (const repo of repos) {
      let prs: RawPr[]
      try {
        prs = await listClosedPrs(cfg.account, cfg.owner, repo)
      } catch (err) {
        run.degraded.push(`${repo}:pr-list`)
        logger.warn({ repo, err: String(err).slice(0, 200) }, '[pr-ledger] closed-PR listing failed')
        continue
      }
      if (prs.length === 0) continue
      run.reposWithPrs++
      const unreleased = await unreleasedInfo(cfg.account, cfg.owner, repo)
      if (!unreleased.ok) run.degraded.push(`${repo}:unreleased-set`)
      const items: Array<{ row: PrLedgerRow; preserveLive: boolean }> = []
      for (const pr of prs) {
        const facts = mapPr(repo, pr)
        if (!facts) continue
        if (!unreleased.ok && facts.base_branch === 'develop') {
          items.push({ row: { ...facts, is_live: 0, live_since: null, measured_at: measuredAt }, preserveLive: true })
        } else {
          const live = decideLive(facts, unreleased.ok ? unreleased.set : new Set())
          items.push({ row: { ...facts, ...live, measured_at: measuredAt }, preserveLive: false })
        }
      }
      run.rowsUpserted += upsertPrLedgerRows(items)
    }
    run.ok = true
  } catch (err) {
    run.error = err instanceof Error ? err.message : String(err)
    logger.warn({ owner: cfg.owner, error: run.error.slice(0, 200) }, '[pr-ledger] collection failed')
  } finally {
    run.finishedAt = nowFn()
    running = false
    try { atomicWriteFileSync(STATUS_PATH, JSON.stringify(run, null, 2)) } catch (err) {
      logger.warn({ err }, '[pr-ledger] could not write the status file')
    }
  }
  logger.info({ owner: run.owner, ok: run.ok, repos: run.reposScanned, rows: run.rowsUpserted, degraded: run.degraded.length }, '[pr-ledger] collection finished')
  return run
}

/** Daily self-accrual. Nothing is sent anywhere without an owner AND a key. */
export async function prLedgerTick(nowMs = Date.now()): Promise<void> {
  const cfg = readPrLedgerConfig()
  if (!cfg.owner || !cfg.account) return
  const last = readLastPrLedgerRun()
  if (!collectDue(last?.finishedAt ?? null, nowMs)) return
  await collectPrLedger()
}

export function startPrLedgerRunner(): NodeJS.Timeout {
  const tick = () => { prLedgerTick().catch(err => logger.warn({ err }, '[pr-ledger] tick failed')) }
  setTimeout(tick, PR_LEDGER_INITIAL_DELAY_MS).unref?.()
  const iv = setInterval(tick, PR_LEDGER_INTERVAL_MS)
  iv.unref?.()
  return iv
}
