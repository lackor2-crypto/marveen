// Contract guard for the Keret-figyelo (usage-limit) widget, after two live
// complaints from Boss on 2026-08-10: an account row kept vanishing from the
// list ("az usalackor bejon, neha eltunik"), and the weekly window was missing
// entirely from the per-account view ("a heti szazalek valahogy onnan
// kimaradt").
//
// String-contract assertions in the house idiom (see approvals-ui-contract):
// the properties guarded here are about which rows the renderer is ALLOWED to
// drop, which no unit test of the pure logic can express.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP = readFileSync(join(__dirname, '../../web/app.js'), 'utf-8')
const OVERVIEW = readFileSync(join(__dirname, '../web/routes/overview.ts'), 'utf-8')
const HU = readFileSync(join(__dirname, '../../web/lang/hu.js'), 'utf-8')
const EN = readFileSync(join(__dirname, '../../web/lang/en.js'), 'utf-8')

describe('usage-limit widget: account rows', () => {
  it('every account shows BOTH windows, not just the 5-hour one', () => {
    expect(APP).toContain("windowBar('overview.ratelimit.five_hour', acc.fiveHourPct, acc.fiveHourResetsAt, acc.stale)")
    expect(APP).toContain("windowBar('overview.ratelimit.seven_day', acc.sevenDayPct, acc.sevenDayResetsAt, acc.stale)")
  })

  it('a missing percentage keeps its bar instead of deleting the row', () => {
    // The old renderer started with `if (acc.fiveHourPct === null) return ''`,
    // which is exactly how an account disappeared when its session went quiet.
    expect(APP).not.toMatch(/if \(acc\.fiveHourPct === null\) return ''/)
    expect(APP).toContain("t('overview.ratelimit.no_data')")
    for (const lang of [HU, EN]) expect(lang).toContain("'overview.ratelimit.no_data'")
  })

  it('which rows to draw follows the configured accounts, not the data', () => {
    expect(APP).toContain('accounts.map(accountBlock)')
    expect(APP).toMatch(/const anyAccountData = accounts\.some\(/)
  })
})

describe('usage-limit widget: server payload', () => {
  it('the main account reports staleness like the other accounts do', () => {
    expect(OVERVIEW).toContain('stale: rlSnapshot ? isStale(rlSnapshot.updatedAt, Date.now()) : false')
  })

  it('a plan falls back to an old snapshot rather than to no row at all', () => {
    // Order matters: fresh snapshot -> live pane scrape -> stale snapshot.
    const fresh = OVERVIEW.indexOf('if (snapFresh && snap.fiveHour?.usedPct != null)')
    const scrape = OVERVIEW.indexOf('const scraped = scrapeClaudeAccountUsage(plan.id)')
    const staleFallback = OVERVIEW.indexOf('fiveHourPct: snap?.fiveHour?.usedPct ?? null')
    expect(fresh).toBeGreaterThan(-1)
    expect(scrape).toBeGreaterThan(fresh)
    expect(staleFallback).toBeGreaterThan(scrape)
  })

  it('the label drops its hardcoded model once a live model is known', () => {
    // store/claude-plans.json still said "Usalackor (Opus 4.8)" while the
    // account was running Opus 5, and the row prints the live model anyway.
    expect(OVERVIEW).toContain('const accountLabel = (label: string, model: string | null) =>')
    expect(OVERVIEW).toContain("label: 'Lackor2',")
    expect(OVERVIEW).not.toContain('label: plan.label,')
  })
})
