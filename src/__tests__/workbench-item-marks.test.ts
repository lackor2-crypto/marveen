// #825: sent mark + deadline levels for the Workbench tree.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dueLevel, daysUntil } from '../workbench-item-marks.js'

describe('deadline levels (#825)', () => {
  it('past is overdue, today is today, 1-7 days is soon, later is calm', () => {
    expect(dueLevel(-1)).toBe('overdue')
    expect(dueLevel(0)).toBe('today')
    expect(dueLevel(1)).toBe('soon')
    expect(dueLevel(7)).toBe('soon')
    expect(dueLevel(8)).toBe('later')
  })
  it('counts whole local calendar days and rejects a bad date', () => {
    const now = new Date(2026, 10, 1, 23, 59)
    expect(daysUntil('2026-11-01', now)).toBe(0)
    expect(daysUntil('2026-11-04', now)).toBe(3)
    expect(daysUntil('2026-10-30', now)).toBe(-2)
    expect(daysUntil('nope', now)).toBeNull()
  })
})

describe('tree draws the marks (#825, source contract)', () => {
  const js = readFileSync('web/workbench.js', 'utf8')
  it('a work item leaves the tree only when finalized AND sent', () => {
    expect(js).toMatch(/function itHidden\(it\) \{ return hideOn && it\.status === 'done' && markOf\(it\.id\)\.sent \}/)
  })
  it('every row has the circle, the item head has the banner, the trigger row says answered', () => {
    expect(js).toContain('sentMarkHtml(it) + workSeqHtml(it)')
    expect(js).toContain('+ sentBannerHtml(it)')
    expect(js).toContain('workbench.sent.trigger_answered')
  })
  it('both languages carry the keys', () => {
    for (const f of ['web/lang/hu.js', 'web/lang/en.js']) {
      const s = readFileSync(f, 'utf8')
      for (const k of ['sent.yes', 'sent.no', 'sent.banner', 'sent.trigger_answered', 'due.overdue', 'due.today', 'due.in']) expect(s).toContain('"workbench.' + k + '"')
    }
  })
})
