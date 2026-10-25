// #772 (3rd point): the Overview self-check says when the OpenRouter credit is low. Two sources, because the account
// balance (GET /v1/credits) needs the optional management key, and a fresh install usually has only the runtime key:
// 1. the last 402 "out of credit" answer any chat call got (ai-call.ts writes it here), until a full-size call succeeds;
// 2. the measured balance, when the management key is set and the Overview has fetched it (the same 90%/95% tiers).
// The note is a file in store/ so a 402 seen by a script or before a restart still shows on the dashboard.

import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { STORE_DIR } from './config.js'
import type { OpenRouterCreditsView } from './openrouter-credits.js'

export interface CreditNote {
  /** When the last 402 (out of / low on credit) came back, ms. */
  last402At: number | null
  /** The token count that 402 said the account could still afford (null: the answer did not say). */
  afford: number | null
  /** When a call last succeeded at its full size (no 402 retry), ms. */
  lastOkAt: number | null
}

/** A 402 older than this, with no call since, is no longer shown: nobody measured the credit for a week. */
export const CREDIT_NOTE_MAX_AGE_MS = 7 * 24 * 3600_000

// Tests never write into the real store/ unless they point the note somewhere themselves.
let notePath: string | null = process.env.VITEST ? null : join(STORE_DIR, 'openrouter-credit.json')
let memo: CreditNote | null = null
/** The file's mtime the memo was read at: another process (a script) writing it is picked up on the next read. */
let memoMtime = -1

/** Tests only: where the note lives (null: nowhere, nothing is written or read). */
export function setCreditNotePathForTest(p: string | null): void { notePath = p; memo = null; memoMtime = -1 }

function mtimeOf(p: string): number {
  try { return statSync(p).mtimeMs } catch { return -1 }
}

export function readCreditNote(): CreditNote {
  const empty: CreditNote = { last402At: null, afford: null, lastOkAt: null }
  if (!notePath) return memo ?? empty
  const mtime = mtimeOf(notePath)
  if (memo && mtime === memoMtime) return memo
  memoMtime = mtime
  if (mtime < 0) return (memo = empty)
  try {
    const j = JSON.parse(readFileSync(notePath, 'utf-8')) as Partial<CreditNote>
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
    memo = { last402At: num(j.last402At), afford: num(j.afford), lastOkAt: num(j.lastOkAt) }
  } catch {
    memo = empty
  }
  return memo
}

function writeNote(n: CreditNote): void {
  memo = n
  if (!notePath) return
  try {
    mkdirSync(dirname(notePath), { recursive: true })
    const tmp = notePath + '.tmp'
    writeFileSync(tmp, JSON.stringify(n) + '\n', 'utf-8')
    renameSync(tmp, notePath)
    memoMtime = mtimeOf(notePath)
  } catch { /* a self-check hint must never break the AI call */ }
}

/** A chat call got 402: the credit is out or nearly so. */
export function noteCredit402(afford: number | null, now: number = Date.now()): void {
  writeNote({ ...readCreditNote(), last402At: now, afford })
}

/** A chat call succeeded at its full size. Writes only when it clears an open 402, not on every call. */
export function noteCreditOk(now: number = Date.now()): void {
  const n = readCreditNote()
  if (n.last402At === null || (n.lastOkAt !== null && n.lastOkAt >= n.last402At)) return
  writeNote({ ...n, lastOkAt: now })
}

export interface CreditHealthRow {
  id: 'openrouter_credit_low' | 'openrouter_credit_402' | 'openrouter_credit_ok'
  status: 'ok' | 'warn' | 'bad'
  params?: Record<string, string | number>
}

/**
 * The self-check rows. Nothing when there is nothing to say (no management key measured, no recent 402): an install
 * that does not use OpenRouter gets no row about it.
 */
export function openRouterCreditRows(
  balance: OpenRouterCreditsView | null,
  note: CreditNote = readCreditNote(),
  now: number = Date.now(),
): CreditHealthRow[] {
  if (balance && balance.tier !== 'normal') {
    return [{ id: 'openrouter_credit_low', status: balance.tier === 'critical' ? 'bad' : 'warn', params: { usd: Math.max(0, balance.remaining).toFixed(2), pct: Math.round(balance.usedPct ?? 100) } }]
  }
  const open402 = note.last402At !== null
    && (note.lastOkAt === null || note.lastOkAt < note.last402At)
    && now - note.last402At < CREDIT_NOTE_MAX_AGE_MS
  if (open402) {
    return [{ id: 'openrouter_credit_402', status: 'warn', params: { h: Math.max(0, Math.floor((now - note.last402At!) / 3600_000)) } }]
  }
  if (balance) return [{ id: 'openrouter_credit_ok', status: 'ok', params: { usd: Math.max(0, balance.remaining).toFixed(2) } }]
  return []
}
