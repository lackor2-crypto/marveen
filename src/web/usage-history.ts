// #799: the 5-hour quota had no history. The live file and the statusline snapshot are overwritten each
// minute, so "how many tokens is 1% of the frame" could never be measured after the fact. This keeps an
// append-only, size-capped jsonl of the readings so that figure can be derived from real data.
//
// A line is written only when something moved (a percentage or a window reset) or when the last line is
// older than HEARTBEAT_MS, so an idle account does not grow the file by a line a minute.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { STORE_DIR } from '../config.js'

export const USAGE_HISTORY_MAX_BYTES = 512 * 1024
export const USAGE_HISTORY_HEARTBEAT_MS = 10 * 60_000

export interface UsageHistorySample {
  /** Measurement time, epoch ms. */
  t: number
  fiveHourPct: number | null
  fiveHourResetsAt: number | null
  sevenDayPct: number | null
}

export function usageHistoryPath(agentId: string, storeDir: string = STORE_DIR): string {
  return join(storeDir, 'rate-limit-status', `history-${agentId}.jsonl`)
}

function lastSample(path: string): UsageHistorySample | null {
  try {
    const lines = readFileSync(path, 'utf8').trimEnd().split('\n')
    return JSON.parse(lines[lines.length - 1]) as UsageHistorySample
  } catch { return null }
}

export function shouldAppend(prev: UsageHistorySample | null, next: UsageHistorySample): boolean {
  if (!prev) return true
  if (next.t - prev.t >= USAGE_HISTORY_HEARTBEAT_MS) return true
  return prev.fiveHourPct !== next.fiveHourPct
    || prev.fiveHourResetsAt !== next.fiveHourResetsAt
    || prev.sevenDayPct !== next.sevenDayPct
}

/** Appends the sample if it carries news; rotates to `<path>.1` past the size cap. Never throws. */
export function appendUsageSample(path: string, sample: UsageHistorySample, maxBytes: number = USAGE_HISTORY_MAX_BYTES): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true })
    if (!shouldAppend(lastSample(path), sample)) return false
    if (existsSync(path) && statSync(path).size >= maxBytes) renameSync(path, `${path}.1`)
    appendFileSync(path, JSON.stringify(sample) + '\n', { mode: 0o600 })
    return true
  } catch { return false }
}

export function readUsageHistory(path: string): UsageHistorySample[] {
  const out: UsageHistorySample[] = []
  for (const f of [`${path}.1`, path]) {
    let text = ''
    try { text = readFileSync(f, 'utf8') } catch { continue }
    for (const line of text.split('\n')) {
      if (!line) continue
      try { out.push(JSON.parse(line) as UsageHistorySample) } catch { /* torn tail line */ }
    }
  }
  return out
}

/**
 * Tokens per 1% of the 5-hour frame, from the history and a token ledger: for each step where the
 * percentage rose inside one window, the tokens spent in that interval divided by the percentage points
 * gained; the median over the steps is returned. null when there is not enough data (fewer than
 * `minSteps` rises) -- the caller keeps its fixed fallback then.
 */
export function tokensPerPercent(
  history: UsageHistorySample[],
  tokensBetween: (fromMs: number, toMs: number) => number,
  minSteps = 5,
): number | null {
  const ratios: number[] = []
  for (let i = 1; i < history.length; i++) {
    const a = history[i - 1], b = history[i]
    if (a.fiveHourPct === null || b.fiveHourPct === null) continue
    if (a.fiveHourResetsAt !== b.fiveHourResetsAt) continue
    const gained = b.fiveHourPct - a.fiveHourPct
    if (gained <= 0) continue
    const tokens = tokensBetween(a.t, b.t)
    if (tokens > 0) ratios.push(tokens / gained)
  }
  if (ratios.length < minSteps) return null
  ratios.sort((x, y) => x - y)
  const mid = Math.floor(ratios.length / 2)
  return Math.round(ratios.length % 2 ? ratios[mid] : (ratios[mid - 1] + ratios[mid]) / 2)
}
