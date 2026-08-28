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
const CSS = readFileSync(join(__dirname, '../../web/style.css'), 'utf-8')

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

describe('usage-limit widget: reading the rows', () => {
  it('resets are shown as time REMAINING, with the clock time only as a tooltip', () => {
    // "visszaall 4:30" made Boss work out whether that meant tonight or the day
    // after; what the row has to answer is how long the wait is.
    expect(APP).toContain('const fmtResetIn = (ms) =>')
    expect(APP).toMatch(/title="\$\{escapeHtml\(fmtResetAt\(resetsAt\)\)\}">\$\{escapeHtml\(fmtResetIn\(resetsAt\)\)\}/)
    for (const lang of [HU, EN]) {
      for (const key of ['in_days_hours', 'in_days', 'in_hours_mins', 'in_hours', 'in_mins', 'resets_now']) {
        expect(lang).toContain(`'overview.ratelimit.${key}'`)
      }
    }
  })

  // The ticker's BODY, not the whole file: an assertion that names one exact
  // spelling of a guard breaks on a rewrite that keeps the behaviour intact --
  // which is what happened on 2026-08-27, when the re-fetch was added and the
  // guard became an early return. What has to hold is the property.
  const tickerBody = (): string => {
    const start = APP.indexOf('_rateLimitTicker = setInterval(')
    expect(start, 'the usage-limit ticker is gone').toBeGreaterThan(-1)
    const end = APP.indexOf('}, 60_000)', start)
    expect(end, 'the ticker no longer runs on a 60s cadence').toBeGreaterThan(start)
    return APP.slice(start, end)
  }

  it('the countdown is redrawn on a timer -- the overview only fetches on open', () => {
    const tick = tickerBody()
    // Bail out when there is nothing to draw or nobody looking...
    expect(tick, 'the tick no longer checks document.hidden').toMatch(/document\.hidden/)
    expect(tick, 'the tick no longer checks for a snapshot').toMatch(/_rateLimitLast/)
    // ...otherwise redraw from the snapshot already in hand, with no network.
    expect(tick).toContain('renderOverviewRateLimit(_rateLimitLast.rateLimit')
  })

  it('a stale number is RE-FETCHED, not just redrawn', () => {
    // Boss, 2026-08-27 (msg 579): the widget sat on a 2-hour-old 15% while a
    // live session on the same account showed 45%. A redraw cannot fix a stale
    // number -- only a re-fetch can. Both halves are guarded: that the tick
    // fetches at all, and that it only does so while the Overview is open (a
    // background page must not keep polling).
    const tick = tickerBody()
    expect(tick, 'the tick never re-fetches -- a frozen percentage stays frozen')
      .toContain("fetch('/api/overview')")
    expect(tick, 'the re-fetch is not limited to the open Overview page')
      .toMatch(/location\.hash[\s\S]{0,120}overview/)
  })

  it('a rule separates the accounts (and the OpenRouter row) from each other', () => {
    expect(CSS).toMatch(/\.overview-ratelimit-bars > \* \+ \* \{[^}]*border-top/)
  })
})

describe('usage-limit widget: server payload', () => {
  it('the main account reports staleness like the other accounts do', () => {
    // 2026-08-15: measuredAt, not updatedAt. The statusline rewrites the file
    // on every render tick but only refreshes the percentages when Claude
    // actually reported them, so updatedAt made an hours-old reading look
    // fresh forever. See rate-limit-measured-at.test.ts.
    expect(OVERVIEW).toContain('stale: rlSnapshot ? isStale(rlSnapshot.measuredAt, Date.now()) : false')
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
