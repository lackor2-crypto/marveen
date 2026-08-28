// Boss, 2026-08-24: "Ha hibat talal akkor viszont a jovahagyas menupontban
// tudjam kiosztani a javitast majd valamelyik agensre!!! ... ha kivalasztok egy
// agenst akkor tudjam meg pluszban kijelolni azt is hogy vizsgalat, vagy
// javitas. ... Es ott abban a listaban remelem lathato a vscode ugynok is!"
//
// Three properties are guarded here, each of which fails SILENTLY if it breaks:
//  * a dispatch that names no mode stays a read-only review (an older tab or a
//    copied curl line must not accidentally hand out write permission);
//  * the fix prompt drops the read-only wording and carries the landing policy;
//  * `code:<alias>` is recognised as a VS Code executor everywhere it has to be
//    -- including the stale-verification sweep, which would otherwise declare
//    every code-bridge row "this agent no longer exists" ten minutes in.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PROJECT_ROOT } from '../config.js'
import {
  parseVerificationMode, buildVerificationPrompt, FIX_LANDING_POLICY,
  isCodeBridgeAgent, codeBridgeProjectOf, codeBridgeAgentId, CODE_AGENT_PREFIX,
  type VerificationPromptInput,
} from '../approval-verification-dispatch.js'

const BASE: Omit<VerificationPromptInput, 'mode'> = {
  approvalId: 'appr-1',
  category: 'marveen_selfdev',
  actionDescription: 'valami valtozas',
  agent: 'some-agent',
  ownerName: 'A tulajdonos',
  tokenPath: '/somewhere/store/.dashboard-token',
  baseUrl: 'http://localhost:1234',
}

describe('verification mode parsing', () => {
  it("defaults to 'verify' when the field is missing entirely", () => {
    expect(parseVerificationMode(undefined)).toBe('verify')
  })

  it("defaults to 'verify' for null, empty and unknown values -- never throws", () => {
    for (const raw of [null, '', 'VERIFY', 'repair', 'Fix', 0, 1, true, {}, []]) {
      expect(parseVerificationMode(raw)).toBe('verify')
    }
  })

  it("accepts exactly the string 'fix'", () => {
    expect(parseVerificationMode('fix')).toBe('fix')
  })
})

describe('the fix prompt is a different job from the review prompt', () => {
  const verify = buildVerificationPrompt({ ...BASE, mode: 'verify' })
  const fix = buildVerificationPrompt({ ...BASE, mode: 'fix' })

  it('the review prompt keeps the read-only limit', () => {
    expect(verify).toContain('CSAK-OLVASO ELLENORZES')
    expect(verify).toContain('POST/PUT/PATCH/DELETE')
  })

  it('the fix prompt does NOT claim to be read-only -- it is allowed to write code', () => {
    expect(fix).not.toContain('CSAK-OLVASO')
    expect(fix).toContain('JAVITASI FELADAT')
  })

  it('the fix prompt still forbids touching live state', () => {
    expect(fix).toContain('jelszo-')
    expect(fix).toContain('szolgaltatas-ujrainditas')
  })

  it('the fix prompt demands the full suite and typecheck before reporting pass', () => {
    expect(fix).toContain('npx vitest run')
    expect(fix).toContain('npx tsc --noEmit')
  })

  it('the fix prompt carries the landing policy verbatim, from the one constant', () => {
    for (const line of FIX_LANDING_POLICY) expect(fix).toContain(line)
  })

  it('the landing policy currently says: prepare it, do NOT merge to main', () => {
    // If the owner decides otherwise, THIS is the assertion that should change
    // -- together with the constant, and nothing else.
    const text = FIX_LANDING_POLICY.join(' ')
    expect(text).toContain('NE merge-eld')
    expect(text).toContain('amig a tulajdonos ra nem bolint')
  })

  it('both prompts report through the same endpoint, under the dispatched id', () => {
    for (const p of [verify, fix]) {
      expect(p).toContain('/api/approvals/appr-1/verify-result')
      expect(p).toContain('"agent":"some-agent"')
      // The port comes from config, never hardcoded.
      expect(p).toContain('http://localhost:1234')
      expect(p).not.toContain('localhost:3420')
    }
  })
})

describe('addressing a VS Code executor', () => {
  it('round-trips a project alias through the code: prefix', () => {
    expect(codeBridgeAgentId('tradingbot')).toBe('code:tradingbot')
    expect(codeBridgeProjectOf('code:tradingbot')).toBe('tradingbot')
    expect(isCodeBridgeAgent('code:tradingbot')).toBe(true)
  })

  it('a plain fleet agent is not mistaken for one', () => {
    for (const name of ['lackor3', 'some-agent', 'code', 'code:', 'codebase']) {
      expect(isCodeBridgeAgent(name)).toBe(false)
      expect(codeBridgeProjectOf(name)).toBeNull()
    }
  })

  it('the prefix is unambiguous: normalizeAlias strips colons out of aliases', () => {
    // The guarantee this prefix rests on. If the alias sanitiser ever starts
    // allowing ':' this test is where it gets caught.
    const store = readFileSync(join(PROJECT_ROOT, 'src', 'web', 'code-bridge-store.ts'), 'utf-8')
    expect(store).toContain('.replace(/[^a-z0-9_-]+/g, \'\')')
    expect(CODE_AGENT_PREFIX).toBe('code:')
  })
})

describe('the route and the sweep both know about code: targets', () => {
  const ROUTE = readFileSync(join(PROJECT_ROOT, 'src', 'web', 'routes', 'approvals.ts'), 'utf-8')
  const SWEEP = readFileSync(join(PROJECT_ROOT, 'src', 'web', 'verification-sweep-job.ts'), 'utf-8')

  it('the dispatch route queues a code task instead of an inter-agent message', () => {
    expect(ROUTE).toContain('codeBridgeProjectOf(agent)')
    expect(ROUTE).toContain('enqueueCodeTask(')
    // The pending row must exist for the code path too, or the page would show
    // nothing at all for a dispatched VS Code task.
    expect(ROUTE).toContain('createOrResetApprovalVerification(approvalId, agent, mode)')
  })

  it('the route stores the mode it was asked for', () => {
    expect(ROUTE).toContain('parseVerificationMode(body.mode)')
  })

  it('the sweep does not call a code: row a deleted agent', () => {
    // agentDir()/existsSync on 'code:<alias>' is always false -- without this
    // branch every VS Code row would be closed as 'noresponse:agent_gone'.
    expect(SWEEP).toContain('codeBridgeProjectOf(agent)')
    expect(SWEEP).toContain('getCodeSession(codeProject) !== null')
  })

  it('the sweep does not re-queue a code task as a nudge', () => {
    // Re-queueing would make the executor apply the same fix a second time.
    expect(SWEEP).toContain("if (codeBridgeProjectOf(row.agent) !== null) {")
    expect(SWEEP).toContain('return false')
  })
})
