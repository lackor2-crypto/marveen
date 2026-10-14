// The objection board and the adaptive stop of a review debate (#597, phase 2). Pure functions, no model.
import { describe, it, expect } from 'vitest'
import { BUILTIN_MODES, parseObjections, parseReplies } from '../debate-modes.js'
import {
  buildObjectionBoard, summarizeBoard, maxObjectionNumber, stopAdvice, roundsLeft, boardForPrompt, conformityWarning, MIN_REASON_CHARS, type BoardRound,
} from '../debate-board.js'

const critic = (text: string) => ({ role: 'critic' as const, ok: true, ...(text.startsWith('NO') ? { noObjections: true } : { objections: parseObjections(text) }) })
const defender = (text: string) => ({ role: 'defender' as const, ok: true, replies: parseReplies(text) })
const obj = (id: string, quote = `idezet ${id}`, kind = 'accuracy') => `${id} [${kind}]\nQUOTE: "${quote}"\nOBJECTION: baj van ${id}-vel`
const rep = (id: string, verdict: string, rewrite = '') => `${id}: ${verdict}\nREASON: indok ${id}${rewrite ? `\nREWRITE: ${rewrite}` : ''}`

function round(n: number, c: string, d?: string): BoardRound {
  return { round: n, responses: [critic(c), ...(d !== undefined ? [defender(d)] : [])] }
}

describe('a kifogas-tabla', () => {
  it('egy kor: minden kifogas egy sor, a vedo valasza szerinti allapottal es a felajanlott szoveggel', () => {
    const b = buildObjectionBoard([round(1, [obj('K1'), obj('K2', 'masik', 'missing'), obj('K3')].join('\n\n'),
      [rep('K1', 'ACCEPT', 'uj K1'), rep('K2', 'PARTIAL', 'uj K2'), rep('K3', 'REJECT')].join('\n\n'))])
    expect(b.map(i => [i.id, i.status])).toEqual([['K1', 'accepted'], ['K2', 'partial'], ['K3', 'rejected']])
    expect(b[0]).toMatchObject({ kind: 'accuracy', quote: 'idezet K1', rewrite: 'uj K1', raisedIn: 1 })
    expect(b[1].kind).toBe('missing')
    expect(b[2].rewrite).toBe('')
    expect(summarizeBoard(b)).toEqual({ total: 3, accepted: 1, partial: 1, rejected: 1, withdrawn: 0, open: 0 })
  })

  it('ha a vedo nem valaszolt a kifogasra, az nyitott', () => {
    const b = buildObjectionBoard([round(1, [obj('K1'), obj('K2')].join('\n\n'), rep('K1', 'ACCEPT', 'x'))])
    expect(b.map(i => i.status)).toEqual(['accepted', 'open'])
  })

  it('a kotekedo a kovetkezo korben nem ismetli meg az elutasitottat: visszavontnak szamit; az elfogadott elfogadott marad', () => {
    const r1 = round(1, [obj('K1'), obj('K2')].join('\n\n'), [rep('K1', 'REJECT'), rep('K2', 'ACCEPT', 'uj')].join('\n\n'))
    const r2 = round(2, obj('K3'), rep('K3', 'ACCEPT', 'uj3'))
    const b = buildObjectionBoard([r1, r2])
    expect(b.map(i => [i.id, i.status])).toEqual([['K1', 'withdrawn'], ['K2', 'accepted'], ['K3', 'accepted']])
  })

  it('ha a kotekedo megismetli az elutasitottat, az elutasitott marad (vita), az ujabb valasz szamit', () => {
    const r1 = round(1, obj('K1'), rep('K1', 'REJECT'))
    const r2 = round(2, obj('K1', 'idezet K1 ujra'), rep('K1', 'ACCEPT', 'mar igaz'))
    const b = buildObjectionBoard([r1, r2])
    expect(b[0]).toMatchObject({ id: 'K1', status: 'accepted', quote: 'idezet K1 ujra', rewrite: 'mar igaz', raisedIn: 1, lastRaisedIn: 2 })
    expect(b[0].steps.map(s => s.verdict)).toEqual(['reject', 'accept'])
    // ismetelt kifogas, amire meg nincs valasz: nyitott
    expect(buildObjectionBoard([r1, { round: 2, responses: [critic(obj('K1'))] }])[0].status).toBe('open')
  })

  it('az ujrafogalmazas idezet nelkul is megtartja az eredeti idezetet', () => {
    const r1 = round(1, obj('K1', 'eredeti'), rep('K1', 'REJECT'))
    const r2 = round(2, 'K1 [accuracy]\nOBJECTION: meg mindig', rep('K1', 'REJECT'))
    expect(buildObjectionBoard([r1, r2])[0]).toMatchObject({ quote: 'eredeti', text: 'meg mindig' })
  })

  it('"nincs kifogas" kor: a korabbi, elutasitott kifogasok visszavontak', () => {
    const r1 = round(1, obj('K1'), rep('K1', 'REJECT'))
    const r2 = round(2, 'NO OBJECTIONS')
    expect(buildObjectionBoard([r1, r2])[0].status).toBe('withdrawn')
  })

  it('olvashatatlan valasz (nincs verdict) nyitott; sikertelen modell nem szamit; peer vita ures tabla', () => {
    const b = buildObjectionBoard([{ round: 1, responses: [critic(obj('K1')), { role: 'defender', ok: true, replies: [{ id: 'K1', verdict: null, reason: 'hmm', rewrite: '' }] }] }])
    expect(b[0].status).toBe('open')
    expect(buildObjectionBoard([{ round: 1, responses: [{ role: 'critic', ok: false }] }])).toEqual([])
    expect(buildObjectionBoard([{ round: 1, responses: [{ ok: true }, { ok: true }] }])).toEqual([])
  })

  it('a sorrend szam szerinti (K2 elobb, mint K10), a legnagyobb hasznalt szam kiolvashato', () => {
    const rs = [round(1, [obj('K10'), obj('K2')].join('\n\n'), rep('K2', 'ACCEPT', 'x'))]
    expect(buildObjectionBoard(rs).map(i => i.id)).toEqual(['K2', 'K10'])
    expect(maxObjectionNumber(rs)).toBe(10)
    expect(maxObjectionNumber([])).toBe(0)
  })

  it('a lezarashoz szoveget ad: allapot, idezet, kifogas, a vedo valasza, a felajanlott szoveg', () => {
    const t = boardForPrompt(buildObjectionBoard([round(1, obj('K1'), rep('K1', 'ACCEPT', 'uj szoveg'))]))
    expect(t).toContain('K1 [accuracy] -- status: accepted')
    expect(t).toContain('Quote: "idezet K1"')
    expect(t).toContain('Defender (round 1): ACCEPT -- indok K1')
    expect(t).toContain('Offered wording: uj szoveg')
    expect(boardForPrompt([])).toBe('')
  })
})

describe('az adaptiv leallas', () => {
  const critic6 = BUILTIN_MODES.critic

  it('a peer modban nincs tanacs', () => {
    expect(stopAdvice(BUILTIN_MODES.peer, [round(1, 'NO OBJECTIONS')])).toEqual({ stop: false })
    expect(stopAdvice(critic6, [])).toEqual({ stop: false })
  })

  it('"nincs kifogas" -> allj meg', () => {
    expect(stopAdvice(critic6, [round(1, 'NO OBJECTIONS')])).toEqual({ stop: true, reason: 'no_objections' })
  })

  it('minden kifogast elfogadott a vedo -> lezart; ha akar egy is elutasitott, mehet tovabb', () => {
    expect(stopAdvice(critic6, [round(1, [obj('K1'), obj('K2')].join('\n\n'), [rep('K1', 'ACCEPT', 'a'), rep('K2', 'ACCEPT', 'b')].join('\n\n'))]))
      .toEqual({ stop: true, reason: 'all_settled' })
    expect(stopAdvice(critic6, [round(1, [obj('K1'), obj('K2')].join('\n\n'), [rep('K1', 'ACCEPT', 'a'), rep('K2', 'REJECT')].join('\n\n'))]))
      .toEqual({ stop: false })
  })

  it('ugyanaz a kifogas ugyanazzal a valasszal kerul vissza -> korbenforgas', () => {
    const r1 = round(1, obj('K1'), rep('K1', 'REJECT'))
    const r2 = round(2, obj('K1'), rep('K1', 'REJECT'))
    expect(stopAdvice(critic6, [r1, r2])).toEqual({ stop: true, reason: 'stalled' })
  })

  it('uj kifogas vagy mas valasz = van elorelepes, nem korbenforgas', () => {
    const r1 = round(1, obj('K1'), rep('K1', 'REJECT'))
    expect(stopAdvice(critic6, [r1, round(2, [obj('K1'), obj('K2')].join('\n\n'), [rep('K1', 'REJECT'), rep('K2', 'REJECT')].join('\n\n'))])).toEqual({ stop: false })
    expect(stopAdvice(critic6, [r1, round(2, obj('K1'), rep('K1', 'PARTIAL', 'x'))])).toEqual({ stop: false })
  })

  it('a mod korhatara: az utolso megengedett kor utan allj meg', () => {
    const mode = { ...critic6, maxRounds: 2 }
    const r1 = round(1, obj('K1'), rep('K1', 'REJECT'))
    const r2 = round(2, [obj('K1'), obj('K2')].join('\n\n'), [rep('K1', 'PARTIAL', 'x'), rep('K2', 'REJECT')].join('\n\n'))
    expect(stopAdvice(mode, [r1])).toEqual({ stop: false })
    expect(stopAdvice(mode, [r1, r2])).toEqual({ stop: true, reason: 'round_limit' })
    expect(roundsLeft(mode, 1)).toBe(1)
    expect(roundsLeft(mode, 5)).toBe(0)
    expect(roundsLeft(BUILTIN_MODES.peer, 5)).toBeNull()
  })
})

describe('gyanus egyetertes (conformity)', () => {
  const bare = (id: string, v = 'ACCEPT', reason = 'ok') => `${id}: ${v}\nREASON: ${reason}`
  const long = 'a hatarido tenyleg 15 nap, ahogy a torveny irja'

  it('legalabb ket kifogas, mind elfogadva, mind indoklas nelkul (rovid) -> gyanus, a kor szamaval', () => {
    const r = round(2, [obj('K1'), obj('K2')].join('\n\n'), [bare('K1'), bare('K2', 'ACCEPT', 'igaz')].join('\n\n'))
    expect(conformityWarning([r])).toEqual({ suspicious: true, round: 2, count: 2 })
  })

  it('egyetlen elfogadott kifogas meg nem minta; egy elutasitas vagy egy indokolt valasz feloldja', () => {
    expect(conformityWarning([round(1, obj('K1'), bare('K1'))])).toEqual({ suspicious: false })
    expect(conformityWarning([round(1, [obj('K1'), obj('K2')].join('\n\n'), [bare('K1'), bare('K2', 'REJECT')].join('\n\n'))])).toEqual({ suspicious: false })
    expect(conformityWarning([round(1, [obj('K1'), obj('K2')].join('\n\n'), [bare('K1'), bare('K2', 'ACCEPT', long)].join('\n\n'))])).toEqual({ suspicious: false })
    expect(long.length).toBeGreaterThanOrEqual(MIN_REASON_CHARS)
  })

  it('a legutobbi kort nezi, amelyben a vedo valaszolt; kifogas nelkuli kor, vagy ures lista nem gyanus', () => {
    const early = round(1, [obj('K1'), obj('K2')].join('\n\n'), [bare('K1'), bare('K2')].join('\n\n'))
    const calm = round(2, [obj('K1'), obj('K2')].join('\n\n'), [bare('K1', 'REJECT', long), bare('K2', 'PARTIAL', long)].join('\n\n'))
    expect(conformityWarning([early, calm])).toEqual({ suspicious: false })
    expect(conformityWarning([calm, early])).toEqual({ suspicious: false })
    expect(conformityWarning([{ round: 1, responses: [{ role: 'critic', ok: true, noObjections: true }] }])).toEqual({ suspicious: false })
    expect(conformityWarning([])).toEqual({ suspicious: false })
  })
})
