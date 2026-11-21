// #956 (Boss TG 7172): the scheduler injected "memoria-heartbeat" into the SIGNED-OUT agent lackor3, and the in-flight
// watchdog alerted 30 minutes later ("lehetseges beakadas"). A signed-out agent cannot run anything: it is skipped like
// one at its usage wall, and nothing is alerted about it.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const mockState = vi.hoisted(() => ({
  running: new Set<string>(),
  agents: [] as string[],
  signedOut: new Set<string>(),
}))

vi.mock('../web/agent-process.js', async (orig) => {
  const actual = await orig<typeof import('../web/agent-process.js')>()
  return { ...actual, isAgentRunning: (n: string) => mockState.running.has(n) }
})
vi.mock('../web/agent-config.js', async (orig) => {
  const actual = await orig<typeof import('../web/agent-config.js')>()
  return { ...actual, listAgentNames: () => mockState.agents }
})
vi.mock('../web/agent-availability-watch.js', async (orig) => {
  const actual = await orig<typeof import('../web/agent-availability-watch.js')>()
  return { ...actual, isAgentSignedOut: (n: string) => mockState.signedOut.has(n) }
})

import { resolveScheduledTargets } from '../web/schedule-runner.js'
import { signedOutAgents } from '../web/agent-availability-watch.js'
import { MAIN_AGENT_ID } from '../config.js'

describe('scheduler and a signed-out agent (#956)', () => {
  beforeEach(() => {
    mockState.running = new Set([MAIN_AGENT_ID, 'lackor3', 'usalackor'])
    mockState.agents = ['lackor3', 'usalackor']
    mockState.signedOut = new Set(['lackor3'])
  })

  it('a task pinned to a signed-out agent goes to a working one', () => {
    expect(resolveScheduledTargets('lackor3')).toEqual([MAIN_AGENT_ID])
  })

  it("'any' skips a signed-out agent, 'all' leaves it out", () => {
    mockState.running = new Set(['lackor3', 'usalackor']) // main agent down
    expect(resolveScheduledTargets('any')).toEqual(['usalackor'])
    mockState.running = new Set([MAIN_AGENT_ID, 'lackor3', 'usalackor'])
    expect(resolveScheduledTargets('all')).toEqual([MAIN_AGENT_ID, 'usalackor'])
  })

  it('nobody signed out: nothing changes', () => {
    mockState.signedOut = new Set()
    expect(resolveScheduledTargets('lackor3')).toEqual(['lackor3'])
  })

  it('signedOutAgents reads only the "signed_out" reason', () => {
    const mk = (reason: string) => ({ available: false, reason, since: 1, resetsAt: null, measuredAt: 1 })
    const set = signedOutAgents({ agents: { a: mk('signed_out'), b: mk('quota'), c: mk('stopped') } as any, notifiedAt: {} })
    expect([...set]).toEqual(['a'])
  })

  it('the in-flight watchdog never alerts for a signed-out agent (guard sits before the timeout decision)', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'web', 'schedule-runner.ts'), 'utf8')
    const guard = src.indexOf('if (isAgentSignedOut(entry.agentName, now))')
    const decide = src.indexOf('const decision = decideTaskTimeout(')
    expect(guard).toBeGreaterThan(0)
    expect(decide).toBeGreaterThan(guard)
    // the bare quota check is called in ONE place only: inside the isAgentUnableToWork wrapper
    expect(src.match(/isAgentQuotaBlocked\(/g)).toHaveLength(1)
  })
})
