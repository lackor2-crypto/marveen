// #799: the 5h quota percentage had no history, so "tokens per 1%" could not be measured afterwards.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendUsageSample, readUsageHistory, shouldAppend, tokensPerPercent, usageHistoryPath,
  USAGE_HISTORY_HEARTBEAT_MS, type UsageHistorySample,
} from '../web/usage-history.js'
import { sampleMainLiveUsage } from '../web/live-usage-sampler.js'

let tmp = ''
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'usage-hist-')) })
afterEach(() => { rmSync(tmp, { recursive: true, force: true }) })

const s = (t: number, five: number | null, reset: number | null = 1000, seven: number | null = 10): UsageHistorySample =>
  ({ t, fiveHourPct: five, fiveHourResetsAt: reset, sevenDayPct: seven })

describe('append policy', () => {
  it('writes the first sample, skips an unchanged one, writes a moved one', () => {
    const p = join(tmp, 'a', 'h.jsonl') // directory does not exist yet: empty store
    expect(appendUsageSample(p, s(1, 3))).toBe(true)
    expect(appendUsageSample(p, s(60_000, 3))).toBe(false)
    expect(appendUsageSample(p, s(120_000, 4))).toBe(true)
    expect(readUsageHistory(p).map((x) => x.fiveHourPct)).toEqual([3, 4])
  })
  it('writes a heartbeat line when the last one is old, even if nothing moved', () => {
    expect(shouldAppend(s(0, 3), s(USAGE_HISTORY_HEARTBEAT_MS, 3))).toBe(true)
    expect(shouldAppend(s(0, 3), s(USAGE_HISTORY_HEARTBEAT_MS - 1, 3))).toBe(false)
  })
  it('treats a window reset as news', () => {
    expect(shouldAppend(s(0, 3, 1000), s(1, 3, 2000))).toBe(true)
  })
  it('rotates to .1 past the cap and still reads both, oldest first', () => {
    const p = join(tmp, 'h.jsonl')
    for (let i = 0; i < 30; i++) appendUsageSample(p, s(i * 1000, i), 400)
    expect(existsSync(`${p}.1`)).toBe(true)
    const all = readUsageHistory(p)
    const ts = all.map((x) => x.t)
    expect(ts).toEqual([...ts].sort((a, b) => a - b))
    expect(all[all.length - 1].fiveHourPct).toBe(29)
  })
  it('survives a torn last line', () => {
    const p = join(tmp, 'h.jsonl')
    appendUsageSample(p, s(1, 1))
    require('node:fs').appendFileSync(p, '{"t":2,"fiveHo')
    expect(readUsageHistory(p)).toHaveLength(1)
    expect(appendUsageSample(p, s(3, 2))).toBe(true)
  })
})

describe('tokensPerPercent', () => {
  const hist = [s(0, 0), s(10, 2), s(20, 5), s(30, 6), s(40, 8), s(50, 9)]
  it('is the median tokens per percentage point over the rises', () => {
    // 2000 tokens per interval: ratios 1000, 667, 2000, 1000, 2000 -> median 1000
    expect(tokensPerPercent(hist, () => 2000)).toBe(1000)
  })
  it('returns null (caller keeps its fixed fallback) with too few rises', () => {
    expect(tokensPerPercent(hist.slice(0, 3), () => 2000)).toBeNull()
    expect(tokensPerPercent([], () => 1)).toBeNull()
  })
  it('ignores steps across a window reset and steps without tokens', () => {
    const h = [s(0, 50, 1), s(10, 2, 2), s(20, 4, 2)]
    expect(tokensPerPercent(h, () => 100, 1)).toBe(50)
    expect(tokensPerPercent(h, () => 0, 1)).toBeNull()
  })
})

describe('sampler wiring', () => {
  const ok = { ok: true as const, usage: { fiveHour: { usedPct: 7, resetsAt: 5 }, sevenDay: { usedPct: 9, resetsAt: 6 }, measuredAt: 111 } }
  it('records the reading next to the live file', async () => {
    const hp = join(tmp, 'rate-limit-status', 'history-x.jsonl')
    await sampleMainLiveUsage({ token: () => 't', fetchUsage: async () => ok, write: () => {}, path: join(tmp, 'live.json'), historyPath: hp })
    expect(JSON.parse(readFileSync(hp, 'utf8').trim())).toEqual({ t: 111, fiveHourPct: 7, fiveHourResetsAt: 5, sevenDayPct: 9 })
  })
  it('writes no history when the writer is injected and no history path is given', async () => {
    await sampleMainLiveUsage({ token: () => 't', fetchUsage: async () => ok, write: () => {}, path: join(tmp, 'live.json') })
    expect(existsSync(usageHistoryPath('anyone', tmp))).toBe(false)
  })
})
