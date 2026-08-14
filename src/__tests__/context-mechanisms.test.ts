import { describe, it, expect } from 'vitest'
import {
  AUTOCOMPACT_MIN_TOKENS,
  GATE_MIN_TOKENS,
  clampGateTokens,
  effectiveAutocompactTokens,
  findMechanismIssues,
  isMechanismStateValid,
  maxGateTokensFor,
  type MechanismState,
} from '../context-mechanisms.js'

// The state this install was actually in on 2026-08-14, before any of it was
// fixed. Every test below is anchored to a number that was really there.
const LIVE_BEFORE = { autocompact: 100_000, gates: { 'lackor2-bot': 50_000, gypsy: 80_000, lackor3: 100_000, usalackor: 200_000 } }

const base: MechanismState = {
  gateEnabled: true,
  gateTokens: 120_000,
  autocompactTokens: 250_000,
  brokerDesignated: false,
  brokerCleanStart: false,
}

describe('where autocompact actually fires', () => {
  it('is well below the setting, which is the whole trap', () => {
    // 100000 in .env did not mean "compact at 100k". It meant ~69k.
    expect(effectiveAutocompactTokens(100_000)).toBe(69_000)
    expect(effectiveAutocompactTokens(250_000)).toBe(172_500)
  })

  it('leaves the gate real headroom below it', () => {
    expect(maxGateTokensFor(250_000)).toBe(146_625)
    expect(maxGateTokensFor(250_000)).toBeLessThan(effectiveAutocompactTokens(250_000))
  })
})

describe('findMechanismIssues reproduces the live breakage', () => {
  // The model has to agree with what was measured, or it is decoration. Three
  // of the four agents had a gate that could never fire; the fourth, the only
  // one set below where the CLI fired, is also the only one whose gate worked.
  it.each(Object.entries(LIVE_BEFORE.gates))('%s at %d tokens', (_name, gateTokens) => {
    const issues = findMechanismIssues({
      ...base, gateTokens, autocompactTokens: LIVE_BEFORE.autocompact,
    })
    const blocked = issues.some((i) => i.severity === 'error' && i.messageKey === 'ctx.issue.gate_above_cli')
    expect(blocked).toBe(gateTokens > maxGateTokensFor(LIVE_BEFORE.autocompact))
  })

  it('accepts the values approved on 2026-08-14', () => {
    expect(findMechanismIssues(base)).toEqual([])
    expect(isMechanismStateValid(base)).toBe(true)
  })

  it('names the gate, not the CLI, as the control to change', () => {
    const [issue] = findMechanismIssues({ ...base, gateTokens: 200_000, autocompactTokens: 100_000 })
    expect(issue.mechanism).toBe('gate')
    expect(issue.severity).toBe('error')
    expect(issue.params).toMatchObject({ gateK: 200, firesK: 69 })
  })
})

describe('the cheap-but-wasteful combinations warn rather than block', () => {
  // His money, his call -- but he was never shown the trade before.
  it('warns on a gate low enough to cost more than it saves', () => {
    const issues = findMechanismIssues({ ...base, gateTokens: 20_000 })
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({ severity: 'warning', messageKey: 'ctx.issue.gate_too_low' })
    expect(isMechanismStateValid({ ...base, gateTokens: 20_000 })).toBe(true)
  })

  it('warns that turning the gate off leaves only the blunt mechanism', () => {
    const issues = findMechanismIssues({ ...base, gateEnabled: false })
    expect(issues).toEqual([{
      mechanism: 'gate', severity: 'warning', messageKey: 'ctx.issue.gate_off', params: { firesK: 173 },
    }])
  })

  it('says nothing about the gate threshold while the gate is off', () => {
    // An absurd number that is simply not in effect is not a problem to report.
    const issues = findMechanismIssues({ ...base, gateEnabled: false, gateTokens: 900_000 })
    expect(issues.map((i) => i.messageKey)).toEqual(['ctx.issue.gate_off'])
  })
})

describe('the context generator', () => {
  it('is compatible with every compaction mechanism', () => {
    // It distributes work; it does not compact. Nothing to collide with.
    expect(findMechanismIssues({ ...base, brokerDesignated: true })).toEqual([])
  })

  it('refuses to wipe itself', () => {
    const issues = findMechanismIssues({ ...base, brokerDesignated: true, brokerCleanStart: true })
    expect(issues).toEqual([{
      mechanism: 'broker', severity: 'error', messageKey: 'ctx.issue.clean_start_on_broker', params: {},
    }])
    expect(isMechanismStateValid({ ...base, brokerDesignated: true, brokerCleanStart: true })).toBe(false)
  })

  it('allows clean start on the agents that RECEIVE the work', () => {
    expect(findMechanismIssues({ ...base, brokerCleanStart: true })).toEqual([])
  })
})

describe('clampGateTokens offers a working number instead of only refusing', () => {
  it('pulls an impossible threshold down under the CLI', () => {
    expect(clampGateTokens(200_000, 100_000)).toBe(maxGateTokensFor(100_000))
  })

  it('pulls a pointless one up to the floor', () => {
    expect(clampGateTokens(5_000, 250_000)).toBe(GATE_MIN_TOKENS)
  })

  it('leaves a sane threshold alone', () => {
    expect(clampGateTokens(120_000, 250_000)).toBe(120_000)
  })

  // The floor wins on a conflict: at the CLI's own minimum there is no band at
  // all (100k fires at 69k, leaving 58k -- above the 30k floor, but only just).
  // Whatever the inputs, the result must never exceed the floor's promise.
  it('never returns something below the floor', () => {
    for (const cli of [AUTOCOMPACT_MIN_TOKENS, 250_000, 1_000_000]) {
      expect(clampGateTokens(1, cli)).toBeGreaterThanOrEqual(GATE_MIN_TOKENS)
    }
  })
})
