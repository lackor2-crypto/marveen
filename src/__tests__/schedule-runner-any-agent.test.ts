import { describe, expect, it, beforeEach, vi } from 'vitest'

// "Any awake agent runs it" -- the fix for scheduled tasks being stranded when
// one specific agent (historically the main agent, Marvin) is down.
//
// Root cause (Boss, 2026-08-25): every scheduled task defaulted its `agent` to
// MAIN_AGENT_ID and the dispatcher only ever woke that one agent, so a task was
// bound to Marvin and did nothing when Marvin was down even though other agents
// were awake. The fix adds an 'any' target mode. Because the scheduler is a
// single centralized loop, choosing ONE target in resolveScheduledTargets IS
// the de-dup: no two agents are dispatched the same occurrence.

const mockState = vi.hoisted(() => ({
  running: new Set<string>(),
  agents: [] as string[],
  blocked: new Set<string>(),
}))

vi.mock('../web/agent-process.js', async (orig) => {
  const actual = await orig<typeof import('../web/agent-process.js')>()
  return { ...actual, isAgentRunning: (n: string) => mockState.running.has(n) }
})

vi.mock('../web/agent-config.js', async (orig) => {
  const actual = await orig<typeof import('../web/agent-config.js')>()
  return { ...actual, listAgentNames: () => mockState.agents }
})

// isAgentQuotaBlocked is the capability gate added after the 2026-09-14 loss:
// 'any' must skip an agent that is awake but at its usage wall. Override just
// that predicate; the pure pickAnyTarget/firstWorkingAgent stay real.
vi.mock('../web/agent-availability.js', async (orig) => {
  const actual = await orig<typeof import('../web/agent-availability.js')>()
  return { ...actual, isAgentQuotaBlocked: (n: string) => mockState.blocked.has(n) }
})

import { resolveScheduledTargets } from '../web/schedule-runner.js'
import { MAIN_AGENT_ID } from '../config.js'

describe('resolveScheduledTargets', () => {
  beforeEach(() => {
    mockState.running = new Set<string>()
    mockState.agents = ['lackor3', 'usalackor', 'lagunas']
    mockState.blocked = new Set<string>()
  })

  it('a specific agent stays pinned to exactly that agent', () => {
    expect(resolveScheduledTargets('usalackor')).toEqual(['usalackor'])
    // Pinning holds even when the pinned agent is not running (attemptFireTask
    // then cold-starts it) -- a pinned task must not silently jump agents.
    mockState.running = new Set(['lackor3'])
    expect(resolveScheduledTargets('usalackor')).toEqual(['usalackor'])
  })

  it("'all' broadcasts to the main agent plus every RUNNING sub-agent", () => {
    mockState.running = new Set(['lackor3', 'lagunas'])
    expect(resolveScheduledTargets('all')).toEqual([MAIN_AGENT_ID, 'lackor3', 'lagunas'])
  })

  it("'any' prefers the main agent when it is awake", () => {
    mockState.running = new Set([MAIN_AGENT_ID, 'lackor3'])
    expect(resolveScheduledTargets('any')).toEqual([MAIN_AGENT_ID])
  })

  it("'any' falls over to a running sub-agent when the main agent is DOWN", () => {
    // This is the exact scenario Boss hit: Marvin down, lackor3 awake -> lackor3
    // runs it, and it is the ONLY target (no duplicate send).
    mockState.running = new Set(['lackor3', 'lagunas'])
    const targets = resolveScheduledTargets('any')
    expect(targets).toEqual(['lackor3'])
    expect(targets).toHaveLength(1)
  })

  it("'any' picks sub-agents in listAgentNames() order (deterministic)", () => {
    mockState.running = new Set(['lagunas', 'usalackor']) // lackor3 down
    expect(resolveScheduledTargets('any')).toEqual(['usalackor'])
  })

  it("'any' with NOBODY awake falls back to the main agent (cold-start, late beats never)", () => {
    mockState.running = new Set<string>()
    expect(resolveScheduledTargets('any')).toEqual([MAIN_AGENT_ID])
  })

  it('an empty/undefined agent is treated as "any", NOT pinned to the main agent', () => {
    mockState.running = new Set(['lackor3'])
    expect(resolveScheduledTargets(undefined)).toEqual(['lackor3'])
    expect(resolveScheduledTargets('')).toEqual(['lackor3'])
  })

  // --- capability-aware selection (the 2026-09-14 fix) ---

  it("'any' skips an awake but quota-blocked agent and picks a working one", () => {
    // The exact loss: main down, lackor3 awake but at its weekly wall. Old code
    // picked lackor3 (awake) and the prompt fired into a session that could
    // never run it. Now it rolls to the next agent that can actually work.
    mockState.running = new Set(['lackor3', 'usalackor'])
    mockState.blocked = new Set(['lackor3'])
    expect(resolveScheduledTargets('any')).toEqual(['usalackor'])
  })

  it("'any' skips the main agent when IT is quota-blocked, preferring a working sub", () => {
    mockState.running = new Set([MAIN_AGENT_ID, 'lackor3'])
    mockState.blocked = new Set([MAIN_AGENT_ID])
    expect(resolveScheduledTargets('any')).toEqual(['lackor3'])
  })

  it("'any' with EVERY awake agent quota-blocked falls back to the first awake one (queue re-routes when one frees)", () => {
    // No agent can work right now: rather than drop the task, pin it to an awake
    // agent so the never-abandon retry queue keeps trying and re-routes the
    // moment any agent's quota resets. Late beats never.
    mockState.running = new Set(['lackor3', 'usalackor'])
    mockState.blocked = new Set(['lackor3', 'usalackor'])
    expect(resolveScheduledTargets('any')).toEqual(['lackor3'])
  })
})
