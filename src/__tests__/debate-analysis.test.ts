// The debate analysis (#597, phase 6): per mode and model pair. Pure: it works on rebuilt sessions.
import { describe, it, expect } from 'vitest'
import { analyzeDebates, MIN_DEBATES_FOR_COMPARISON } from '../debate-analysis.js'
import { summarizeBoard } from '../debate-board.js'

function item(status: string): any { return { id: 'K1', status } }

function review(over: Record<string, unknown> = {}, statuses: string[] = ['accepted', 'accepted', 'rejected']): any {
  const board = statuses.map(item)
  return {
    id: 's', project: 'p1', mode: 'critic', modeName: null, models: ['a/crit', 'b/def'], concluded: true, consensus: true,
    rounds: [{ round: 1, prompt: 'q', responses: [
      { model: 'a/crit', ok: true, role: 'critic', tokensIn: 1000, tokensOut: 500 },
      { model: 'b/def', ok: true, role: 'defender', tokensIn: 2000, tokensOut: 700 },
    ] }],
    board, boardSummary: summarizeBoard(board), ...over,
  }
}

function peer(over: Record<string, unknown> = {}): any {
  return {
    id: 'q', project: 'p1', mode: 'peer', modeName: null, models: ['z/two', 'a/one'], concluded: false, consensus: null,
    rounds: [{ round: 1, prompt: 'q', responses: [{ model: 'z/two', ok: true, tokensIn: 10, tokensOut: 20 }, { model: 'a/one', ok: true }] }, { round: 2, prompt: '', responses: [] }],
    board: [], boardSummary: null, ...over,
  }
}

describe('analyzeDebates', () => {
  it('ures naplo: nincs sor, a vegosszegek nullak', () => {
    expect(analyzeDebates([])).toEqual({ rows: [], totals: { debates: 0, concluded: 0, objections: 0, accepted: 0, tokensIn: 0, tokensOut: 0 } })
  })

  it('ugyanaz a mod es a (kotekedo, vedo) par egy sor: szamolja a vitakat, kifogasokat, elfogadottakat, egyetertest, tokent', () => {
    const r = analyzeDebates([review(), review({ consensus: false }, ['partial', 'open'])])
    expect(r.rows).toHaveLength(1)
    expect(r.rows[0]).toMatchObject({
      mode: 'critic', roleMode: true, first: 'a/crit', second: 'b/def', debates: 2, concluded: 2, agreed: 1, rounds: 2,
      objections: 5, accepted: 3, rejected: 1, open: 1, tokensIn: 6000, tokensOut: 2400,
    })
    expect(r.rows[0].acceptRate).toBeCloseTo(0.6)
    expect(r.totals).toMatchObject({ debates: 2, objections: 5, accepted: 3 })
  })

  it('a reszben elfogadott is elfogadottnak szamit; a szerepek rendje szamit (kotekedo != vedo)', () => {
    const swapped = review({ models: ['b/def', 'a/crit'] }, ['partial'])
    const r = analyzeDebates([review({}, ['accepted']), swapped])
    expect(r.rows).toHaveLength(2)
    expect(r.rows.map(x => [x.first, x.accepted])).toEqual(expect.arrayContaining([['a/crit', 1], ['b/def', 1]]))
  })

  it('egyenrangu vita: a par beturendben egy sor; kifogas nincs, az arany null; lezaratlan vita nem szamit lezartnak', () => {
    const r = analyzeDebates([peer(), peer({ models: ['a/one', 'z/two'], concluded: true, consensus: true })])
    expect(r.rows).toHaveLength(1)
    expect(r.rows[0]).toMatchObject({ roleMode: false, first: 'a/one', second: 'z/two', debates: 2, concluded: 1, agreed: 1, objections: 0, acceptRate: null })
  })

  it('kulonbozo mod = kulon sor; a legtobb elfogadott van legfelul', () => {
    const r = analyzeDebates([review({}, ['accepted']), review({ mode: 'premortem' }, ['accepted', 'accepted', 'partial'])])
    expect(r.rows.map(x => [x.mode, x.accepted])).toEqual([['premortem', 3], ['critic', 1]])
  })

  it('"kevés adat": a hatar alatt jelolt, a hataron mar nem', () => {
    const few = analyzeDebates(Array.from({ length: MIN_DEBATES_FOR_COMPARISON - 1 }, () => review()))
    expect(few.rows[0].enoughData).toBe(false)
    const enough = analyzeDebates(Array.from({ length: MIN_DEBATES_FOR_COMPARISON }, () => review()))
    expect(enough.rows[0].enoughData).toBe(true)
  })

  it('projekt-szuro: egy projekt, "none" = projekt nelkuli, nincs szuro = mind', () => {
    const list = [review({ project: 'p1' }), review({ project: 'p2' }), review({ project: null })]
    expect(analyzeDebates(list, 'p1').totals.debates).toBe(1)
    expect(analyzeDebates(list, 'none').totals.debates).toBe(1)
    expect(analyzeDebates(list, null).totals.debates).toBe(3)
    expect(analyzeDebates(list, 'nincs-ilyen').rows).toEqual([])
  })

  it('hianyzo token / hianyzo tabla nem dob', () => {
    const odd = review({ boardSummary: null })
    odd.rounds[0].responses[0].tokensIn = undefined
    const r = analyzeDebates([odd])
    expect(r.rows[0]).toMatchObject({ objections: 0, acceptRate: null, tokensIn: 2000 })
  })
})
