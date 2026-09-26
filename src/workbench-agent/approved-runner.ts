/**
 * JOVAHAGYAS UTAN A LEPES TENYLEG LEFUT (kanban #404, H2).
 *
 * Eddig a Munkapad-agens jovahagyast kert, es tovabblepett: futni csak akkor
 * futott a lepes, ha a modell ugyanabban a beszelgetesben SZO SZERINT azonos
 * bemenettel ujra kerte. Egy hosszu `file.write` szovegnel ez soha nem
 * tortent meg -- a tulajdonos "igen"-je utan semmi nem lett.
 *
 * Most a dontes utan a TAROLT bemenettel fut le (pontosan azzal, amit a
 * tulajdonos a jovahagyasban latott), es az eredmeny a beszelgetesbe kerul,
 * asszisztens-uzenetkent -- igy a modell is latja a kovetkezo fordulo
 * elozmenyeiben, hogy megtortent. Elutasitasnal a beszelgetes erről is
 * ertesul. Egy "igen" egy futas: a sort atomian foglaljuk le
 * (`claimAwaitingCall`), a sikeres futas `ok` sora a jegyet elhasznalja
 * (`isApprovalConsumed`).
 *
 * Harom helyrol hivodik, hogy semmi ne maradjon ki: a jovahagyas-dontes
 * vegpontjabol (azonnal), a beszelgetes betoltesekor, es egy fordulo elejen.
 */
import { getApproval } from '../db.js'
import { logger } from '../logger.js'
import { auditWorkbench } from './audit.js'
import { runTool } from './execute.js'
import { msg, type Lang } from './messages.js'
import {
  addAgentMessage, claimAwaitingCall, finishToolCall, getAgentSession, isApprovalConsumed, listAwaitingApprovalCalls, projectSessionKey,
} from './sessions.js'

const REJECTED = new Set(['rejected', 'timeout', 'withdrawn', 'expired'])

/** A lepes celja emberi nyelven (fajlnev, cim) -- ha a bemenetben van ilyen. */
export function targetOf(input: Record<string, unknown>): string {
  for (const k of ['path', 'name', 'filename', 'title', 'file', 'target']) {
    const v = input[k]
    if (typeof v === 'string' && v.trim()) return ` — ${v.trim().slice(0, 120)}`
  }
  return ''
}

/** Ki kerte a lepest (#406 bugkereses 5.) -- a jegy payloadjabol. Regi jegyben
 *  nincs benne: akkor null, es a lepes a korabbi alapertelmezessel fut. */
export function requesterOf(payload: string | null | undefined): string | null {
  try {
    const a = JSON.parse(payload || '{}')?.actor
    return typeof a === 'string' && a.trim() ? a.trim() : null
  } catch { return null }
}

let settling: Promise<number> | null = null

/**
 * A mar eldontott jovahagyasok feldolgozasa. Visszaadja, hany sort zart le.
 * Egyszerre egy fut: a masodik hivo megvarja az elsot, majd a sajatjat.
 */
export async function settleWorkbenchApprovals(sessionId?: string | null): Promise<number> {
  while (settling) { try { await settling } catch { /* a masik hibaja nem a mienk */ } }
  const p = settleOnce(sessionId)
  settling = p
  try { return await p } finally { if (settling === p) settling = null }
}

async function settleOnce(sessionId?: string | null): Promise<number> {
  let rows
  try { rows = listAwaitingApprovalCalls(sessionId) } catch { return 0 }
  let done = 0
  for (const row of rows) {
    const approval = row.approval_id ? getApproval(row.approval_id) : undefined
    if (!approval || approval.status === 'pending') continue
    const session = getAgentSession(row.session_id)
    if (!session) continue
    const lang: Lang = session.language === 'en' ? 'en' : 'hu'
    let input: Record<string, unknown> = {}
    try { input = JSON.parse(row.input_json || '{}') } catch { input = {} }
    const target = targetOf(input)
    const workItemId = session.work_item_id === projectSessionKey(session.project_id) ? null : session.work_item_id

    if (approval.status === 'approved') {
      if (!claimAwaitingCall(row.id)) continue
      // #406 bugkereses 2.: ha a jegyet kozben mar egy SIKERES futas
      // felhasznalta (a beszelgetes maga futtatta), ez a sor nem fut ujra --
      // egy "igen" egy futas. Ha nem tudjuk megnezni, szinten nem futtatjuk.
      let consumed = true
      try { consumed = isApprovalConsumed(row.approval_id as string) } catch { consumed = true }
      if (consumed) {
        finishToolCall(row.id, 'error', { code: 'approval_already_used' }, row.approval_id)
        logger.info({ id: row.id, approval: row.approval_id }, 'workbench: approved step already ran, not running it twice')
        continue
      }
      let result
      try {
        result = await runTool(row.tool_name, input, { projectId: session.project_id, workItemId, lang, actor: requesterOf(approval.action_payload) })
      } catch (e) {
        result = { ok: false as const, code: 'failed', detail: e instanceof Error ? e.message : String(e) }
      }
      if (result.ok) {
        finishToolCall(row.id, 'ok', result.data, row.approval_id)
        addAgentMessage(session.id, 'assistant', msg('tool_ran_after_approval', lang, { tool: row.tool_name, target }))
        auditWorkbench({ agent: approval.resolved_by || 'owner', tool: row.tool_name, op: 'approved-run', target: workItemId || session.project_id, cwd: session.project_id })
      } else {
        finishToolCall(row.id, 'error', { code: result.code, detail: result.detail }, row.approval_id)
        addAgentMessage(session.id, 'assistant', msg('tool_failed_after_approval', lang, { tool: row.tool_name, target, detail: result.detail }))
        auditWorkbench({ agent: approval.resolved_by || 'owner', tool: row.tool_name, op: 'error', target: workItemId || session.project_id, cwd: session.project_id })
      }
      done++
    } else if (REJECTED.has(approval.status)) {
      if (!claimAwaitingCall(row.id)) continue
      finishToolCall(row.id, 'rejected', { approvalStatus: approval.status }, row.approval_id)
      addAgentMessage(session.id, 'assistant', msg('tool_approval_rejected', lang, { tool: row.tool_name, target }))
      done++
    }
  }
  if (done) logger.info({ done }, 'workbench: settled decided approvals')
  return done
}
