import { describe, it, expect, beforeEach } from 'vitest'
import {
  runCodeBridgeTurn, codeBridgeContinuable,
  type CodeBridgeTaskView,
} from '../workbench-agent/code-bridge-turn.js'
import {
  continueBridgeTaskElsewhere, setBridgeContinuationHandler, watchBridgeTask, unwatchBridgeTask,
  markBridgeTaskContinued, wasBridgeTaskContinued, resetBridgeContinuationForTest,
} from '../workbench-agent/bridge-continuation.js'
import type { CodeTask } from '../web/code-bridge-store.js'
import type { OrchestratorEvent } from '../workbench-agent/orchestrator.js'
import { msg } from '../workbench-agent/messages.js'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Boss, 2026-09-29: on a limit or a time limit the Workbench first looks for
// another account that can work and continues with it; the exhausted-quota
// error shows only when every account is out.

async function collect(gen: AsyncGenerator<OrchestratorEvent>): Promise<OrchestratorEvent[]> {
  const out: OrchestratorEvent[] = []
  for await (const ev of gen) out.push(ev)
  return out
}
const clock = () => { let t = 0; return { now: () => t, sleep: async () => { t += 1000 } } }
const view = (extra: Partial<CodeBridgeTaskView>): CodeBridgeTaskView => ({ status: 'error', result: null, summary: null, error: null, ...extra })
const LIMIT = view({ error: 'Claude Code reported an error', result: "You've hit your session limit · resets 2:10am (Europe/Budapest)" })
const STALL = view({ error: 'no progress for 1800 s (transcript silent) -- stopped' })
const OUTDATED = view({ error: 'Claude Code reported an error', result: "API Error: 400 Claude Code 2.1.226 does not support this model; version 2.1.280 or newer is required. Run 'claude update'." })
const HARD = view({ error: 'timed out after 14400 s (hard limit)' })
const task = (extra: Partial<CodeTask>): CodeTask => ({
  id: 't1', status: 'error', origin: 'workbench', chatId: 's1', result: null, summary: null, error: null, ...extra,
} as unknown as CodeTask)

describe('codeBridgeContinuable', () => {
  it('limit, idle stop, hard stop, outdated AND any plain error are continuable; a finished task is not', () => {
    expect(codeBridgeContinuable(LIMIT)).toBe('limit')
    expect(codeBridgeContinuable(STALL)).toBe('stalled')
    expect(codeBridgeContinuable(HARD)).toBe('stalled')
    expect(codeBridgeContinuable(OUTDATED)).toBe('outdated')
    // Boss, 2026-10-02 (TG 7117 + 7127): any OTHER error-stop is continued too,
    // not left dead -- the work only stops when no account can work (the limit
    // floor) or when it stops making progress (capped by the continuation layer).
    expect(codeBridgeContinuable(view({ error: 'tsc failed: 3 errors' }))).toBe('error')
    expect(codeBridgeContinuable(view({ status: 'done', result: 'ok' }))).toBeNull()
  })
})

describe('runCodeBridgeTurn -- another account can continue', () => {
  it('limit + another account: the limit is NOT written to the chat, the route switches on the error code', async () => {
    const c = clock()
    const recorded: [string, string][] = []
    const evs = await collect(runCodeBridgeTurn({ projectRef: 'p', message: 'm', lang: 'hu', requestedBy: 'b' }, {
      enqueue: () => ({ ok: true, id: 't' }), getTask: () => LIMIT, now: c.now, sleep: c.sleep,
      record: (r, s) => { recorded.push([r, s]) }, canContinueElsewhere: () => true,
    }))
    expect(evs.find((e) => e.type === 'error')).toMatchObject({ code: 'code_bridge_limit' })
    expect(recorded).toEqual([['user', 'm']])
  })

  it('stall + another account: code_bridge_stalled, nothing recorded', async () => {
    const c = clock()
    const recorded: string[] = []
    const evs = await collect(runCodeBridgeTurn({ projectRef: 'p', message: 'm', lang: 'hu', requestedBy: 'b' }, {
      enqueue: () => ({ ok: true, id: 't' }), getTask: () => STALL, now: c.now, sleep: c.sleep,
      record: (r) => { recorded.push(r) }, canContinueElsewhere: () => true,
    }))
    expect(evs.find((e) => e.type === 'error')).toMatchObject({ code: 'code_bridge_stalled' })
    expect(recorded).toEqual(['user'])
  })

  it('no other account: the real limit reason (with the reset time) is recorded', async () => {
    const c = clock()
    const recorded: [string, string][] = []
    await collect(runCodeBridgeTurn({ projectRef: 'p', message: 'm', lang: 'hu', requestedBy: 'b' }, {
      enqueue: () => ({ ok: true, id: 't' }), getTask: () => LIMIT, now: c.now, sleep: c.sleep,
      record: (r, s) => { recorded.push([r, s]) }, canContinueElsewhere: () => false,
    }))
    expect(recorded.at(-1)?.[0]).toBe('system')
    expect(recorded.at(-1)?.[1]).toContain('resets 2:10am')
  })
})

describe('the background follower leaves a limit end to the completion hook', () => {
  it('after the chat stopped waiting, a late limit end is NOT recorded by the follower', async () => {
    let t = 0
    const recorded: string[] = []
    let polls = 0
    await collect(runCodeBridgeTurn({ projectRef: 'p', message: 'm', lang: 'hu', requestedBy: 'b' }, {
      enqueue: () => ({ ok: true, id: 't' }),
      getTask: () => (++polls > 3 ? LIMIT : view({ status: 'running' })),
      now: () => t, sleep: async () => { t += 60_000 },
      pollMs: 1, timeoutMs: 2 * 60_000, backgroundMs: 60 * 60_000,
      record: (r) => { recorded.push(r) }, wasContinued: () => false,
    }))
    await new Promise((r) => setTimeout(r, 20))
    expect(polls).toBeGreaterThan(3)
    expect(recorded).toEqual(['user', 'system'])
  })
})

describe('continueBridgeTaskElsewhere -- the completion hook', () => {
  beforeEach(() => resetBridgeContinuationForTest())

  it('unwatched limit task + an account: continues in the background once, the error is not delivered', () => {
    let calls = 0
    setBridgeContinuationHandler(() => { calls++; return true })
    const t = task({ error: LIMIT.error, result: LIMIT.result })
    expect(continueBridgeTaskElsewhere(t)).toBe(true)
    expect(continueBridgeTaskElsewhere(t)).toBe(true)
    expect(calls).toBe(1)
    expect(wasBridgeTaskContinued('t1')).toBe(true)
  })

  it('no account can take it: false -> the hook delivers the real reason', () => {
    setBridgeContinuationHandler(() => false)
    expect(continueBridgeTaskElsewhere(task({ error: STALL.error }))).toBe(false)
    expect(wasBridgeTaskContinued('t1')).toBe(false)
  })

  it('a watching live turn decides itself; the hook stays out', () => {
    let calls = 0
    setBridgeContinuationHandler(() => { calls++; return true })
    watchBridgeTask('t1')
    expect(continueBridgeTaskElsewhere(task({ error: STALL.error }))).toBe(true)
    expect(calls).toBe(0)
    unwatchBridgeTask('t1')
  })

  it('already continued by the live turn: nothing is delivered', () => {
    markBridgeTaskContinued('t1')
    expect(continueBridgeTaskElsewhere(task({ error: LIMIT.error, result: LIMIT.result }))).toBe(true)
  })

  it('Workbench only: a Telegram-origin task is never continued (the agents run separately)', () => {
    setBridgeContinuationHandler(() => true)
    expect(continueBridgeTaskElsewhere(task({ origin: 'telegram' as CodeTask['origin'], error: STALL.error }))).toBe(false)
  })

  it('a plain error is continued too now (Boss, 2026-10-02); a finished task is delivered as usual', () => {
    setBridgeContinuationHandler(() => true)
    expect(continueBridgeTaskElsewhere(task({ id: 'pe1', chatId: 'c1', error: 'tsc failed' }))).toBe(true)
    expect(continueBridgeTaskElsewhere(task({ id: 'pd1', chatId: 'c2', status: 'done', result: 'ok' } as Partial<CodeTask>))).toBe(false)
  })

  it('a repeating plain error is capped per chat; after the cap the real error is delivered', () => {
    setBridgeContinuationHandler(() => true)
    for (let i = 0; i < 5; i++) {
      expect(continueBridgeTaskElsewhere(task({ id: 'cap' + i, chatId: 'capc', error: 'boom' }))).toBe(true)
    }
    // 6th time with no 'done' in between: no progress is itself "cannot work" -> stop.
    expect(continueBridgeTaskElsewhere(task({ id: 'cap5', chatId: 'capc', error: 'boom' }))).toBe(false)
  })

  it('a finished answer resets the per-chat error streak, so work can continue again', () => {
    setBridgeContinuationHandler(() => true)
    for (let i = 0; i < 5; i++) continueBridgeTaskElsewhere(task({ id: 'rs' + i, chatId: 'rsc', error: 'boom' }))
    expect(continueBridgeTaskElsewhere(task({ id: 'rsdone', chatId: 'rsc', status: 'done', result: 'ok' } as Partial<CodeTask>))).toBe(false)
    expect(continueBridgeTaskElsewhere(task({ id: 'rs6', chatId: 'rsc', error: 'boom' }))).toBe(true)
  })

  it('the cap is PER chat: a different chat is not affected', () => {
    setBridgeContinuationHandler(() => true)
    for (let i = 0; i < 5; i++) continueBridgeTaskElsewhere(task({ id: 'a' + i, chatId: 'chatA', error: 'boom' }))
    expect(continueBridgeTaskElsewhere(task({ id: 'a5', chatId: 'chatA', error: 'boom' }))).toBe(false)
    expect(continueBridgeTaskElsewhere(task({ id: 'b0', chatId: 'chatB', error: 'boom' }))).toBe(true)
  })
})

describe('the chat names the accounts (Boss, 2026-09-29)', () => {
  it('switch messages name the exhausted and the next account, both languages', () => {
    expect(msg('live_account_switched', 'hu', { from: 'a1', to: 'a2' })).toBe('A(z) a1 fiók kerete kifogyott, a munkát a(z) a2 fiókkal folytatom.')
    expect(msg('live_account_switched', 'en', { from: 'a1', to: 'a2' })).toContain('a2')
    expect(msg('code_bridge_limit_fallback', 'hu', { to: 'a2' })).toContain('a(z) a2 fiókkal folytatom')
    expect(msg('code_bridge_stalled_fallback', 'en', { to: 'a2' })).toContain('a2')
    // Boss, 2026-10-02: a plain bridge error also continues on another account.
    expect(msg('code_bridge_error_fallback', 'hu', { to: 'a2' })).toContain('a2 fiókkal folytatom')
    expect(msg('code_bridge_error_fallback', 'en', { to: 'a2' })).toContain('a2')
  })

  it('the live route continues on a plain bridge error too, not only limit/stall/outdated', () => {
    const src = readFileSync(join(__dirname, '..', 'web', 'routes', 'workbench-agent.ts'), 'utf-8')
    expect(src).toContain("ev.code === 'code_bridge_error'")
    expect(src).toContain("code_bridge_error_fallback")
  })

  it('the route wires it: mid-answer switch, stalled fallback, background handler, idle cap', () => {
    const src = readFileSync(join(__dirname, '..', 'web', 'routes', 'workbench-agent.ts'), 'utf-8')
    expect(src).not.toContain("code === 'live_limit' && !account && !answer.trim()")
    expect(src).toContain("ev.code === 'code_bridge_stalled'")
    expect(src).toContain('setBridgeContinuationHandler(')
    expect(src).toContain('LIVE_IDLE_MAX_MS')
    expect(src).toMatch(/msg\('live_account_switched'/)
  })

  it('the completion hook asks first', () => {
    const src = readFileSync(join(__dirname, '..', 'workbench-agent', 'code-bridge-delivery.ts'), 'utf-8')
    expect(src).toContain('continueBridgeTaskElsewhere(task)')
  })
})
