// #550: a queued task must not run against an exhausted executor login. Measured case (2026-10-10): four tasks
// were accepted, all four ended as 'error' with "You've hit your session limit · resets 4:20pm". They now stay
// queued, the sender is warned, and they go out by themselves once the limit lifts.

import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase } from '../db.js'
import {
  resetCodeBridgeTablesForTests, upsertCodeSession, enqueueCodeTask, claimNextCodeTask,
  completeCodeTaskDetailed, getCodeTask, activeCodeBridgeLimit, listActiveCodeBridgeLimits,
  codeTaskLimitSentence, LIMIT_RETRY_MS, codeBridgeActivity,
} from '../web/code-bridge-store.js'

const WS = { project: 'marvin', workspacePath: '\\\\wsl.localhost\\Ubuntu\\home\\boss\\marveen', sessionId: 'aaaaaaaa-0000-4000-8000-000000000001' }
const SENTENCE = "You've hit your session limit · resets 4:20pm (Europe/Budapest)"

beforeEach(() => {
  initDatabase(':memory:')
  resetCodeBridgeTablesForTests()
  upsertCodeSession(WS)
})

function queue(origin: 'agent' | 'api' | 'workbench' = 'agent'): string {
  const out = enqueueCodeTask({ project: 'marvin', prompt: 'do the thing ' + Math.random(), origin, requestedBy: 'lackor2-bot' })
  if ('error' in out) throw new Error(out.error)
  return out.task.id
}

describe('#550 the executor limit', () => {
  it('a run that stops on the limit sentence goes back to the queue, not to error', () => {
    const id = queue()
    claimNextCodeTask('H')
    const r = completeCodeTaskDetailed(id, { ok: false, error: `Claude Code reported an error: ${SENTENCE}` }, Date.now(), 'H')
    expect(r.outcome).toBe('limit-requeued')
    expect(r.limit?.estimated).toBe(false)
    expect(r.limit!.resetsAt).toBeGreaterThan(Date.now() - 1)
    const t = getCodeTask(id)!
    expect(t.status).toBe('queued')
    expect(t.error).toBeNull()
    expect(t.attempts).toBe(0)
  })

  it('while the limit holds, the queued task is not handed out; after it, it is', () => {
    const id = queue()
    claimNextCodeTask('H')
    const at = Date.UTC(2026, 9, 10, 11, 0, 0)
    completeCodeTaskDetailed(id, { ok: false, error: SENTENCE }, at, 'H')
    const lim = activeCodeBridgeLimit('wsl', at)!
    expect(lim).not.toBeNull()
    expect(claimNextCodeTask('H', at + 1000)).toBeNull()
    expect(getCodeTask(id)!.status).toBe('queued')
    const claimed = claimNextCodeTask('H', lim.resetsAt + 1)
    expect(claimed?.id).toBe(id)
    expect(claimed?.status).toBe('running')
  })

  it('a long named limit is probed every LIMIT_RETRY_MS, and a successful probe clears the note', () => {
    const id = queue()
    claimNextCodeTask('H')
    const at = Date.UTC(2026, 9, 10, 11, 0, 0)
    completeCodeTaskDetailed(id, { ok: false, error: "You've hit your weekly limit · resets Oct 15, 8pm (Europe/Budapest)" }, at, 'H')
    expect(claimNextCodeTask('H', at + 1000)).toBeNull()
    const probe = claimNextCodeTask('H', at + LIMIT_RETRY_MS + 1)
    expect(probe?.id).toBe(id)
    const id2 = queue()
    expect(claimNextCodeTask('H2', at + LIMIT_RETRY_MS + 2)).toBeNull()
    completeCodeTaskDetailed(id, { ok: true, result: 'ok' }, at + LIMIT_RETRY_MS + 3, 'H')
    expect(activeCodeBridgeLimit('wsl', at + LIMIT_RETRY_MS + 4)).toBeNull()
    expect(claimNextCodeTask('H', at + LIMIT_RETRY_MS + 5)?.id).toBe(id2)
  })

  it('a sentence without a reset moment holds for the short retry window only', () => {
    const id = queue()
    claimNextCodeTask('H')
    const at = Date.now()
    const r = completeCodeTaskDetailed(id, { ok: false, error: "You've hit your usage limit" }, at, 'H')
    expect(r.limit?.estimated).toBe(true)
    expect(r.limit?.resetsAt).toBe(at + LIMIT_RETRY_MS)
    expect(claimNextCodeTask('H', at + LIMIT_RETRY_MS + 1)?.id).toBe(id)
  })

  it('a new task sent during the limit is accepted with a warning that names the time', () => {
    const first = queue()
    claimNextCodeTask('H')
    completeCodeTaskDetailed(first, { ok: false, error: SENTENCE }, Date.now(), 'H')
    const out = enqueueCodeTask({ project: 'marvin', prompt: 'another one', origin: 'agent', requestedBy: 'x' })
    if ('error' in out) throw new Error(out.error)
    expect(out.task.status).toBe('queued')
    expect(out.warning?.message).toMatch(/\d{2}:\d{2}/)
    expect(out.warning?.message.toLowerCase()).toMatch(/kimerült|out of quota/)
  })

  it('a task that is NOT a limit still ends as error, and a long answer quoting the sentence is no limit', () => {
    const a = queue()
    claimNextCodeTask('H')
    expect(completeCodeTaskDetailed(a, { ok: false, error: 'boom' }, Date.now(), 'H').outcome).toBe('accepted')
    expect(getCodeTask(a)!.status).toBe('error')
    expect(codeTaskLimitSentence({ ok: true, result: `${'x '.repeat(300)} ${SENTENCE}` })).toBeNull()
    expect(listActiveCodeBridgeLimits()).toEqual([])
  })

  it('a Workbench chat task keeps the old path (its chat continues on another account itself)', () => {
    const id = queue('workbench')
    claimNextCodeTask('H', Date.now(), 'chat')
    const r = completeCodeTaskDetailed(id, { ok: false, error: SENTENCE }, Date.now(), 'H')
    expect(r.outcome).toBe('accepted')
    expect(getCodeTask(id)!.status).toBe('error')
  })

  it('the activity keeps saying "quota blocked" although the task is no longer an error row', () => {
    const id = queue()
    claimNextCodeTask('H')
    completeCodeTaskDetailed(id, { ok: false, error: SENTENCE }, Date.now(), 'H')
    expect(codeBridgeActivity().quotaBlocked).toBe(true)
  })
})
