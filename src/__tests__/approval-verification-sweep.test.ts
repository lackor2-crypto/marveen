// Boss 2026-08-23: dispatched reviews used to sit in 'pending' forever -- the
// approvals page showed "Folyamatban (0/4)" on two-week-old requests because
// nothing ever gave up on an agent that could not answer. These lock the give-up
// rules in place.
import { describe, it, expect } from 'vitest'
import {
  runVerificationSweep,
  VERIFICATION_REMINDER_MS,
  VERIFICATION_REMINDER_REPEAT_MS,
  VERIFICATION_TIMEOUT_MS,
  NO_RESPONSE_TIMEOUT,
  NO_RESPONSE_AGENT_GONE,
  type VerificationSweepDeps,
} from '../approval-verification-sweep.js'
import type { ApprovalVerification } from '../db.js'

const NOW = 1_800_000_000_000

function row(over: Partial<ApprovalVerification> & { ageMs: number }): ApprovalVerification {
  const { ageMs, ...rest } = over
  return {
    id: 'a1:gemma',
    approval_id: 'a1',
    agent: 'gemma',
    status: 'pending',
    report: null,
    requested_at: Math.floor((NOW - ageMs) / 1000),
    resolved_at: null,
    reminded_at: null,
    ...rest,
  }
}

function harness(rows: ApprovalVerification[], over: Partial<VerificationSweepDeps> = {}) {
  const reminders: string[] = []
  const noResponses: Array<{ id: string; reason: string }> = []
  const remindedMarks: string[] = []
  const deps: VerificationSweepDeps = {
    now: NOW,
    // The production query filters by cutoff; mirror that here so a test row
    // younger than the reminder threshold is never even offered to the sweep.
    listPendingOlderThan: (cutoffSec) => rows.filter(r => r.status === 'pending' && r.requested_at <= cutoffSec),
    agentExists: () => true,
    sendReminder: (r) => { reminders.push(r.agent); return true },
    // Kanban 2a32b51e: a stub that always said yes is exactly what let a dead
    // repeat window ship green. The real store refuses when a nudge already
    // went out after the cutoff the sweep passes in, so mirror that here --
    // a stub more permissive than production tests nothing.
    markReminded: (id, atSec, notRemindedSinceSec) => {
      const target = rows.find(r => r.id === id)
      if (!target || target.status !== 'pending') return false
      if (target.reminded_at != null && target.reminded_at > notRemindedSinceSec) return false
      target.reminded_at = atSec
      remindedMarks.push(id)
      return true
    },
    markNoResponse: (id, reason) => { noResponses.push({ id, reason }); return true },
    ...over,
  }
  return { result: runVerificationSweep(deps), reminders, noResponses, remindedMarks }
}

describe('stale approval-verification sweep', () => {
  it('leaves a fresh dispatch alone', () => {
    const { result, reminders, noResponses } = harness([row({ ageMs: 60 * 1000 })])
    expect(result).toEqual({ reminded: [], expired: [] })
    expect(reminders).toEqual([])
    expect(noResponses).toEqual([])
  })

  it('nudges once past the reminder threshold, without expiring it yet', () => {
    const { result, reminders, noResponses } = harness([row({ ageMs: VERIFICATION_REMINDER_MS + 1000 })])
    expect(reminders).toEqual(['gemma'])
    expect(result.reminded).toEqual(['a1:gemma'])
    expect(noResponses).toEqual([])
  })

  // Boss, 2026-08-24: "ha mar egyszer ki van adva, akkor amikor ujra reer,
  // akkor folytassa a munkat amit kapott." Egy nudge kevés: ha az agens eppen
  // egy hosszu elemzest futtat, pont azt az egyet nem tudja atvenni.
  it('a nudge-ok kozott kivarja a REPEAT ablakot -- nem spammel minden sopreskor', () => {
    const { reminders } = harness([row({
      ageMs: VERIFICATION_REMINDER_MS + 1000,
      reminded_at: Math.floor((NOW - (VERIFICATION_REMINDER_REPEAT_MS - 60_000)) / 1000),
    })])
    expect(reminders).toEqual([])
  })

  it('a REPEAT ablak utan UJRA szol, hogy a feladat ne vesszen el', () => {
    const { reminders, result } = harness([row({
      ageMs: VERIFICATION_REMINDER_MS + VERIFICATION_REMINDER_REPEAT_MS + 1000,
      reminded_at: Math.floor((NOW - (VERIFICATION_REMINDER_REPEAT_MS + 1000)) / 1000),
    })])
    expect(reminders).toEqual(['gemma'])
    expect(result.reminded).toEqual(['a1:gemma'])
  })

  // Boss, 2026-08-24. A foagensnek NINCS agents/<nev>/ mappaja (merve:
  // agents/lackor2-bot nem letezik), ezert a mappa-alapu letezes-teszt rola azt
  // allitotta volna, hogy "az ugynok mar nem letezik", es 10 perc utan lezarta
  // volna minden ellenorzeset -- mikozben Marvin el es epp dolgozik. A dontes a
  // hivoe; itt azt rogzitjuk, hogy egy ELERHETO agens sort a sopres nem oli meg,
  // hanem ujra szol neki.
  it('elerheto agenst nem zar le agent_gone-nal, hanem nudge-ol', () => {
    const { noResponses, reminders } = harness(
      [row({ ageMs: VERIFICATION_REMINDER_MS + 1000, agent: 'lackor2-bot', id: 'a1:lackor2-bot' })],
      { agentExists: (a) => a === 'lackor2-bot' },
    )
    expect(noResponses).toEqual([])
    expect(reminders).toEqual(['lackor2-bot'])
  })

  // Ha ket sopres atfed (indulaskori + a 2 perces timer), a masodik nem kuldhet
  // meg egy emlekeztetot ugyanarra a sorra: a dontes a sweep-e, a versenyt a
  // tarolo zarja ki -- es ha az nemet mond, kuldeni sem szabad.
  it('nem kuld, ha a tarolo elutasitja a jelolest (atfedo sopresek)', () => {
    const { reminders, result } = harness([row({ ageMs: VERIFICATION_REMINDER_MS + 1000 })], {
      markReminded: () => false,
    })
    expect(reminders).toEqual([])
    expect(result.reminded).toEqual([])
  })

  it('gives up past the timeout so the counter can resolve', () => {
    const { result, noResponses, reminders } = harness([row({ ageMs: VERIFICATION_TIMEOUT_MS + 1000 })])
    expect(noResponses).toEqual([{ id: 'a1:gemma', reason: NO_RESPONSE_TIMEOUT }])
    expect(result.expired).toEqual(['a1:gemma'])
    // Past the deadline there is nothing left to remind about.
    expect(reminders).toEqual([])
  })

  it('closes rows belonging to an agent that no longer exists, without messaging it', () => {
    const { noResponses, reminders } = harness(
      [row({ ageMs: VERIFICATION_REMINDER_MS + 1000 })],
      { agentExists: () => false },
    )
    expect(noResponses).toEqual([{ id: 'a1:gemma', reason: NO_RESPONSE_AGENT_GONE }])
    expect(reminders).toEqual([])
  })

  it('does not report a reminder that could not be queued', () => {
    const { result } = harness(
      [row({ ageMs: VERIFICATION_REMINDER_MS + 1000 })],
      { sendReminder: () => false },
    )
    // The row is still MARKED reminded (so it is not retried every two
    // minutes), it just is not counted as one that went out.
    expect(result.reminded).toEqual([])
  })

  it('is safe to run repeatedly -- a row already expired is not touched again', () => {
    // markNoResponse is guarded on status = 'pending' in SQL; here the row is
    // simply no longer in the pending listing.
    const expired = row({ ageMs: VERIFICATION_TIMEOUT_MS + 1000, status: 'noresponse' })
    const { result, noResponses } = harness([expired])
    expect(noResponses).toEqual([])
    expect(result).toEqual({ reminded: [], expired: [] })
  })
})
