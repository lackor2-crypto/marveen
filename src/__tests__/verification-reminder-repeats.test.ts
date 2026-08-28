// Kanban 2a32b51e. The repeat-reminder feature (Boss, 2026-08-24: "ha mar
// egyszer ki van adva, akkor amikor ujra reer, akkor folytassa a munkat amit
// kapott") was dead code for four days, and every existing test was green
// while it was.
//
// Why nothing caught it: the sweep's unit test stubs the store as
// `markReminded: () => true`, so it only ever exercised the DECISION ("is a
// second nudge due?") and never the STORE ("may a second nudge be recorded?").
// The store said no, permanently -- `reminded_at IS NULL` -- and because the
// sweep only sends inside `if (markReminded(...))`, the second reminder was
// never even attempted. A stub that is more permissive than the real thing
// hides exactly this shape of bug, so these tests run against a real database.
import { describe, it, expect, beforeEach } from 'vitest'
import {
  initDatabase, createApproval, createOrResetApprovalVerification,
  markVerificationReminded, listPendingVerificationsOlderThan, markVerificationNoResponse,
  listApprovalVerifications, getDb,
} from '../db.js'
import {
  runVerificationSweep,
  VERIFICATION_REMINDER_MS,
  VERIFICATION_REMINDER_REPEAT_MS,
  VERIFICATION_TIMEOUT_MS,
  type ApprovalVerification,
} from '../approval-verification-sweep.js'

const SEC = 1000

beforeEach(() => {
  initDatabase(':memory:')
  createApproval({ id: 'a1', agent_id: 'lackor2-bot', category: 'code_change', action_description: 'X' })
})

function pendingRow(): ApprovalVerification {
  return listApprovalVerifications('a1')[0]!
}

describe('markVerificationReminded: the store closes the race, it does not make the decision', () => {
  it('records the first nudge', () => {
    const row = createOrResetApprovalVerification('a1', 'gemma')
    const now = Math.floor(Date.now() / 1000)
    expect(markVerificationReminded(row.id, now, now - 600)).toBe(true)
    expect(pendingRow().reminded_at).toBe(now)
  })

  it('refuses a second nudge INSIDE the window -- two overlapping ticks cannot both send', () => {
    const row = createOrResetApprovalVerification('a1', 'gemma')
    const now = Math.floor(Date.now() / 1000)
    expect(markVerificationReminded(row.id, now, now - 600)).toBe(true)
    // Same tick, one second later: the cutoff is older than the mark just written.
    expect(markVerificationReminded(row.id, now + 1, now - 600)).toBe(false)
  })

  it('ALLOWS a second nudge once the caller says the window has passed', () => {
    // The regression itself. With `reminded_at IS NULL` this returned false
    // forever, and no agent was ever reminded twice.
    const row = createOrResetApprovalVerification('a1', 'gemma')
    const first = Math.floor(Date.now() / 1000)
    expect(markVerificationReminded(row.id, first, first - 600)).toBe(true)
    const later = first + 601
    expect(markVerificationReminded(row.id, later, later - 600)).toBe(true)
    expect(pendingRow().reminded_at).toBe(later)
  })

  it('never nudges a row that is no longer pending', () => {
    const row = createOrResetApprovalVerification('a1', 'gemma')
    const now = Math.floor(Date.now() / 1000)
    markVerificationNoResponse(row.id, 'noresponse:timeout', now)
    expect(markVerificationReminded(row.id, now + 10_000, now)).toBe(false)
  })
})

describe('the sweep actually sends a SECOND reminder, against the real store', () => {
  // The row must be older than REMINDER_MS or the sweep's own query never
  // returns it, so backdate the dispatch in the database rather than faking
  // it in the arguments -- the cutoff is applied by real SQL here.
  function dispatchedAgoMs(ageMs: number): void {
    const row = createOrResetApprovalVerification('a1', 'gemma')
    getDb().prepare('UPDATE approval_verifications SET requested_at = ? WHERE id = ?')
      .run(Math.floor((Date.now() - ageMs) / 1000), row.id)
  }

  function sweepAt(nowMs: number, sent: string[]) {
    return runVerificationSweep({
      now: nowMs,
      listPendingOlderThan: listPendingVerificationsOlderThan,
      agentExists: () => true,
      sendReminder: (r) => { sent.push(r.agent); return true },
      markReminded: markVerificationReminded,
      markNoResponse: markVerificationNoResponse,
    })
  }

  it('nudges again after the repeat window, and stays quiet in between', () => {
    dispatchedAgoMs(VERIFICATION_REMINDER_MS + 60 * SEC)
    const t0 = Date.now()
    const sent: string[] = []

    const first = sweepAt(t0, sent)
    expect(sent).toEqual(['gemma'])
    expect(first.reminded).toHaveLength(1)

    // A tick two minutes later must NOT send: the repeat window has not passed.
    sweepAt(t0 + 120 * SEC, sent)
    expect(sent).toEqual(['gemma'])

    // Past the repeat window the second reminder goes out. This is the
    // assertion that failed before the fix -- markVerificationReminded said
    // "already nudged once" forever, so sendReminder was never even called.
    const third = sweepAt(t0 + VERIFICATION_REMINDER_REPEAT_MS + 60 * SEC, sent)
    expect(sent).toEqual(['gemma', 'gemma'])
    expect(third.reminded).toHaveLength(1)
  })

  it('keeps repeating -- a busy agent gets the task back more than twice', () => {
    dispatchedAgoMs(VERIFICATION_REMINDER_MS + 60 * SEC)
    const sent: string[] = []
    let at = Date.now()
    for (let i = 0; i < 5; i++) {
      sweepAt(at, sent)
      at += VERIFICATION_REMINDER_REPEAT_MS + SEC
    }
    expect(sent).toHaveLength(5)
  })

  it('does not spam on every 2-minute tick between windows', () => {
    dispatchedAgoMs(VERIFICATION_REMINDER_MS + 60 * SEC)
    const sent: string[] = []
    // Ten ticks two minutes apart span 18 minutes past the first nudge, which
    // is one full repeat window plus change -- so two reminders, not ten.
    let at = Date.now()
    for (let i = 0; i < 10; i++) {
      sweepAt(at, sent)
      at += 2 * 60 * SEC
    }
    expect(sent).toHaveLength(2)
  })

  it('stops nudging and expires the row once the timeout is reached', () => {
    dispatchedAgoMs(VERIFICATION_REMINDER_MS + 60 * SEC)
    const sent: string[] = []
    const res = sweepAt(Date.now() + VERIFICATION_TIMEOUT_MS, sent)
    expect(sent).toEqual([])
    expect(res.expired).toHaveLength(1)
    expect(pendingRow().status).toBe('noresponse')
  })
})
