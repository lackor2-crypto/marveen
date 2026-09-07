/**
 * ELLENORZES CSAK AMIG A KARTYA A VARAKOZOBAN ALL (kanban 4f781150).
 *
 * Boss, 2026-09-07: "amikor egy kartya a kesz be kerul akkor onnantol mar ne
 * futtason semmit sem az ingyenes sem. ... csak addig futtathat amig a
 * varakozoban van a kartya. ha mar kikerult onnan attol a pillanattol ne
 * kezdjen bele semmibe sem."
 *
 * A MERT allapot, ami miatt ez a kartya letrejott (elo adatbazis, ugyanaznap):
 * negy 'pending' ellenorzesbol HAROM olyan jovahagyashoz tartozott, amit a
 * tulajdonos MAR JOVAHAGYOTT es amelyik kartyaja mar 'done'-ban allt -- es
 * mindharom agens HAT emlekeztetot kapott a lezart munkara. A sopres csak azt
 * nezte, hogy a SOR pending-e; azt nem, hogy van-e meg ertelme.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  initDatabase, createKanbanCard, moveKanbanCard, createApproval, resolveApproval,
  createOrResetApprovalVerification, listApprovalVerifications, resolveApprovalVerification,
  cancelPendingVerifications, listPendingVerificationsOlderThan,
  type ApprovalVerification,
} from '../db.js'
import {
  ensureApprovalForWaitingCard, pendingApprovalForCard,
  withdrawApprovalForCardLeavingWaiting, stopVerificationsForApproval,
  verificationDispatchBlockedReason, verifyBlockedMessage,
} from '../web/routes/approvals.js'
import {
  runVerificationSweep, NO_RESPONSE_NOT_WAITING, NO_RESPONSE_AGENT_GONE,
  VERIFICATION_REMINDER_MS, type VerificationSweepDeps,
} from '../approval-verification-sweep.js'
import { computeReliabilityScore } from '../agent-reliability.js'

beforeEach(() => {
  initDatabase(':memory:')
})

const NOW = 1_800_000_000_000

function pendingRow(over: Partial<ApprovalVerification> = {}): ApprovalVerification {
  return {
    id: 'a1:gemma',
    approval_id: 'a1',
    agent: 'gemma',
    status: 'pending',
    mode: 'verify',
    report: null,
    requested_at: Math.floor((NOW - VERIFICATION_REMINDER_MS - 60_000) / 1000),
    resolved_at: null,
    reminded_at: null,
    reminder_count: 0,
    ...over,
  }
}

async function sweep(rows: ApprovalVerification[], over: Partial<VerificationSweepDeps> = {}) {
  const reminders: string[] = []
  const noResponses: Array<{ id: string; reason: string }> = []
  const probed: string[] = []
  const result = await runVerificationSweep({
    now: NOW,
    listPendingOlderThan: (cutoffSec) => rows.filter(r => r.status === 'pending' && r.requested_at <= cutoffSec),
    agentExists: () => true,
    isStillNeeded: () => true,
    sendReminder: (r) => { reminders.push(r.id); return true },
    markReminded: () => true,
    markNoResponse: (id, reason) => { noResponses.push({ id, reason }); return true },
    probeActivity: async (a) => { probed.push(a); return 'idle' },
    hasUndeliveredMessage: () => false,
    ...over,
  })
  return { result, reminders, noResponses, probed }
}

describe('a sopres nem dolgoztat tovabb lezart munkan', () => {
  it('a mar nem szukseges sort AZONNAL lezarja, emlekezteto nelkul', async () => {
    const { reminders, noResponses, result } = await sweep([pendingRow()], { isStillNeeded: () => false })

    expect(reminders).toEqual([])
    expect(noResponses).toEqual([{ id: 'a1:gemma', reason: NO_RESPONSE_NOT_WAITING }])
    expect(result.expired).toEqual(['a1:gemma'])
  })

  it('meg csak meg sem nezi, dolgozik-e az agens -- nincs pane-olvasas', async () => {
    const { probed } = await sweep([pendingRow()], { isStillNeeded: () => false })
    expect(probed).toEqual([])
  })

  it('az OK a munka megszunese, nem az agens hallgatasa (a sorrend szamit)', async () => {
    // Ugyanaz a sor ket okbol is lezarhato lenne. Amit kimondunk, az a
    // valodi ok: nem az agens tunt el, hanem a feladat.
    const { noResponses } = await sweep([pendingRow()], {
      isStillNeeded: () => false,
      agentExists: () => false,
    })
    expect(noResponses[0]!.reason).toBe(NO_RESPONSE_NOT_WAITING)
    expect(noResponses[0]!.reason).not.toBe(NO_RESPONSE_AGENT_GONE)
  })

  it('a meg ervenyes sort valtozatlanul noszogatja', async () => {
    const { reminders, noResponses } = await sweep([pendingRow()])
    expect(reminders).toEqual(['a1:gemma'])
    expect(noResponses).toEqual([])
  })
})

describe('a jovahagyas/kartya allapota dönti el, futhat-e ellenorzes', () => {
  function waitingCardWithApproval() {
    createKanbanCard({ id: 'c0ffee11', title: 'Valami kesz munka', status: 'in_progress' })
    moveKanbanCard('c0ffee11', 'waiting', 0, 'usalackor')
    const approval = ensureApprovalForWaitingCard('c0ffee11', 'usalackor')
    expect(approval).not.toBeNull()
    return approval!
  }

  it('varakozo kartya + fuggo jovahagyas -> indulhat', () => {
    const approval = waitingCardWithApproval()
    expect(verificationDispatchBlockedReason(approval)).toBeNull()
  })

  it('lezart jovahagyas -> nem indulhat', () => {
    const approval = waitingCardWithApproval()
    resolveApproval(approval.id, 'approved', 'boss', null, 'ok')
    const closed = pendingApprovalForCard('c0ffee11')
    expect(closed).toBeFalsy()
    // A friss allapotot kerdezzuk vissza, nem a regi objektumot.
    const after = { ...approval, status: 'approved' as const }
    expect(verificationDispatchBlockedReason(after)).toBe('approval_closed')
  })

  it('a kartya kikerult a varakozobol -> nem indulhat', () => {
    const approval = waitingCardWithApproval()
    moveKanbanCard('c0ffee11', 'done', 0, 'boss')
    expect(verificationDispatchBlockedReason(approval)).toBe('card_not_waiting')
  })

  it('kartya nelkuli jovahagyast nem tilt -- nem talalunk ki tiltast', () => {
    const approval = createApproval({
      id: 'e1', agent_id: 'usalackor', category: 'email_send',
      action_description: 'Level kikuldese egy igazolt cimre.',
      action_payload: null, timeout_at: null,
    })
    expect(verificationDispatchBlockedReason(approval)).toBeNull()
  })

  it('mindket tiltashoz emberi mondat tartozik, nem gepi kod', () => {
    for (const reason of ['approval_closed', 'card_not_waiting'] as const) {
      const msg = verifyBlockedMessage(reason)
      expect(msg.length).toBeGreaterThan(30)
      expect(msg).not.toContain('_')
    }
  })
})

describe('a futo ellenorzesek AZONNAL leallnak, nem a kovetkezo sopresre', () => {
  it('a kartya kimozgatasa lezarja a fuggo sorokat', () => {
    createKanbanCard({ id: 'dd001122', title: 'Kesz munka', status: 'in_progress' })
    moveKanbanCard('dd001122', 'waiting', 0, 'usalackor')
    const approval = ensureApprovalForWaitingCard('dd001122', 'usalackor')!
    createOrResetApprovalVerification(approval.id, 'gemma')
    createOrResetApprovalVerification(approval.id, 'lagunas')

    withdrawApprovalForCardLeavingWaiting('dd001122', 'done', 'boss')

    const rows = listApprovalVerifications(approval.id)
    expect(rows).toHaveLength(2)
    for (const r of rows) {
      expect(r.status).toBe('noresponse')
      expect(r.report).toBe(NO_RESPONSE_NOT_WAITING)
    }
    // ...es a sopres tobbe nem is talalja oket.
    expect(listPendingVerificationsOlderThan(Math.floor(Date.now() / 1000))).toEqual([])
  })

  it('a MAR BEJELENTETT eredmenyt soha nem irja felul', () => {
    const approval = createApproval({
      id: 'a9', agent_id: 'usalackor', category: 'kanban_done',
      action_description: 'Kartya kesz.', action_payload: null, timeout_at: null,
    })
    createOrResetApprovalVerification(approval.id, 'gemma')
    createOrResetApprovalVerification(approval.id, 'lagunas')
    resolveApprovalVerification(approval.id, 'gemma', 'fail', 'talaltam egy hibat')

    const stopped = stopVerificationsForApproval(approval.id, 'test')

    expect(stopped).toBe(1)
    const rows = listApprovalVerifications(approval.id)
    const gemma = rows.find(r => r.agent === 'gemma')!
    expect(gemma.status).toBe('fail')
    expect(gemma.report).toBe('talaltam egy hibat')
    expect(rows.find(r => r.agent === 'lagunas')!.status).toBe('noresponse')
  })

  it('ketszer lefuttatva nem csinal semmit masodszorra', () => {
    const approval = createApproval({
      id: 'a8', agent_id: 'usalackor', category: 'kanban_done',
      action_description: 'Kartya kesz.', action_payload: null, timeout_at: null,
    })
    createOrResetApprovalVerification(approval.id, 'gemma')
    expect(cancelPendingVerifications(approval.id, NO_RESPONSE_NOT_WAITING, 1)).toBe(1)
    expect(cancelPendingVerifications(approval.id, NO_RESPONSE_NOT_WAITING, 2)).toBe(0)
  })
})

describe('a leallitott ellenorzes nem rontja az agens megbizhatosag-jelzojet', () => {
  it('sem mellette, sem ellene nem szamit', () => {
    const rows: ApprovalVerification[] = [
      pendingRow({ id: 'x:pass', status: 'pass' }),
      pendingRow({ id: 'x:stopped', status: 'noresponse', report: NO_RESPONSE_NOT_WAITING }),
    ]
    const score = computeReliabilityScore(rows, NOW)
    expect(score.sampleSize).toBe(1)
    expect(score.stuckCount).toBe(0)
    expect(score.score).toBe(10)
  })

  it('a valodi hallgatas viszont tovabbra is szamit', () => {
    const rows: ApprovalVerification[] = [
      pendingRow({ id: 'y:pass', status: 'pass' }),
      pendingRow({ id: 'y:silent', status: 'noresponse', report: 'noresponse:timeout' }),
    ]
    const score = computeReliabilityScore(rows, NOW)
    expect(score.sampleSize).toBe(2)
    expect(score.stuckCount).toBe(1)
  })
})
