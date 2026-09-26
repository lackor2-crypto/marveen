/**
 * JOVAHAGYAS MUNKADARABRA (kanban #406, 9. pont).
 *
 * Ugyanaz, mint a kartyaknal: a munkadarab "kesz, jovahagyasra var" allapotba
 * kerul (status = review), ehhez a MEGLEVO jovahagyas-rendszerben (approvals
 * tabla) egy jegy keletkezik, es a tulajdonos egy gombbal elfogadja (-> done)
 * vagy visszadobja (-> in_progress, az indoklassal).
 *
 * Nem uj mechanizmus: a jegy ugyanabba a listaba kerul, amit a Jovahagyasok
 * oldal mutat, es ha ott dontenek rola, a munkadarab ugyanugy atall
 * (`applyWorkItemApprovalOutcome`, a PATCH /api/approvals/:id hivja).
 *
 * A jegy payloadja `{ kind, project, workItem }` -- a `project` kulcs miatt az
 * attekinto es az idovonal magatol a projekthez sorolja. A leirasba SZANDEKOSAN
 * nem kerul a munkadarab 8 karakteres azonositoja: a jovahagyasok feluletei a
 * leirasban talalt 8-hex szot kartya-azonositonak olvassak.
 *
 * A "done"-t csak a tulajdonos adhatja: a dontes a route-on bejelentkezett
 * munkamenethez kotott (az agensek kozos tokenje nem donthet).
 */
import { randomUUID } from 'node:crypto'
import { getDb, createApproval, createAgentMessage, getApproval, resolveApproval } from './db.js'
import type { Approval } from './db.js'
import { MAIN_AGENT_ID } from './config.js'
import { getProject } from './projects.js'
import { ensureWorkbenchTables, getWorkItem } from './workbench.js'
import type { WorkItemRow, WorkItemStatus } from './workbench.js'
import { logger } from './logger.js'

export const WORK_ITEM_APPROVAL_CATEGORY = 'workbench_item_done'
export const WORK_ITEM_APPROVAL_KIND = 'work_item_done'
export const APPROVAL_REASON_MAX = 1000

type Lang = 'hu' | 'en'

export interface WorkItemApprovalView {
  id: string
  status: string
  reason: string | null
  requested_at: number
  resolved_at: number | null
  resolved_by: string | null
}

export type ApprovalActionCode =
  | 'already_done' | 'not_in_review' | 'no_pending' | 'reason_too_long' | 'bad_action'

export type ApprovalActionResult =
  | { ok: true; item: WorkItemRow; approval: WorkItemApprovalView | null }
  | { ok: false; code: ApprovalActionCode }

function view(a: Approval | undefined): WorkItemApprovalView | null {
  if (!a) return null
  return {
    id: a.id,
    status: a.status,
    reason: a.resolution_reason ?? null,
    requested_at: a.requested_at,
    resolved_at: a.resolved_at ?? null,
    resolved_by: a.resolved_by ?? null,
  }
}

function payloadItemId(a: { category: string; action_payload: string | null }): string | null {
  if (a.category !== WORK_ITEM_APPROVAL_CATEGORY || !a.action_payload) return null
  try {
    const p = JSON.parse(a.action_payload) as Record<string, unknown>
    return p && p['kind'] === WORK_ITEM_APPROVAL_KIND && typeof p['workItem'] === 'string' ? p['workItem'] : null
  } catch { return null }
}

/** A munkadarab jegyei, a legfrissebb elol. */
export function listWorkItemApprovals(itemId: string): Approval[] {
  const rows = getDb().prepare(
    'SELECT * FROM approvals WHERE category = ? AND action_payload LIKE ? ORDER BY requested_at DESC, rowid DESC',
  ).all(WORK_ITEM_APPROVAL_CATEGORY, `%${itemId}%`) as Approval[]
  return rows.filter((a) => payloadItemId(a) === itemId)
}

export function pendingWorkItemApproval(itemId: string): Approval | undefined {
  return listWorkItemApprovals(itemId).find((a) => a.status === 'pending')
}

/** Amit a felulet mutat: a nyitott jegy, vagy ha nincs, a legutobbi. */
export function workItemApprovalState(itemId: string): WorkItemApprovalView | null {
  const all = listWorkItemApprovals(itemId)
  return view(all.find((a) => a.status === 'pending') || all[0])
}

function setStatus(itemId: string, status: WorkItemStatus): WorkItemRow {
  ensureWorkbenchTables()
  getDb().prepare('UPDATE work_items SET status = ?, updated_at = ? WHERE id = ?')
    .run(status, Math.floor(Date.now() / 1000), itemId)
  return getWorkItem(itemId)!
}

function describe(item: WorkItemRow, lang: Lang, actor: string | null): string {
  let projectName = ''
  try { projectName = getProject(item.project_id)?.name ?? '' } catch { projectName = '' }
  const who = actor ? (lang === 'en' ? ` Sent by: ${actor}.` : ` Beküldte: ${actor}.`) : ''
  return lang === 'en'
    ? `Work item "${item.title}" (project: ${projectName}) is finished and waits for your approval. Approve it to mark it done, or send it back with a note.${who}`
    : `A(z) „${item.title}” munkadarab (projekt: ${projectName}) elkészült, és a jóváhagyásodra vár. Ha elfogadod, kész lesz; ha visszadobod, írd meg, mit javítsunk.${who}`
}

/**
 * "Kesz, jovahagyasra var": review allapot + jegy. Idempotens: ha mar van
 * nyitott jegy, nem keletkezik masodik.
 */
export function submitWorkItemForApproval(itemId: string, opts: { actor?: string | null; lang?: Lang } = {}): ApprovalActionResult {
  const item = getWorkItem(itemId)
  if (!item) throw new Error('work item not found')
  if (item.status === 'done') return { ok: false, code: 'already_done' }
  const open = pendingWorkItemApproval(itemId)
  if (open) {
    const it = item.status === 'review' ? item : setStatus(itemId, 'review')
    return { ok: true, item: it, approval: view(open) }
  }
  const description = describe(item, opts.lang === 'en' ? 'en' : 'hu', opts.actor ?? null)
  const approval = createApproval({
    id: randomUUID(),
    // A kartyakhoz hasonloan a jegy gazdaja a fo agens (a Munkapad az o
    // neveben dolgozik); a bekuldo neve a leirasba kerul.
    agent_id: MAIN_AGENT_ID,
    category: WORK_ITEM_APPROVAL_CATEGORY,
    action_description: description,
    action_payload: JSON.stringify({ kind: WORK_ITEM_APPROVAL_KIND, project: item.project_id, workItem: item.id }),
  })
  const it = setStatus(itemId, 'review')
  try {
    createAgentMessage('system', MAIN_AGENT_ID, [
      '[APPROVAL_REQUEST]', `id=${approval.id}`, `agent=${MAIN_AGENT_ID}`,
      `category=${WORK_ITEM_APPROVAL_CATEGORY}`, `action=${description}`, 'timeout_at=null',
    ].join(' '))
  } catch (err) {
    logger.warn({ err, approvalId: approval.id }, 'workbench: work item approval notification failed')
  }
  return { ok: true, item: it, approval: view(approval) }
}

/** A bekuldo visszavonja a kerest (meg dolgozna rajta): a jegy 'withdrawn',
 *  a munkadarab ujra 'in_progress'. Nem itelet, ezert nem 'rejected'. */
export function withdrawWorkItemApproval(itemId: string, opts: { actor?: string | null; lang?: Lang } = {}): ApprovalActionResult {
  const item = getWorkItem(itemId)
  if (!item) throw new Error('work item not found')
  if (item.status !== 'review') return { ok: false, code: 'not_in_review' }
  const open = pendingWorkItemApproval(itemId)
  if (open) {
    resolveApproval(open.id, 'withdrawn', (opts.actor || 'dashboard').trim(), null,
      opts.lang === 'en'
        ? 'The request was withdrawn on the Workbench; the work item is being worked on again.'
        : 'A kérést a Munkapadon visszavonták; a munkadarabon tovább dolgoznak.')
  }
  const it = setStatus(itemId, 'in_progress')
  return { ok: true, item: it, approval: workItemApprovalState(itemId) }
}

/** A tulajdonos dontese a Munkapadon. */
export function decideWorkItemApproval(
  itemId: string, decision: 'approved' | 'rejected', opts: { by: string; reason?: unknown },
): ApprovalActionResult {
  const item = getWorkItem(itemId)
  if (!item) throw new Error('work item not found')
  const reason = typeof opts.reason === 'string' && opts.reason.trim() ? opts.reason.trim() : null
  if (reason && reason.length > APPROVAL_REASON_MAX) return { ok: false, code: 'reason_too_long' }
  const open = pendingWorkItemApproval(itemId)
  if (!open) return { ok: false, code: 'no_pending' }
  if (!resolveApproval(open.id, decision, opts.by, null, reason)) return { ok: false, code: 'no_pending' }
  applyWorkItemApprovalOutcome(open.id)
  return { ok: true, item: getWorkItem(itemId)!, approval: view(getApproval(open.id)) }
}

/**
 * A jegy lezarasa utan a munkadarab kovesse a dontest -- akarhonnan jott
 * (Munkapad gombja vagy a Jovahagyasok oldal). Csak review allapotu darabot
 * mozgat, igy a mar tovabblepett (pl. visszavont) darabot nem irja felul.
 * Lejaratnal (timeout) NEM dont: a darab review-ban marad, a felulet
 * ujrakuldest ajanl.
 */
export function applyWorkItemApprovalOutcome(approvalId: string): WorkItemRow | null {
  try {
    const a = getApproval(approvalId)
    if (!a) return null
    const itemId = payloadItemId(a)
    if (!itemId) return null
    const item = getWorkItem(itemId)
    if (!item || item.status !== 'review') return null
    if (a.status === 'approved') return setStatus(itemId, 'done')
    if (a.status === 'rejected') return setStatus(itemId, 'in_progress')
    return null
  } catch (err) {
    logger.warn({ err, approvalId }, 'workbench: applying approval outcome to work item failed')
    return null
  }
}
