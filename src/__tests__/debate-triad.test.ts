// The three-sided mode (#597, phase 7): the mode definition, the prompts of the second critic, the board and the
// export/analysis that know about it. The run itself (three model calls in order) is in debate-run.test.ts.
import { describe, it, expect } from 'vitest'
import {
  BUILTIN_MODES, isCriticRole, modelCountOf, modeSystemPrompt, buildModeRoundPrompt, readResponse, effectiveSwap, isRoleMode, TRIAD_ROLES, parseObjections, parseReplies,
} from '../debate-modes.js'
import { buildObjectionBoard, stopAdvice, summarizeBoard } from '../debate-board.js'
import { buildReport } from '../debate-export.js'
import { analyzeDebates } from '../debate-analysis.js'

const triad = BUILTIN_MODES.triad
const OBJ_A = 'K1 [accuracy]\nQUOTE: "30 nap"\nOBJECTION: x.'
const OBJ_B = 'K2 [legal]\nQUOTE: "hatarido"\nOBJECTION: y.'
const REP = 'K1: ACCEPT\nREASON: igaz es hosszu indok\nREWRITE: 15 nap\n\nK2: REJECT\nREASON: nem igaz'

describe('a beepitett haromoldalu mod', () => {
  it('harom modell, szerep-mod, nincs szerepcsere, a ket kotekedonek kulon szemszoge van', () => {
    expect(triad).toMatchObject({ id: 'triad', triad: true, sequential: true, builtin: true, swapRoles: false })
    expect(modelCountOf(triad)).toBe(3)
    expect(modelCountOf(BUILTIN_MODES.critic)).toBe(2)
    expect(modelCountOf(BUILTIN_MODES.peer)).toBe(2)
    expect(isRoleMode(triad)).toBe(true)
    expect(TRIAD_ROLES).toEqual(['critic', 'critic2', 'defender'])
    expect(effectiveSwap(triad, true)).toBe(false)
    expect(isCriticRole('critic2')).toBe(true)
    expect(isCriticRole('defender')).toBe(false)
    expect(isCriticRole(undefined)).toBe(false)
  })

  it('a rendszer-promptok: mindketto kotekedo a K-formatumot kapja + a sajat szemszoget + az erosseget; a vedo a ket kotekedorol szolo megjegyzest', () => {
    const a = modeSystemPrompt(triad, 'critic', 'hard')!
    const b = modeSystemPrompt(triad, 'critic2', 'mild')!
    const d = modeSystemPrompt(triad, 'defender')!
    for (const p of [a, b]) { expect(p).toContain('K<n> [accuracy|wording|missing|legal]'); expect(p).toContain('NO OBJECTIONS') }
    expect(a).toContain('careful EDITOR')
    expect(a).not.toContain('OPPOSING SIDE')
    expect(b).toContain('OPPOSING SIDE')
    expect(a).toContain('Strength: HARD')
    expect(b).toContain('Strength: MILD')
    expect(d).toContain('DEFENDER')
    expect(d).toContain('TWO critics')
  })

  it('a 2. kotekedo promptja: az elso szovege, "ne ismeteld", folytatolagos szamozas; az elsonek ilyen nincs', () => {
    const base = { head: 'H', round: 1, criticPrev: null, defenderPrev: null, criticNow: null, steer: '' }
    const second = buildModeRoundPrompt('critic2', { ...base, otherCritic: OBJ_A, usedUpTo: 4 })
    expect(second).toContain(OBJ_A)
    expect(second).toContain('Do not repeat them')
    expect(second).toContain('Number yours from K5')
    const nothing = buildModeRoundPrompt('critic2', { ...base, otherCritic: null, usedUpTo: 0 })
    expect(nothing).toContain('wrote no objections in this round')
    const first = buildModeRoundPrompt('critic', { ...base, usedUpTo: 0 })
    expect(first).not.toContain('other critic')
    const later = buildModeRoundPrompt('critic2', { ...base, round: 2, criticPrev: OBJ_B, defenderPrev: REP, otherCritic: OBJ_A, usedUpTo: 2 })
    expect(later).toContain(`Your objections in the previous round:\n${OBJ_B}`)
    expect(later).toContain('starting at K3')
    expect(later).toContain(OBJ_A)
  })

  it('a masodik kotekedo valaszat ugyanugy olvassa ki, mint az elsoet', () => {
    expect(readResponse('critic2', OBJ_B).objections).toEqual([{ id: 'K2', kind: 'legal', quote: 'hatarido', text: 'y.' }])
    expect(readResponse('critic2', 'NO OBJECTIONS\nx')).toEqual({ noObjections: true })
  })
})

describe('kifogas-tabla es tanacs ket kotekedovel', () => {
  const rounds = [{ round: 1, responses: [
    { ok: true, role: 'critic' as const, objections: parseObjections(OBJ_A) },
    { ok: true, role: 'critic2' as const, objections: parseObjections(OBJ_B) },
    { ok: true, role: 'defender' as const, replies: parseReplies(REP) },
  ] }]

  it('minden kifogas egy sor; a 2. kotekedo hozta a "by" jelolest kapja, az elso nem', () => {
    const board = buildObjectionBoard(rounds)
    expect(board.map(i => [i.id, i.status, i.by])).toEqual([['K1', 'accepted', null], ['K2', 'rejected', 'critic2']])
    expect(summarizeBoard(board)).toMatchObject({ total: 2, accepted: 1, rejected: 1 })
  })

  it('"nincs kifogas" tanacs csak ha MINDEN kotekedo ezt mondta; egy hibazo kotekedo nem szamit', () => {
    const none = (role: 'critic' | 'critic2') => ({ ok: true, role, noObjections: true })
    expect(stopAdvice(triad, [{ round: 1, responses: [none('critic'), none('critic2')] }])).toEqual({ stop: true, reason: 'no_objections' })
    expect(stopAdvice(triad, [{ round: 1, responses: [none('critic'), { ok: true, role: 'critic2', objections: parseObjections(OBJ_B) }] }]).reason).not.toBe('no_objections')
    expect(stopAdvice(triad, [{ round: 1, responses: [none('critic'), { ok: false, role: 'critic2' }] }])).toEqual({ stop: true, reason: 'no_objections' })
  })
})

describe('export es elemzes haromoldalu vitaval', () => {
  function state(): any {
    const rs = [{ round: 1, prompt: 'q', responses: [
      { model: 'a/ed', ok: true, role: 'critic', text: OBJ_A, objections: parseObjections(OBJ_A), tokensIn: 10, tokensOut: 5 },
      { model: 'b/opp', ok: true, role: 'critic2', text: OBJ_B, objections: parseObjections(OBJ_B), tokensIn: 10, tokensOut: 5 },
      { model: 'c/def', ok: true, role: 'defender', text: REP, replies: parseReplies(REP), tokensIn: 10, tokensOut: 5 },
    ] }]
    const board = buildObjectionBoard(rs)
    return { id: 's', project: 'p', mode: 'triad', modeName: null, strength: 'medium', swapRoles: false, judge: null, models: ['a/ed', 'b/opp', 'c/def'], question: 'q', attachments: [], rounds: rs, concluded: false, consensus: null, summary: null, summaryBy: null, orderCheck: null, board, boardSummary: summarizeBoard(board) }
  }

  it('jelentes: a harom modell a szerepevel, nincs szerepcsere-sor, a 2. kotekedo kifogasa jelolve', () => {
    const r = buildReport(state(), 'hu')
    const settings = r.sections[1].paragraphs
    expect(settings).toContain('Mód: Háromoldalú (két kötekedő, egy védő)')
    expect(settings).toContain('1. modell: a/ed (1. kötekedő: szerkesztői szemszög)')
    expect(settings).toContain('2. modell: b/opp (2. kötekedő: ellenfél szemszöge)')
    expect(settings).toContain('3. modell: c/def (védő)')
    expect(settings.join('|')).not.toContain('Szerepcsere')
    const board = r.sections.find(s => s.title === 'Kifogás-tábla')!.paragraphs
    expect(board).toContain('K2 [jogi kockázat] – elutasítva (vita tárgya) – a 2. kötekedő (ellenfél szemszöge) szerint')
    expect(board).toContain('K1 [pontosság] – elfogadva')
    const en = buildReport(state(), 'en', { full: true })
    expect(en.sections.at(-1)!.paragraphs).toContain('opp (critic 2)')
  })

  it('elemzes: a harom modell egy sor (kotekedo, kotekedo, vedo), es megszamolja, hany kifogas jott a 2. kotekedotol', () => {
    const rows = analyzeDebates([state()]).rows
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ mode: 'triad', first: 'a/ed', second: 'b/opp', third: 'c/def', objections: 2, accepted: 1, fromSecond: 1, tokensIn: 30 })
  })
})
