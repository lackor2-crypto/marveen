// Keret-figyelo: a panelbol a LEGUTOLSO jelzes szamit (kanban #423, 2026-09-27).
//
// Mert eset: korai kereset-reset utan a gorgetesben bennmaradt limit-felirat
// 100%-on tartotta az 5 oras sort, mikozben a panel aljan allo statusline mar
// "5h 8%"-ot mutatott.
import { describe, it, expect } from 'vitest'
import { scrapeFreshUsage } from '../web/routes/overview.js'

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
})
