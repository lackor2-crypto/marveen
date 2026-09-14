import { describe, it, expect } from 'vitest'
import { resolveKanbanDispatchTarget } from '../kanban-dispatch.js'

const base = {
  ownerName: 'Gábor',
  botName: 'GorcsevIvan',
  mainAgentId: 'gorcsevivan',
  agentNames: ['tuskohopkins', 'sentinel'],
  isRunning: (n: string) => n === 'tuskohopkins', // only tuskohopkins is "running"
}

describe('resolveKanbanDispatchTarget', () => {
  it('returns null for empty / null / undefined / whitespace assignee', () => {
    expect(resolveKanbanDispatchTarget(null, base)).toBeNull()
    expect(resolveKanbanDispatchTarget(undefined, base)).toBeNull()
    expect(resolveKanbanDispatchTarget('', base)).toBeNull()
    expect(resolveKanbanDispatchTarget('   ', base)).toBeNull()
  })

  it('never dispatches to the human owner', () => {
    expect(resolveKanbanDispatchTarget('Gábor', base)).toBeNull()
  })

  it('maps the bot display name to the main agent id', () => {
    expect(resolveKanbanDispatchTarget('GorcsevIvan', base)).toBe('gorcsevivan')
  })

  it('maps the canonical main agent id to itself', () => {
    expect(resolveKanbanDispatchTarget('gorcsevivan', base)).toBe('gorcsevivan')
  })

  it('matches the bot/main case-insensitively', () => {
    expect(resolveKanbanDispatchTarget('gorcsevIVAN', base)).toBe('gorcsevivan')
    expect(resolveKanbanDispatchTarget('GORCSEVIVAN', base)).toBe('gorcsevivan')
  })

  it('dispatches to a sub-agent only when its session is running', () => {
    expect(resolveKanbanDispatchTarget('tuskohopkins', base)).toBe('tuskohopkins')
    expect(resolveKanbanDispatchTarget('sentinel', base)).toBeNull() // not running -> silent no-op
  })

  it('matches sub-agent names case-insensitively', () => {
    expect(resolveKanbanDispatchTarget('TuskoHopkins', base)).toBe('tuskohopkins')
  })

  it('returns null for an unknown assignee name', () => {
    expect(resolveKanbanDispatchTarget('SomebodyElse', base)).toBeNull()
  })

  // --- capability gate (Boss 2026-09-14: awake is not able) ---

  it('does NOT dispatch to a running-but-quota-blocked sub-agent (treated like stopped)', () => {
    const opts = { ...base, isBlocked: (n: string) => n === 'tuskohopkins' }
    expect(resolveKanbanDispatchTarget('tuskohopkins', opts)).toBeNull()
  })

  it('still dispatches to a running, NOT-blocked sub-agent', () => {
    const opts = { ...base, isBlocked: (n: string) => n === 'sentinel' }
    expect(resolveKanbanDispatchTarget('tuskohopkins', opts)).toBe('tuskohopkins')
  })

  it('does NOT dispatch a card to the main agent when it is quota-blocked', () => {
    const opts = { ...base, isBlocked: (n: string) => n === 'gorcsevivan' }
    expect(resolveKanbanDispatchTarget('GorcsevIvan', opts)).toBeNull()
    expect(resolveKanbanDispatchTarget('gorcsevivan', opts)).toBeNull()
  })

  it('absent isBlocked keeps the pre-existing running-only behaviour (fresh install: no snapshot)', () => {
    // base has no isBlocked -> nothing is treated as blocked.
    expect(resolveKanbanDispatchTarget('tuskohopkins', base)).toBe('tuskohopkins')
    expect(resolveKanbanDispatchTarget('GorcsevIvan', base)).toBe('gorcsevivan')
  })
})
