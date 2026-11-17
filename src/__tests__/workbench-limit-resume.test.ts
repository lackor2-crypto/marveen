import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  scheduleLimitResume, cancelLimitResume, listLimitResumes, hasLimitResume, limitResumeVerdict, tickLimitResumes,
  setLimitResumeFile, RETRY_SPACING_MS, PROBE_MS, MAX_AGE_MS, MAX_ATTEMPTS, type LimitResumeEntry,
} from '../workbench-agent/limit-resume.js'
import {
  continueBridgeTaskElsewhere, setBridgeContinuationHandler, setBridgeLimitWaitHandler, resetBridgeContinuationForTest,
} from '../workbench-agent/bridge-continuation.js'
import type { CodeTask } from '../web/code-bridge-store.js'
import { MESSAGES } from '../workbench-agent/messages.js'

// Boss, Workbench chat 2026-11-17: "amikor visszater az 5 oras keret, automatikusan tudd folytatni a felbemaradt
// munkat" -- a turn that ended on the usage limit with no other account used to stop for good.

const base = { key: 'p1:w1', projectId: 'p1', workItemId: 'w1', lang: 'hu' as const, actor: 'u', attempts: 0 }
const T0 = 1_000_000_000_000

beforeEach(() => setLimitResumeFile(null))

describe('limit resume store', () => {
  it('a limit-cut turn is remembered once per turn key, and cancelled by key', () => {
    expect(scheduleLimitResume(base, T0)).toBe(true)
    expect(scheduleLimitResume({ ...base, attempts: 1 }, T0 + 10)).toBe(true)
    expect(listLimitResumes()).toHaveLength(1)
    expect(listLimitResumes()[0].attempts).toBe(1)
    expect(listLimitResumes()[0].createdAt).toBe(T0)
    expect(hasLimitResume(base.key)).toBe(true)
    cancelLimitResume(base.key)
    expect(hasLimitResume(base.key)).toBe(false)
  })

  it('survives a restart (the file is the memory)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'limres-'))
    try {
      const f = join(dir, 'x.json')
      setLimitResumeFile(f)
      scheduleLimitResume(base, T0)
      setLimitResumeFile(f)
      expect(listLimitResumes().map((e) => e.key)).toEqual([base.key])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('stops scheduling after the attempt bound', () => {
    expect(scheduleLimitResume({ ...base, attempts: MAX_ATTEMPTS }, T0)).toBe(false)
    expect(listLimitResumes()).toHaveLength(0)
  })
})

describe('limitResumeVerdict', () => {
  const e = (extra: Partial<LimitResumeEntry> = {}): LimitResumeEntry => ({ ...base, createdAt: T0, notBefore: T0 + RETRY_SPACING_MS, scheduledAt: T0, ...extra })

  it('waits while the limit is on, runs the moment an account can work', () => {
    expect(limitResumeVerdict(e(), T0 + RETRY_SPACING_MS + 1, false, false)).toBe('wait')
    expect(limitResumeVerdict(e(), T0 + RETRY_SPACING_MS + 1, true, false)).toBe('run')
  })
  it('never before the spacing, and never while the turn already runs (the owner continued by hand)', () => {
    expect(limitResumeVerdict(e(), T0 + 1000, true, false)).toBe('wait')
    expect(limitResumeVerdict(e(), T0 + RETRY_SPACING_MS + 1, true, true)).toBe('wait')
  })
  it('an unreadable or stale account state cannot block the work for good: one real try per hour', () => {
    expect(limitResumeVerdict(e(), T0 + PROBE_MS - 1, false, false)).toBe('wait')
    expect(limitResumeVerdict(e(), T0 + PROBE_MS, false, false)).toBe('run')
  })
  it('gives up after the age bound', () => {
    expect(limitResumeVerdict(e(), T0 + MAX_AGE_MS + 1, true, false)).toBe('expired')
  })
})

describe('tickLimitResumes', () => {
  it('starts the due continuation once and removes it from the store', async () => {
    scheduleLimitResume(base, T0)
    const ran: string[] = []
    const deps = { canWork: () => true, isBusy: () => false, run: async (x: LimitResumeEntry) => { ran.push(x.key) }, expired: () => {} }
    expect(tickLimitResumes(deps, T0 + RETRY_SPACING_MS + 1)).toEqual([base.key])
    expect(tickLimitResumes(deps, T0 + RETRY_SPACING_MS + 2)).toEqual([])
    await Promise.resolve()
    expect(ran).toEqual([base.key])
    expect(hasLimitResume(base.key)).toBe(false)
  })
  it('an expired entry is dropped with a note, not run', () => {
    scheduleLimitResume(base, T0)
    const notes: string[] = []
    const deps = { canWork: () => true, isBusy: () => false, run: async () => { throw new Error('must not run') }, expired: (x: LimitResumeEntry) => { notes.push(x.key) } }
    expect(tickLimitResumes(deps, T0 + MAX_AGE_MS + 1)).toEqual([])
    expect(notes).toEqual([base.key])
    expect(hasLimitResume(base.key)).toBe(false)
  })
})

describe('code-bridge limit with no account to take it (the original gap)', () => {
  beforeEach(() => resetBridgeContinuationForTest())
  afterEach(() => resetBridgeContinuationForTest())
  const limitTask = { id: 'lt1', status: 'error', origin: 'workbench', chatId: 's1', result: "You've hit your session limit · resets 2:10am (Europe/Budapest)", summary: null, error: 'Claude Code reported an error' } as unknown as CodeTask

  it('schedules the automatic continuation when the handler finds no account (the limit line still shows)', () => {
    let waited = 0
    setBridgeContinuationHandler(() => false)
    setBridgeLimitWaitHandler(() => { waited++ })
    expect(continueBridgeTaskElsewhere(limitTask)).toBe(false)
    expect(waited).toBe(1)
  })
  it('does not schedule when another account carries on', () => {
    let waited = 0
    setBridgeContinuationHandler(() => true)
    setBridgeLimitWaitHandler(() => { waited++ })
    expect(continueBridgeTaskElsewhere(limitTask)).toBe(true)
    expect(waited).toBe(0)
  })
})

describe('wiring', () => {
  const route = readFileSync(join(__dirname, '..', 'web', 'routes', 'workbench-agent.ts'), 'utf-8')
  const web = readFileSync(join(__dirname, '..', 'web.ts'), 'utf-8')
  it('the live turn schedules the resume when it ends on the limit, and the watcher starts with the server', () => {
    expect(route).toMatch(/detectsUsageLimit\(failed\)[\s\S]{0,200}scheduleTurnForLimitResume/)
    expect(web).toContain('startWorkbenchLimitResume()')
  })
  it('every new message has Hungarian and English text', () => {
    for (const k of ['limit_resume_scheduled', 'limit_resume_prompt', 'limit_resume_gave_up'] as const) {
      expect(MESSAGES[k].hu.length).toBeGreaterThan(10)
      expect(MESSAGES[k].en.length).toBeGreaterThan(10)
    }
  })
})
