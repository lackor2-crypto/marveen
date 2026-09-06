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
  descriptionMentionsCardId,
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

  it('the landing policy currently says: land it yourself, but only on a green suite', () => {
    // Boss, 2026-08-28, asked and answered the same day: free rein. If the
    // policy changes again, THIS is the assertion that changes with the
    // constant -- and nothing else, apart from the user-facing sentence below.
    const text = FIX_LANDING_POLICY.join(' ')
    expect(text).toContain('szabad kezed van')
    expect(text).toContain('LANDOLD a fo agba')
    expect(text).toContain('nem kell review-ra varnod')
  })

  it('does not hand out the permission without the condition that carries it', () => {
    // "Land it yourself" is only safe BECAUSE the suite has to be green first.
    // A future edit that keeps the permission and drops the gate is the failure
    // this asserts against -- both halves live in the same prompt.
    const fix = buildVerificationPrompt({ ...BASE, mode: 'fix' })
    expect(fix).toContain('szabad kezed van')
    expect(fix).toContain('npx vitest run')
    expect(fix).toContain('npx tsc --noEmit')
    expect(FIX_LANDING_POLICY.join(' ')).toContain('NE landolj')
  })

  it('the sentence shown to the user says the same thing as the policy', () => {
    // The picker promises the user what the agent will do. A policy flip that
    // leaves the old promise on screen is worse than no promise: the user would
    // approve a dispatch expecting it NOT to merge.
    const hu = readFileSync(join(PROJECT_ROOT, 'web', 'lang', 'hu.js'), 'utf-8')
    const en = readFileSync(join(PROJECT_ROOT, 'web', 'lang', 'en.js'), 'utf-8')
    const huHint = /'approvals\.verify\.mode_fix_hint':\s*'([^']*)'/.exec(hu)?.[1] ?? ''
    const enHint = /'approvals\.verify\.mode_fix_hint':\s*'([^']*)'/.exec(en)?.[1] ?? ''
    expect(huHint).not.toContain('nem olvasztja be a főágba')
    expect(huHint).toContain('be is olvasztja a főágba')
    expect(enHint).not.toContain('does not merge into the main branch')
    expect(enHint).toContain('merges into the main branch')
    // And both still say what happens when it is NOT green.
    expect(huHint).toContain('elbukik')
    expect(enHint).toContain('fails')
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

// ---------------------------------------------------------------------------
// A kanban id is not a commit -- measured 2026-09-06 (approval c8cd45ce)
// ---------------------------------------------------------------------------
//
// An approval read "Kártya: ... (11da9dcb) -- várakozóba került". A verifying
// agent searched the main branch and every other branch for commit `11da9dcb`,
// found nothing, and reported FAIL: "a commit NEM létezik". It was a kanban
// card id (#223); the work had been on main for hours under a different
// commit. The code was fine -- the sentence was, and a whole review round plus
// a fix dispatch went into a false failure.
//
// Two halves, and BOTH are needed: the prompt tells the reader what the number
// is, and the sentence that carries the number says it too (that half is
// guarded in approvals-waiting-auto-raise.test.ts).
describe('the prompt says what the 8-hex identifier IS', () => {
  const withCard = { ...BASE, actionDescription: 'Kártya #223 (kanban-azonosító: 11da9dcb, nem git commit): valami' }

  it('names it a kanban card id and forbids reporting the missing commit as a defect', () => {
    for (const mode of ['verify', 'fix'] as const) {
      const p = buildVerificationPrompt({ ...withCard, mode })
      expect(p, `${mode} prompt`).toContain('KANBAN-KARTYA azonosito, NEM git commit')
      expect(p, `${mode} prompt`).toMatch(/NEM hiba/)
    }
  })

  it('says WHERE the commit can be found instead, rather than leaving a dead end', () => {
    const p = buildVerificationPrompt({ ...withCard, mode: 'verify' })
    expect(p).toContain('git log --grep')
    expect(p).toContain('/api/kanban')
    // "Nem talalod" is a report, never a guess -- same rule as everywhere else.
    expect(p).toContain('ne talalgasd')
  })

  it('stays out of prompts whose description carries no such token', () => {
    // Keyed off the description, not the category: an unconditional paragraph
    // would be noise in every prompt that never had the problem.
    const p = buildVerificationPrompt({ ...BASE, mode: 'verify' })
    expect(p).not.toContain('KANBAN-KARTYA azonosito')
  })

  it('the detector reads the description, and an empty one is not a match', () => {
    expect(descriptionMentionsCardId('Kártya (11da9dcb) kész')).toBe(true)
    expect(descriptionMentionsCardId('11DA9DCB')).toBe(true)
    expect(descriptionMentionsCardId('nincs benne azonosito')).toBe(false)
    // A missing description must not throw -- it reaches here straight from a DB row.
    expect(descriptionMentionsCardId('')).toBe(false)
    expect(descriptionMentionsCardId(undefined as unknown as string)).toBe(false)
  })
})
