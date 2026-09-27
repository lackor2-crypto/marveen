// #417 -- daily-handoff tier of the context guard (rebuilt from upstream
// d3cdb375 onto our guard): pure state machine, the arming predicate the
// auto-restart runner shares, the runner wiring, and the UI surface.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  normalizeContextGuardConfig,
  decideGuard,
  dailyHandoffArmed,
  dailyHandoffDue,
  dailyHandoffTick,
  DAILY_HANDOFF_REASON_PREFIX,
  DEFAULT_CONTEXT_GUARD,
  INITIAL_GUARD_STATE,
  type ContextGuardConfig,
  type GuardInputs,
} from '../context-guard.js'
import { normalizeAutoRestartConfig, DEFAULT_AUTO_RESTART, localMidnightMs } from '../auto-restart.js'
import { dailyHandoffPrompt, resumePrompt } from '../web/context-guard-runner.js'

const ROOT = join(__dirname, '..', '..')
const src = (p: string) => readFileSync(join(ROOT, p), 'utf-8')

// Daily-only agent: the proactive tiers AND the saturation net off, so the
// daily tier is the only thing that can act.
const DAILY: ContextGuardConfig = {
  ...DEFAULT_CONTEXT_GUARD,
  saturationRestart: false,
  dailyHandoffEnabled: true,
  dailyHandoffTime: '03:00',
}
const NOW = 1_000_000_000

function inputs(o: Partial<GuardInputs> = {}): GuardInputs {
  return {
    nowMs: NOW, pct: null, running: true, paneIdle: true, paneBusy: false,
    sessionReady: false, handoffMtime: null, paneSaturated: false, ...o,
  }
}

describe('config', () => {
  it('is default-off with no default time', () => {
    const c = normalizeContextGuardConfig({})
    expect(c.dailyHandoffEnabled).toBe(false)
    expect(c.dailyHandoffTime).toBeNull()
  })
  it('keeps a valid HH:MM, drops a typo', () => {
    expect(normalizeContextGuardConfig({ dailyHandoffTime: ' 04:30 ' }).dailyHandoffTime).toBe('04:30')
    expect(normalizeContextGuardConfig({ dailyHandoffTime: '25:00' }).dailyHandoffTime).toBeNull()
    expect(normalizeContextGuardConfig({ dailyHandoffTime: 'reggel' }).dailyHandoffTime).toBeNull()
  })
  it('only an explicit true enables', () => {
    expect(normalizeContextGuardConfig({ dailyHandoffEnabled: 1 }).dailyHandoffEnabled).toBe(false)
    expect(normalizeContextGuardConfig({ dailyHandoffEnabled: true }).dailyHandoffEnabled).toBe(true)
  })
})

describe('dailyHandoffArmed / dailyHandoffDue', () => {
  it('enabled without a usable time is NOT armed', () => {
    expect(dailyHandoffArmed({ ...DAILY, dailyHandoffTime: null })).toBe(false)
    expect(dailyHandoffArmed({ ...DAILY, dailyHandoffEnabled: false })).toBe(false)
    expect(dailyHandoffArmed(DAILY)).toBe(true)
  })
  it('is due once past the slot and unserved, never twice for one slot', () => {
    const midnight = 0
    const slot = 3 * 3_600_000
    expect(dailyHandoffDue(DAILY, midnight, 0, slot - 1)).toBe(false)
    expect(dailyHandoffDue(DAILY, midnight, 0, slot + 1)).toBe(true)
    expect(dailyHandoffDue(DAILY, midnight, slot + 1, slot + 60_000)).toBe(false)
    expect(dailyHandoffDue({ ...DAILY, dailyHandoffEnabled: false }, midnight, 0, slot + 1)).toBe(false)
  })
  it('localMidnightMs is the start of the local day', () => {
    const now = new Date(2026, 8, 27, 14, 5).getTime()
    expect(localMidnightMs(now)).toBe(new Date(2026, 8, 27).getTime())
  })
})

describe('dailyHandoffTick -- the stamp only lives while the tier can fire', () => {
  // Local wall clock, like the runner: Saturday 2026-09-26 .. Monday 09-28.
  const at = (d: number, h: number, m = 0) => new Date(2026, 8, d, h, m).getTime()
  const OFF: ContextGuardConfig = { ...DEFAULT_CONTEXT_GUARD } // saturation net on, daily off
  const ON: ContextGuardConfig = { ...DEFAULT_CONTEXT_GUARD, dailyHandoffEnabled: true, dailyHandoffTime: '03:00' }
  type Stamp = Parameters<typeof dailyHandoffTick>[1]
  // Drives the tick the way the runner does: the returned stamp is the next input.
  function sweeper() {
    let stamp: Stamp = null
    return (cfg: ContextGuardConfig, now: number, running = true, idle = true) => {
      const r = dailyHandoffTick(cfg, stamp, now, localMidnightMs(now), running, idle)
      stamp = r.stamp
      return r.due
    }
  }

  it('arming after today\'s slot does NOT fire -- the dashboard ran since before the slot', () => {
    const sweep = sweeper()
    expect(sweep(OFF, at(26, 20))).toBe(false) // dashboard up Saturday 20:00, tier off
    expect(sweep(OFF, at(27, 3, 30))).toBe(false)
    expect(sweep(ON, at(27, 14))).toBe(false) // Boss arms it Sunday 14:00 (slot 03:00 passed)
    expect(sweep(ON, at(27, 14, 1))).toBe(false)
    expect(sweep(ON, at(27, 23, 59))).toBe(false)
    expect(sweep(ON, at(28, 2, 59))).toBe(false)
    expect(sweep(ON, at(28, 3, 0))).toBe(true) // first real slot: Monday 03:00
  })
  it('does not seed while the tier is off, so the old stamp cannot survive a disarm', () => {
    const r = dailyHandoffTick(OFF, null, at(26, 20), localMidnightMs(at(26, 20)), true, true)
    expect(r).toEqual({ due: false, stamp: null })
    const stale = { atMs: at(26, 20), time: '03:00' }
    expect(dailyHandoffTick(OFF, stale, at(27, 14), localMidnightMs(at(27, 14)), true, true).stamp).toBeNull()
    // Enabled without a usable time is not armed either.
    const noTime = { ...ON, dailyHandoffTime: null }
    expect(dailyHandoffTick(noTime, stale, at(27, 14), localMidnightMs(at(27, 14)), true, true).stamp).toBeNull()
  })
  it('fires once per slot while armed and running', () => {
    const sweep = sweeper()
    expect(sweep(ON, at(26, 20))).toBe(false) // seed
    expect(sweep(ON, at(27, 3, 0))).toBe(true)
  })
  it('an agent started after the slot does not fire for it', () => {
    const sweep = sweeper()
    expect(sweep(ON, at(26, 20))).toBe(false) // seeded while running
    expect(sweep(ON, at(26, 22), false)).toBe(false) // stopped Saturday 22:00
    expect(sweep(ON, at(27, 3, 0), false)).toBe(false)
    expect(sweep(ON, at(27, 14))).toBe(false) // started Sunday 14:00: re-seed
    expect(sweep(ON, at(27, 14, 1))).toBe(false)
    expect(sweep(ON, at(28, 3, 0))).toBe(true)
  })
  it('moving the time to a slot already past today does not fire now', () => {
    const sweep = sweeper()
    expect(sweep(ON, at(27, 1))).toBe(false)
    expect(sweep(ON, at(27, 3, 0))).toBe(true)
    const moved = { ...ON, dailyHandoffTime: '13:00' }
    expect(sweep(moved, at(27, 14))).toBe(false)
    expect(sweep(moved, at(27, 14, 1))).toBe(false)
    expect(sweep(moved, at(28, 13, 0))).toBe(true)
  })
  it('a non-idle sweep neither seeds nor fires, and keeps a valid stamp', () => {
    const stamp = { atMs: at(26, 20), time: '03:00' }
    const busy = dailyHandoffTick(ON, stamp, at(27, 4), localMidnightMs(at(27, 4)), true, false)
    expect(busy).toEqual({ due: false, stamp })
    expect(dailyHandoffTick(ON, null, at(27, 4), localMidnightMs(at(27, 4)), true, false).stamp).toBeNull()
  })
})

describe('decideGuard -- daily tier', () => {
  it('a daily-only agent is not short-circuited as disabled', () => {
    const d = decideGuard(INITIAL_GUARD_STATE, inputs(), DAILY)
    expect(d.reason).not.toBe('disabled')
  })
  it('requests a handoff when due, even on a busy pane', () => {
    const d = decideGuard(INITIAL_GUARD_STATE, inputs({ dailyHandoffDue: true, paneIdle: false, paneBusy: true }), DAILY)
    expect(d.action).toBe('request-handoff')
    expect(d.reason.startsWith(DAILY_HANDOFF_REASON_PREFIX)).toBe(true)
    expect(d.nextState.phase).toBe('await-handoff')
  })
  it('does nothing when not due, or when the tier is off', () => {
    expect(decideGuard(INITIAL_GUARD_STATE, inputs(), DAILY).action).toBe('none')
    const off = { ...DAILY, dailyHandoffEnabled: false }
    expect(decideGuard(INITIAL_GUARD_STATE, inputs({ dailyHandoffDue: true }), off).action).toBe('none')
  })
  it('ranks last: a measured act/hard tier wins over the schedule', () => {
    const both = { ...DAILY, enabled: true }
    const act = decideGuard(INITIAL_GUARD_STATE, inputs({ dailyHandoffDue: true, pct: 0.92 }), both)
    expect(act.reason.startsWith('act threshold')).toBe(true)
    const hard = decideGuard(INITIAL_GUARD_STATE, inputs({ dailyHandoffDue: true, pct: 0.99 }), both)
    expect(hard.action).toBe('restart')
    const low = decideGuard(INITIAL_GUARD_STATE, inputs({ dailyHandoffDue: true, pct: 0.2 }), both)
    expect(low.reason.startsWith(DAILY_HANDOFF_REASON_PREFIX)).toBe(true)
  })
  it('await-handoff does not stand down for a daily-only agent, and restarts once the handoff is written', () => {
    const req = decideGuard(INITIAL_GUARD_STATE, inputs({ dailyHandoffDue: true }), DAILY)
    const waiting = decideGuard(req.nextState, inputs({ nowMs: NOW + 60_000 }), DAILY)
    expect(waiting.nextState.phase).toBe('await-handoff')
    const written = decideGuard(req.nextState, inputs({ nowMs: NOW + 120_000, handoffMtime: NOW + 100_000 }), DAILY)
    expect(written.action).toBe('restart')
  })
  it('never cuts a live turn on the handoff timeout', () => {
    const req = decideGuard(INITIAL_GUARD_STATE, inputs({ dailyHandoffDue: true }), DAILY)
    const late = NOW + DAILY.handoffTimeoutMinutes * 60_000 + 1
    expect(decideGuard(req.nextState, inputs({ nowMs: late, paneIdle: false, paneBusy: true }), DAILY).action).toBe('none')
    expect(decideGuard(req.nextState, inputs({ nowMs: late }), DAILY).action).toBe('restart')
  })
})

describe('prompts', () => {
  it('the daily request does not claim a critical context', () => {
    const p = dailyHandoffPrompt('03:00', '/x/HANDOFF.md')
    expect(p).toContain('03:00')
    expect(p).toContain('/x/HANDOFF.md')
    expect(p).not.toMatch(/kritikus|%/)
  })
  it('the resume after a scheduled cycle does not say the context filled up', () => {
    expect(resumePrompt('a', '/x', true, true)).not.toContain('megtelt')
    expect(resumePrompt('a', '/x', true)).toContain('megtelt')
  })
})

describe('auto-restart handoff field is gone', () => {
  it('normalization drops a stale handoff key and the default has none', () => {
    expect('handoff' in normalizeAutoRestartConfig({ enabled: true, handoff: true })).toBe(false)
    expect(Object.keys(DEFAULT_AUTO_RESTART).some(k => /handoff/i.test(k))).toBe(false)
  })
})

describe('wiring', () => {
  const guardRunner = src('src/web/context-guard-runner.ts')
  const arRunner = src('src/web/auto-restart-runner.ts')
  it('the guard runner early return lists the daily tier', () => {
    expect(guardRunner).toMatch(/if \(!cfg\.enabled && !cfg\.saturationRestart && !cfg\.dailyHandoffEnabled\)/)
  })
  it('the guard runner keeps the stamp through dailyHandoffTick and marks the slot at decision time', () => {
    expect(guardRunner).toMatch(/const daily = dailyHandoffTick\(/)
    expect(guardRunner).toMatch(/dailyHandoffDue: daily\.due,/)
    // No second seeding path that could outlive a disarmed tier.
    expect(guardRunner.match(/lastDailyHandoff\.set\(/g)).toHaveLength(2)
    expect(guardRunner).toMatch(/startsWith\(DAILY_HANDOFF_REASON_PREFIX\)\) \{\s*lastDailyHandoff\.set/)
  })
  it('the auto-restart runner stands aside for an ARMED tier and a mid-sequence guard', () => {
    expect(arRunner).toMatch(/if \(dailyHandoffArmed\(readContextGuardConfig\(name\)\)\)/)
    expect(arRunner).toMatch(/guardPhase === 'await-handoff' \|\| guardPhase === 'await-ready'/)
  })
  it('the context-guard PUT merges a partial body over the stored config', () => {
    expect(src('src/web/routes/agents.ts')).toMatch(/\{ \.\.\.readContextGuardConfig\(name\), \.\.\.\(data as Record<string, unknown>\) \}/)
  })
  it('the agent page has the control, HU+EN', () => {
    const html = src('web/index.html')
    for (const id of ['dhEnabled', 'dhTime', 'saveDailyHandoffBtn']) expect(html).toContain(`id="${id}"`)
    for (const f of ['web/lang/hu.js', 'web/lang/en.js']) {
      const lang = src(f)
      for (const k of ['dh_label', 'dh_desc', 'dh_hint', 'dh_bad_time']) expect(lang).toContain(`'agents.settings.${k}'`)
      expect(lang).toContain(`'agents.toast.daily_handoff_saved'`)
    }
    expect(src('web/app.js')).not.toMatch(/handoff: false/)
  })
  it('switching agents resets the time field, not only the checkbox', () => {
    const fn = src('web/app.js').match(/async function loadDailyHandoffUI[\s\S]*?\n\}\n/)?.[0] ?? ''
    expect(fn).toMatch(/en\.checked = false\s*\n\s*tm\.value = tm\.defaultValue/)
    expect(fn).toMatch(/tm\.value = cg\.dailyHandoffTime \|\| tm\.defaultValue/)
    expect(fn).not.toMatch(/if \(cg\.dailyHandoffTime\) tm\.value/)
  })
})

describe('the UI tells the truth about interrupting work', () => {
  it('the hint warns that an armed tier interrupts running work (HU+EN)', () => {
    expect(src('web/lang/hu.js')).toMatch(/'agents\.settings\.dh_hint':[^\n]*futó munkát is megszakítja/)
    expect(src('web/lang/en.js')).toMatch(/'agents\.settings\.dh_hint':[^\n]*interrupts running work/)
  })
})
