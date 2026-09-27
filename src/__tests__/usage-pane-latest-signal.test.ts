// Keret-figyelo: a panelbol a LEGUTOLSO jelzes szamit (kanban #423, 2026-09-27).
//
// Mert eset: korai kereset-reset utan a gorgetesben bennmaradt limit-felirat
// 100%-on tartotta az 5 oras sort, mikozben a panel aljan allo statusline mar
// "5h 8%"-ot mutatott.
import { afterEach, describe, it, expect, vi } from 'vitest'
import { sanityCheckFiveHour, scrapeFreshUsage } from '../web/routes/overview.js'

describe('scrapeFreshUsage: a legutolso jelzes nyer (#423)', () => {
  it('regi limit-felirat, alatta friss statusline -> a statusline szama', () => {
    const pane = [
      "You've hit your session limit · resets 12pm",
      '...sok munka...',
      '  Opus 5.5 | Ctx 17% | 5h 8% | 7d 1%',
    ].join('\n')
    expect(scrapeFreshUsage(pane).usedPct).toBe(8)
  })

  it('a limit-felirat a legutolso -> 100%', () => {
    const pane = [
      '  Opus 5.5 | Ctx 17% | 5h 92% | 7d 40%',
      "You've hit your session limit · resets 12pm",
    ].join('\n')
    expect(scrapeFreshUsage(pane).usedPct).toBe(100)
  })

  it('a regi "used X%" sort is felulirja a kesobbi statusline', () => {
    const pane = "You've used 91% of your session limit\n  Opus 5.5 | 5h 3% | 7d 2%"
    expect(scrapeFreshUsage(pane).usedPct).toBe(3)
  })

  it('a heti limit-felirat nem mond semmit az 5 oras ablakrol', () => {
    expect(scrapeFreshUsage("You've hit your weekly limit").usedPct).toBeNull()
  })

  it('ures panel: nincs szam (nem nulla)', () => {
    expect(scrapeFreshUsage('').usedPct).toBeNull()
  })

  describe('a regi felirat reset-ideje nem tapad a friss szamra', () => {
    afterEach(() => { vi.useRealTimers() })
    const pane = [
      "You've hit your session limit · resets 12pm (Europe/Budapest)",
      '...sok munka...',
      '  Opus 5.5 | Ctx 17% | 5h 8% | 7d 1%',
    ].join('\n')

    // Measured failure: at 13:00 and 18:00 the old "12pm" rolled to tomorrow,
    // the sanity check dropped the 8% and the row disappeared.
    for (const at of ['2026-09-27T11:00:00Z', '2026-09-27T16:00:00Z']) {
      it(`a regi reset utan (${at}) a statusline szama megmarad, reset-ido nelkul`, () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date(at))
        const row = sanityCheckFiveHour(scrapeFreshUsage(pane), Date.now())
        expect(row.usedPct).toBe(8)
        expect(row.resetsAt).toBeNull()
      })
    }

    it('a regi reset elott (09:00) sem kapja meg a regi idot', () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-09-27T07:00:00Z'))
      expect(scrapeFreshUsage(pane).resetsAt).toBeNull()
    })

    it('ha a felirat a legutolso, a sajat reset-idejet tovabbra is olvassuk', () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-09-27T08:00:00Z'))
      const r = scrapeFreshUsage("  Opus 5.5 | 5h 92% | 7d 40%\nYou've hit your session limit · resets 12pm (Europe/Budapest)")
      expect(r.usedPct).toBe(100)
      expect(r.resetsAt).toBe(Date.parse('2026-09-27T10:00:00Z'))
    })
  })
})
