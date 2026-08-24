// A running agent whose every turn is rejected on a usage limit looked exactly
// like a healthy quiet one (Boss, 2026-08-24).
//
// The Segedmunkas (lackor3) hit the weekly wall at 07:49 and every turn after
// that got a <synthetic> reply that never reached the API. Those replies carry
// a usage object of all zeros, so the context reader found no number and said
// 'no-usage' -- which is ALSO what it says for a brand-new session. The card
// stayed green, the gate kept printing "context-tokens-unmeasurable", and for
// five hours nothing on the board said the agent could not work at all.
//
// The transcript states the cause outright: isApiErrorMessage, HTTP 429, and a
// quotaLimits block with status 'rejected' and the reset instant. So this is
// READ, never inferred from "the number is zero" -- the rule being that a zero
// always means two things and the code must ask the source which one.
//
// The entries below are the real shape taken off this install's transcript.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readContextReadingFromProjectDir } from '../web/active-model.js'
import { decideGate, normalizeGateConfig, type GateInputs } from '../context-restart-gate.js'

const RESETS_AT_SEC = 1787598000               // as written by the CLI: SECONDS
const RESETS_AT_MS = RESETS_AT_SEC * 1000

function quotaRejectedTurn(ts: string) {
  return {
    type: 'assistant',
    timestamp: ts,
    isApiErrorMessage: true,
    apiErrorStatus: 429,
    quotaLimits: {
      status: 'rejected',
      resetsAt: RESETS_AT_SEC,
      rateLimitType: 'seven_day',
      overageStatus: 'rejected',
    },
    message: {
      model: '<synthetic>',
      role: 'assistant',
      content: [{ type: 'text', text: "You've hit your weekly limit · resets 9pm (Europe/Budapest) · progress saved" }],
      usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  }
}

function healthyTurn(ts: string, cacheRead: number) {
  return {
    type: 'assistant',
    timestamp: ts,
    message: {
      model: 'claude-opus-4-8',
      role: 'assistant',
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 2, output_tokens: 40, cache_creation_input_tokens: 1000, cache_read_input_tokens: cacheRead },
    },
  }
}

let root: string
let configDir: string

/** Each case gets its OWN working dir. The reader memoises by
 *  (workingDir, configDir) for a few seconds, so sharing one directory made
 *  every later case read the first case's cached answer -- a test that passes
 *  or fails depending on which case ran first is worse than no test. */
function scenario(caseName: string, entries: unknown[]): string {
  const workingDir = join(root, 'agents', caseName)
  mkdirSync(workingDir, { recursive: true })
  const dir = join(configDir, 'projects', workingDir.replace(/[/.]/g, '-'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'session.jsonl'), entries.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8')
  return workingDir
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'ctx-quota-'))
  configDir = join(root, 'accounts', 'probe')
})
afterAll(() => { rmSync(root, { recursive: true, force: true }) })

describe('a quota-walled agent is not "unmeasurable"', () => {
  it('names the wall, the window and the reset instant in ms', () => {
    const workingDir = scenario('a', [
      { type: 'user', timestamp: '2026-08-24T07:49:00.000Z', message: { role: 'user', content: 'go' } },
      quotaRejectedTurn('2026-08-24T07:49:27.267Z'),
      quotaRejectedTurn('2026-08-24T08:42:25.822Z'),
      quotaRejectedTurn('2026-08-24T11:05:09.144Z'),
      // Metadata lines the CLI appends after the last real turn. The scan has
      // to walk past them; a reader that stopped at the tail would see nothing.
      { type: 'last-prompt', prompt: 'go' },
      { type: 'mode', mode: 'default' },
    ])
    const r = readContextReadingFromProjectDir(workingDir, configDir)
    expect(r.state).toBe('quota-blocked')
    expect(r.tokens).toBeNull()
    expect(r.quota?.resetsAt).toBe(RESETS_AT_MS)      // seconds -> ms, once
    expect(r.quota?.rateLimitType).toBe('seven_day')
    expect(r.quota?.message).toContain('weekly limit')
    expect(r.quota?.rejectedTurns).toBe(3)
  })

  it('a fresh session that simply has not run is still "fresh", not a wall', () => {
    const workingDir = scenario('b', [
      { type: 'user', timestamp: '2026-08-24T12:00:00.000Z', message: { role: 'user', content: 'hi' } },
    ])
    const r = readContextReadingFromProjectDir(workingDir, configDir)
    expect(r.state).toBe('fresh')
    expect(r.quota ?? null).toBeNull()
  })

  it('a measured session that is walled RIGHT NOW reports both facts', () => {
    const workingDir = scenario('c', [
      healthyTurn('2026-08-24T12:10:00.000Z', 184_000),
      quotaRejectedTurn('2026-08-24T12:20:00.000Z'),
    ])
    const r = readContextReadingFromProjectDir(workingDir, configDir)
    // The size is real and still worth showing; the wall is a separate fact.
    expect(r.state).toBe('measured')
    expect(r.tokens).toBe(185_002)
    expect(r.quota?.resetsAt).toBe(RESETS_AT_MS)
  })

  it('a wall the agent has since recovered from is NOT reported as current', () => {
    const workingDir = scenario('d', [
      quotaRejectedTurn('2026-08-24T07:49:27.267Z'),
      healthyTurn('2026-08-24T13:00:00.000Z', 50_000),
    ])
    const r = readContextReadingFromProjectDir(workingDir, configDir)
    expect(r.state).toBe('measured')
    expect(r.quota ?? null).toBeNull()
  })

  it('an API error that is not about quota is not dressed up as one', () => {
    const workingDir = scenario('e', [
      {
        type: 'assistant',
        timestamp: '2026-08-24T13:30:00.000Z',
        isApiErrorMessage: true,
        apiErrorStatus: 500,
        message: { model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: 'Internal server error' }], usage: { input_tokens: 0, output_tokens: 0 } },
      },
    ])
    const r = readContextReadingFromProjectDir(workingDir, configDir)
    // Still unmeasurable -- but sending the owner off to wait for a reset that
    // is not coming would be worse than saying nothing.
    expect(r.state).toBe('no-usage')
    expect(r.quota ?? null).toBeNull()
  })
})

describe('the gate reports a wall as a wall, not as a broken measurement', () => {
  const base: GateInputs = {
    nowMs: Date.UTC(2026, 7, 24, 12, 0, 0),
    contextTokens: null,
    contextState: 'quota-blocked',
    contextQuota: { resetsAt: RESETS_AT_MS, rateLimitType: 'seven_day' },
    paneState: 'idle',
    paneUsageLimited: false,
    paneLimitResetText: null,
    hardGuardPhase: null,
    pendingOutboundCount: 0,
    hasStaleOutbound: false,
    hasChildProcesses: false,
    hasOpenQuestion: false,
    hasLiveTaskState: false,
  } as unknown as GateInputs

  const cfg = normalizeGateConfig({ enabled: true, thresholdTokens: 120_000 })

  it('says WHY and WHEN, and never escalates to an alert', () => {
    const d = decideGate(base, cfg, null)
    expect(d.action).toBe('block')            // not 'block-alert': nothing broke
    expect(d.reason).toContain('quota-blocked')
    expect(d.reason).toContain('seven_day')
    expect(d.reason).toContain(new Date(RESETS_AT_MS).toISOString())
  })

  it('a genuinely unmeasurable reading keeps its own, different sentence', () => {
    const d = decideGate({ ...base, contextState: 'no-usage', contextQuota: null } as unknown as GateInputs, cfg, null)
    expect(d.reason).toContain('context-tokens-unmeasurable')
    expect(d.reason).not.toContain('quota-blocked')
  })
})
