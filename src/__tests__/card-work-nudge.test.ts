// #461 phase 2b: the open-card nudge's pure decisions.
import { describe, expect, it } from 'vitest'
import {
  CARD_NUDGE_AGENT_PER_HOUR, CARD_NUDGE_BACKOFF_MS, CARD_NUDGE_FIRST_MS, CARD_NUDGE_MAX,
  cardDue, cardNudgeMessage, planCardNudges, pruneState,
  type AgentWork, type CardNudgeFacts, type NudgeCard,
} from '../card-work-nudge.js'

const NOW = 1_800_000_000_000
const card = (over: Partial<NudgeCard> = {}): NudgeCard => ({
  seq: 461, id: 'c1', title: 'Valami', updatedAt: Math.floor((NOW - CARD_NUDGE_FIRST_MS - 1000) / 1000), agent: 'a1', hasOpenChildren: false, ...over,
})
const facts = (over: Partial<CardNudgeFacts> & { act?: AgentWork } = {}): CardNudgeFacts => ({
  now: NOW, canWork: () => true, activity: async () => over.act ?? 'idle', hasUndelivered: () => false, ...over,
})

describe('cardDue', () => {
  it('not before the first quiet period, due after it', () => {
    expect(cardDue(card({ updatedAt: Math.floor(NOW / 1000) - 60 }), undefined, NOW)).toBe(false)
    expect(cardDue(card(), undefined, NOW)).toBe(true)
  })
  it('a parent with open sub-cards is never nudged (the children are the work)', () => {
    expect(cardDue(card({ hasOpenChildren: true }), undefined, NOW)).toBe(false)
  })
  it('backs off between reminders and stops at the cap', () => {
    const c = card()
    const e = (count: number, ago: number) => ({ count, lastAt: NOW - ago, cardUpdatedAt: c.updatedAt })
    expect(cardDue(c, e(1, CARD_NUDGE_BACKOFF_MS[1]! - 1), NOW)).toBe(false)
    expect(cardDue(c, e(1, CARD_NUDGE_BACKOFF_MS[1]!), NOW)).toBe(true)
    expect(cardDue(c, e(CARD_NUDGE_MAX, 10 * 3600_000), NOW)).toBe(false)
  })
  it('a change on the card resets the count', () => {
    const c = card()
    expect(cardDue(c, { count: CARD_NUDGE_MAX, lastAt: NOW - 3600_000, cardUpdatedAt: c.updatedAt - 500 }, NOW)).toBe(true)
  })
})

describe('planCardNudges', () => {
  it('nudges an idle agent that can work, records the reminder', async () => {
    const r = await planCardNudges([card()], {}, facts())
    expect(r.nudges).toHaveLength(1)
    expect(r.nudges[0]).toMatchObject({ agent: 'a1', nth: 1 })
    expect(r.state.c1).toMatchObject({ count: 1, lastAt: NOW })
  })
  it('does not nudge a busy or unreadable agent, nor one that cannot work', async () => {
    expect((await planCardNudges([card()], {}, facts({ act: 'busy' }))).nudges).toEqual([])
    expect((await planCardNudges([card()], {}, facts({ act: 'unknown' }))).nudges).toEqual([])
    expect((await planCardNudges([card()], {}, facts({ canWork: () => false }))).nudges).toEqual([])
  })
  it('does not stack on an undelivered message', async () => {
    expect((await planCardNudges([card()], {}, facts({ hasUndelivered: () => true }))).nudges).toEqual([])
  })
  it('one message per agent for all its due cards; the pane is probed once', async () => {
    let probes = 0
    const f = facts({ activity: async () => { probes++; return 'idle' } })
    const r = await planCardNudges([card(), card({ id: 'c2', seq: 462 })], {}, f)
    expect(r.nudges).toHaveLength(1)
    expect(r.nudges[0]!.cards).toHaveLength(2)
    expect(probes).toBe(1)
  })
  it('the per-agent hourly ceiling holds whatever the cards', async () => {
    const r = await planCardNudges([card()], {}, facts(), { a1: CARD_NUDGE_AGENT_PER_HOUR })
    expect(r.nudges).toEqual([])
  })
  it('state of cards that are no longer open is dropped', () => {
    expect(pruneState({ gone: { count: 2, lastAt: 1, cardUpdatedAt: 1 }, c1: { count: 1, lastAt: 1, cardUpdatedAt: 1 } }, new Set(['c1']))).toEqual({ c1: { count: 1, lastAt: 1, cardUpdatedAt: 1 } })
  })
})

describe('cardNudgeMessage', () => {
  it('names the card by number, says how to finish and is capped in the text', () => {
    const m = cardNudgeMessage({ agent: 'a1', nth: 2, cards: [card()] })
    expect(m).toContain('#461')
    expect(m).toContain('waiting')
    expect(m).toContain('2. emlekezteto')
  })
})
