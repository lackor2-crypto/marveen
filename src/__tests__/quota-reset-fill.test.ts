// Card #545: a spent 5-hour window keeps its reset time on the Overview row.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fillFiveHourFromAvailability } from '../web/quota-reset-fill.js'
import type { AgentAvailability } from '../availability-transitions.js'

const NOW = 1_760_000_000_000
const av = (o: Partial<AgentAvailability> = {}): AgentAvailability => ({
  agent: 'usalackor', available: false, reason: 'quota', since: NOW - 3_600_000, resetsAt: NOW + 9_600_000, measuredAt: NOW, ...o,
})
const acc = (o: Record<string, number | null> = {}) => ({
  fiveHourPct: null as number | null, fiveHourResetsAt: null as number | null,
  sevenDayPct: 40 as number | null, sevenDayResetsAt: (NOW + 5 * 86_400_000) as number | null, ...o,
})

describe('five-hour reset on an exhausted account (#545)', () => {
  it('fills the missing 5-hour window from the watcher: 100% and its reset', () => {
    const r = fillFiveHourFromAvailability(acc(), av(), NOW)
    expect(r.filled).toBe(true)
    expect(r.account).toMatchObject({ fiveHourPct: 100, fiveHourResetsAt: NOW + 9_600_000 })
  })

  it('keeps a measured percentage and only adds the missing reset', () => {
    const r = fillFiveHourFromAvailability(acc({ fiveHourPct: 100 }), av(), NOW)
    expect(r.account.fiveHourPct).toBe(100)
    expect(r.account.fiveHourResetsAt).toBe(NOW + 9_600_000)
  })

  it('does not touch a row that already has its reset in the future', () => {
    const own = acc({ fiveHourPct: 30, fiveHourResetsAt: NOW + 1_000_000 })
    expect(fillFiveHourFromAvailability(own, av(), NOW)).toEqual({ account: own, filled: false })
  })

  it('does not borrow the weekly reset for the 5-hour row', () => {
    const weekly = acc({ sevenDayResetsAt: NOW + 9_600_000 + 30_000 })
    expect(fillFiveHourFromAvailability(weekly, av(), NOW).filled).toBe(false)
  })

  it('does not borrow a reset more than 5 hours away even when the weekly reset is missing from the reading', () => {
    const noWeekly = acc({ sevenDayResetsAt: null, sevenDayPct: null })
    expect(fillFiveHourFromAvailability(noWeekly, av({ resetsAt: NOW + 3 * 86_400_000 }), NOW).filled).toBe(false)
    expect(fillFiveHourFromAvailability(noWeekly, av({ resetsAt: NOW + 5 * 3_600_000 }), NOW).filled).toBe(true)
  })

  it('an agent that is available, stopped, or has no known/late reset gets nothing invented', () => {
    for (const a of [av({ available: true, reason: 'ok', resetsAt: null }), av({ reason: 'stopped' }), av({ resetsAt: null }), av({ resetsAt: NOW - 1 }), undefined]) {
      expect(fillFiveHourFromAvailability(acc(), a, NOW).filled).toBe(false)
    }
  })
})

describe('Overview row wiring (#545)', () => {
  const app = readFileSync(join(__dirname, '..', '..', 'web', 'app.js'), 'utf8')
  const route = readFileSync(join(__dirname, '..', 'web', 'routes', 'overview.ts'), 'utf8')
  it('the endpoint answers with the filled accounts', () => {
    expect(route).toContain('fillFiveHourFromAvailability(acc, availabilityById.get(acc.id))')
    expect(route).toContain('claudeAccounts: claudeAccountsOut')
  })
  it('the row shows clock + time left, and says so when the reset cannot be read', () => {
    expect(app).toContain('fmtResetClock(resetsAt)')
    expect(app.indexOf('fmtResetIn(resetsAt))} · ${escapeHtml(fmtResetClock(resetsAt))')).toBeGreaterThan(0)
    expect(app).toContain("t('overview.ratelimit.reset_unknown')")
    expect(app).toContain("'overview.ratelimit.no_data_reset'")
  })
})
