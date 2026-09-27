/**
 * #418 -- PR-throughput ledger, pure decisions (rebuilt from upstream 3877c61d,
 * PRLEDGER907, onto our code).
 *
 * One row per CLOSED pull request across one GitHub owner's repositories. The
 * collector (src/web/pr-ledger-runner.ts) is the I/O shell around these
 * functions; everything here is testable without the network.
 *
 * What differs from upstream, on purpose:
 *  - the owner is NEVER hard-coded (upstream: 'Szotasz'). It comes from the
 *    PR_LEDGER_OWNER setting, else from the `origin` remote's GitHub owner --
 *    see resolveLedgerOwner();
 *  - GitHub is reached through the dashboard's own GitHub accounts (the key
 *    the user adds on the Depot page, or an existing gh login), not by
 *    shelling out to the gh CLI -- so a fresh install can set it up from the
 *    UI, and a missing gh binary is not a failure mode;
 *  - one schema, one writer: the table lives in src/db.ts only (upstream kept
 *    a second CREATE in a standalone .mjs collector).
 */

/** YYYY-MM-DD (UTC) from an ISO timestamp; null when absent or malformed. */
export function isoDay(ts: unknown): string | null {
  if (!ts || typeof ts !== 'string') return null
  const m = ts.match(/^(\d{4}-\d{2}-\d{2})T/)
  return m ? m[1] : null
}

/** The shape one closed PR arrives in (GraphQL pullRequests node). */
export interface RawPr {
  number: number
  title?: string | null
  author?: { login?: string | null } | null
  baseRefName?: string | null
  mergedAt?: string | null
  closedAt?: string | null
  additions?: number | null
  deletions?: number | null
  changedFiles?: number | null
}

export interface PrFacts {
  repo: string
  number: number
  closed_date: string
  base_branch: string
  author: string | null
  additions: number | null
  deletions: number | null
  files: number | null
  state: 'merged' | 'closed'
  title: string | null
}

/**
 * One closed PR -> a ledger row (without is_live, which needs the release
 * measurement). null for a PR with no usable close date (still open).
 */
export function mapPr(repo: string, pr: RawPr): PrFacts | null {
  const merged = Boolean(pr.mergedAt)
  const closedDate = isoDay(pr.mergedAt) ?? isoDay(pr.closedAt)
  if (!closedDate || !Number.isInteger(pr.number)) return null
  return {
    repo,
    number: pr.number,
    closed_date: closedDate,
    base_branch: pr.baseRefName ?? '',
    author: pr.author?.login ?? null,
    additions: pr.additions ?? null,
    deletions: pr.deletions ?? null,
    files: pr.changedFiles ?? null,
    state: merged ? 'merged' : 'closed',
    title: pr.title ?? null,
  }
}

/**
 * The "(#N)" PR references in commit subjects -- the shape a squash/merge
 * commit carries. Used on the main...develop compare range: what appears
 * there has NOT shipped yet.
 */
export function prNumbersFromMessages(messages: Iterable<unknown>): Set<number> {
  const out = new Set<number>()
  for (const msg of messages) {
    for (const m of String(msg ?? '').matchAll(/\(#(\d+)\)/g)) out.add(Number(m[1]))
  }
  return out
}

/**
 * is_live -- the number the ledger is about.
 *
 * - A merge into the release branch (main/master) IS the release: live, from
 *   the day it merged.
 * - A merge into develop is live UNLESS its number still sits in the
 *   main...develop range (`unreleased`) -- that set is measured, never
 *   assumed. Its live date would need the release date, which is not
 *   measured, so live_since stays null rather than a guess.
 * - Feature-branch merges and rejected (closed) PRs are never live.
 */
export function decideLive(row: Pick<PrFacts, 'state' | 'base_branch' | 'number' | 'closed_date'>, unreleased: Set<number>): { is_live: 0 | 1; live_since: string | null } {
  if (row.state !== 'merged') return { is_live: 0, live_since: null }
  const base = row.base_branch
  if (base === 'main' || base === 'master') return { is_live: 1, live_since: row.closed_date }
  if (base === 'develop') {
    return unreleased.has(row.number) ? { is_live: 0, live_since: null } : { is_live: 1, live_since: null }
  }
  return { is_live: 0, live_since: null }
}

export interface PrLedgerSummary { closed: number; merged: number; rejected: number; live: number }

/** The four numbers, derived from the SAME rows the caller shows. */
export function summarize(rows: Array<{ state: string; is_live: number | boolean }>): PrLedgerSummary {
  let merged = 0, live = 0
  for (const r of rows) {
    if (r.state === 'merged') merged++
    if (r.is_live) live++
  }
  return { closed: rows.length, merged, rejected: rows.length - merged, live }
}

/** GitHub login / org name: what GitHub itself allows, nothing else. */
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/

export function isValidOwner(s: unknown): s is string {
  return typeof s === 'string' && OWNER_RE.test(s)
}

/** `Owner` from a GitHub remote URL (https or ssh); '' for anything else. */
export function ownerFromRemoteUrl(url: string | null | undefined): string {
  const m = String(url ?? '').match(/github\.com[:/]([^/]+)\/[^/]+?(?:\.git)?\/?$/i)
  return m && isValidOwner(m[1]) ? m[1] : ''
}

export type OwnerSource = 'setting' | 'origin' | 'none' | 'invalid-setting'

/**
 * Whose repositories the ledger measures. The setting wins; an empty setting
 * falls back to the owner of this install's own `origin` remote. A setting
 * that is not a valid GitHub name is reported as such -- it does NOT silently
 * fall back, because then the user would see numbers for an owner they did
 * not ask for.
 */
export function resolveLedgerOwner(setting: string | null | undefined, originUrl: string | null | undefined): { owner: string; source: OwnerSource } {
  const s = String(setting ?? '').trim()
  if (s) return isValidOwner(s) ? { owner: s, source: 'setting' } : { owner: '', source: 'invalid-setting' }
  const o = ownerFromRemoteUrl(originUrl)
  return o ? { owner: o, source: 'origin' } : { owner: '', source: 'none' }
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

/** A real calendar day in YYYY-MM-DD (rejects 2026-02-31). */
export function isValidDay(s: unknown): s is string {
  if (typeof s !== 'string' || !DAY_RE.test(s)) return false
  const d = new Date(s + 'T00:00:00Z')
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
}

/** Collect again when the last FINISHED run is older than this. */
export const PR_LEDGER_REFRESH_MS = 23 * 3_600_000

export function collectDue(lastFinishedMs: number | null, nowMs: number): boolean {
  return lastFinishedMs == null || nowMs - lastFinishedMs >= PR_LEDGER_REFRESH_MS
}
