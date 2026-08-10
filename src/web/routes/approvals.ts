import { randomUUID } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT, MAIN_AGENT_ID } from '../../config.js'
import {
  createApproval, getApproval, resolveApproval, listApprovals, expireTimedOutApprovals,
  createAgentMessage, moveKanbanCard, getKanbanCard, addKanbanComment,
  createOrResetApprovalVerification, listApprovalVerifications, resolveApprovalVerification,
  type Approval,
} from '../../db.js'
import { logger } from '../../logger.js'
import { readBody, json } from '../http-helpers.js'
import { agentDir } from '../agent-config.js'
import { startAgentProcess, isAgentRunning } from '../agent-process.js'
import type { RouteContext } from './types.js'

const AUTONOMY_CONFIG_PATH = join(PROJECT_ROOT, 'store', 'autonomy-config.json')

interface AutonomyCategory {
  key: string
  timeout_minutes?: number | null
}

interface AutonomyConfig {
  categories: AutonomyCategory[]
}

function getTimeoutAt(category: string): number | null {
  try {
    if (!existsSync(AUTONOMY_CONFIG_PATH)) return null
    const config = JSON.parse(readFileSync(AUTONOMY_CONFIG_PATH, 'utf-8')) as AutonomyConfig
    const cat = config.categories.find(c => c.key === category)
    if (!cat || cat.timeout_minutes == null) return null
    return Math.floor(Date.now() / 1000) + cat.timeout_minutes * 60
  } catch {
    return null
  }
}

function notifyMainAgent(approval: Approval): void {
  try {
    const content = [
      `[APPROVAL_REQUEST]`,
      `id=${approval.id}`,
      `agent=${approval.agent_id}`,
      `category=${approval.category}`,
      `action=${approval.action_description}`,
      `timeout_at=${approval.timeout_at ?? 'null'}`,
    ].join(' ')
    createAgentMessage('system', MAIN_AGENT_ID, content)
  } catch (err) {
    // Non-fatal: the approval is created regardless; main-agent notification is best-effort
    logger.warn({ err, approvalId: approval.id }, 'Failed to notify main agent of approval request')
  }
}

// Push the decision straight to the agent that asked -- Boss 2026-08-05: a
// rejection with no reason left the requester (usually this same main agent)
// with nothing to act on except polling and guessing. The requester is
// notified regardless of who resolved it (self-notify when agent_id ==
// MAIN_AGENT_ID is harmless and keeps this one code path for every case).
function notifyRequester(approval: Approval): void {
  try {
    const content = [
      `[APPROVAL_RESOLVED]`,
      `id=${approval.id}`,
      `status=${approval.status}`,
      `category=${approval.category}`,
      `resolved_by=${approval.resolved_by ?? 'unknown'}`,
      `reason=${approval.resolution_reason ?? ''}`,
    ].join(' ')
    createAgentMessage('system', approval.agent_id, content)
  } catch (err) {
    logger.warn({ err, approvalId: approval.id }, 'Failed to notify requester of approval resolution')
  }
}

// action_payload carries {"kanban_card_id": "..."} for approvals raised from
// a kanban card (see the "Jóváhagyásra küldés" button, web/app.js). Shared by
// the PATCH resolve handler (moves the card to done) and the verify-result
// handler (posts the finding as a comment) -- malformed/missing payload just
// means "no linked card", never an error worth surfacing.
function kanbanCardIdFromApproval(approval: Approval): string | null {
  if (!approval.action_payload) return null
  try {
    const payload = JSON.parse(approval.action_payload) as { kanban_card_id?: unknown }
    return typeof payload.kanban_card_id === 'string' ? payload.kanban_card_id : null
  } catch {
    return null
  }
}

export function startApprovalTimeoutSweeper(): NodeJS.Timeout {
  return setInterval(() => {
    try {
      const expired = expireTimedOutApprovals()
      if (expired > 0) logger.info({ expired }, 'Approval timeout sweep: expired pending approvals')
    } catch (err) {
      logger.warn({ err }, 'Approval timeout sweep failed')
    }
  }, 60_000)
}

export async function tryHandleApprovals(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx

  // POST /api/approvals -- create new approval request
  if (path === '/api/approvals' && method === 'POST') {
    let body: { agent_id?: unknown; category?: unknown; action_description?: unknown; action_payload?: unknown; noKanbanCard?: unknown }
    try {
      body = JSON.parse((await readBody(req)).toString())
    } catch {
      json(res, { error: 'Invalid JSON' }, 400)
      return true
    }

    const { agent_id, category, action_description, action_payload, noKanbanCard } = body
    if (typeof agent_id !== 'string' || !agent_id.trim()) {
      json(res, { error: 'agent_id is required' }, 400)
      return true
    }
    if (typeof category !== 'string' || !category.trim()) {
      json(res, { error: 'category is required' }, 400)
      return true
    }
    if (typeof action_description !== 'string' || !action_description.trim()) {
      json(res, { error: 'action_description is required' }, 400)
      return true
    }
    if (action_payload !== undefined && typeof action_payload !== 'string') {
      json(res, { error: 'action_payload must be a string (JSON) if provided' }, 400)
      return true
    }

    // Boss 2026-08-10 ("ne is jöhessen létre kártya nélkül"): every
    // approval must be traceable back to a kanban card, either via the
    // structured payload (kanban_done's own contract, see the
    // kanban-approval-workflow skill) or a bare 8-hex-char id somewhere in
    // the description (the fallback the dashboard's "Kártya megnyitása"
    // button now also scrapes for, web/app.js _approvalKanbanCardId).
    // A handful of approval categories genuinely have nothing to do with a
    // kanban card (e.g. an autonomy-level email/payment approval from the
    // CLAUDE.md Level 2 flow) -- those must pass `noKanbanCard: true`
    // explicitly rather than being silently exempted by category name,
    // so the choice is always a deliberate one, not a default.
    if (noKanbanCard !== true) {
      let hasCardRef = false
      if (typeof action_payload === 'string') {
        try {
          const parsed = JSON.parse(action_payload) as { kanban_card_id?: unknown }
          hasCardRef = typeof parsed?.kanban_card_id === 'string' && parsed.kanban_card_id.length > 0
        } catch { /* not JSON / no kanban_card_id -> falls through to the text scrape below */ }
      }
      if (!hasCardRef) hasCardRef = /\b[0-9a-f]{8}\b/i.test(action_description)
      if (!hasCardRef) {
        json(res, {
          error: 'Ez a jóváhagyás-kérés nem hivatkozik kanban kártyára (se action_payload.kanban_card_id, se 8-jegyű azonosító a leírásban). ' +
            'Ha tényleg nincs kapcsolódó kártya (pl. email/fizetés jóváhagyás), küldd el "noKanbanCard": true mezővel is.',
        }, 400)
        return true
      }
    }

    const id = randomUUID()
    const timeout_at = getTimeoutAt(category)
    const approval = createApproval({
      id,
      agent_id: agent_id.trim(),
      category: category.trim(),
      action_description: action_description.trim(),
      action_payload: typeof action_payload === 'string' ? action_payload : null,
      timeout_at,
    })

    notifyMainAgent(approval)
    logger.info({ id, agent_id, category }, 'Approval request created')
    json(res, approval, 201)
    return true
  }

  // GET /api/approvals -- list with filters
  if (path === '/api/approvals' && method === 'GET') {
    const agent_id = url.searchParams.get('agent') ?? undefined
    const category = url.searchParams.get('category') ?? undefined
    const status = url.searchParams.get('status') ?? undefined
    const limitRaw = url.searchParams.get('limit')
    const limit = limitRaw ? Math.min(parseInt(limitRaw, 10) || 100, 500) : 100

    const items = listApprovals({ agent_id, category, status, limit })
    // Embed each approval's verification rows so the dashboard list can show
    // the green-check/red-X state without an extra round trip per row.
    const withVerifications = items.map(a => ({ ...a, verifications: listApprovalVerifications(a.id) }))
    json(res, withVerifications)
    return true
  }

  // GET /api/approvals/:id -- status poll
  const idMatch = path.match(/^\/api\/approvals\/([^/]+)$/)
  if (idMatch && method === 'GET') {
    const approval = getApproval(idMatch[1])
    if (!approval) {
      json(res, { error: 'Not found' }, 404)
      return true
    }
    json(res, { ...approval, verifications: listApprovalVerifications(approval.id) })
    return true
  }

  // PATCH /api/approvals/:id -- resolve (approve/reject/timeout)
  if (idMatch && method === 'PATCH') {
    let body: { status?: unknown; resolved_by?: unknown; telegram_message_id?: unknown; reason?: unknown }
    try {
      body = JSON.parse((await readBody(req)).toString())
    } catch {
      json(res, { error: 'Invalid JSON' }, 400)
      return true
    }

    const { status, resolved_by, telegram_message_id, reason } = body
    if (status !== 'approved' && status !== 'rejected' && status !== 'timeout') {
      json(res, { error: 'status must be approved, rejected, or timeout' }, 400)
      return true
    }
    if (typeof resolved_by !== 'string' || !resolved_by.trim()) {
      json(res, { error: 'resolved_by is required' }, 400)
      return true
    }
    const msgId = typeof telegram_message_id === 'number' ? telegram_message_id : null
    const resolutionReason = typeof reason === 'string' && reason.trim() ? reason.trim() : null

    // Self-approval guard: the requesting agent cannot approve its own request.
    // This is a best-effort check on the self-declared resolved_by value (all fleet
    // agents share the same bearer token, so server-side identity is not enforceable).
    // It catches naive/accidental self-approvals; the real control lives on the
    // main-agent side (approval-request-handling skill).
    const target = getApproval(idMatch[1])
    if (target && resolved_by.trim() === target.agent_id) {
      json(res, { error: 'The requesting agent cannot approve its own request' }, 403)
      return true
    }

    const updated = resolveApproval(idMatch[1], status, resolved_by.trim(), msgId, resolutionReason)
    if (!updated) {
      // Either not found or already resolved
      const existing = getApproval(idMatch[1])
      if (!existing) {
        json(res, { error: 'Not found' }, 404)
      } else {
        json(res, { error: `Already resolved as ${existing.status}` }, 409)
      }
      return true
    }

    const approval = getApproval(idMatch[1])
    logger.info({ id: idMatch[1], status, resolved_by, reason: resolutionReason }, 'Approval resolved')
    if (approval) notifyRequester(approval)
    // Closes the loop Boss asked for (2026-08-05): "amikor en ott nyomom hogy
    // ok, akkor kerüljön at a kesz dobozba" -- clicking approve on a
    // kanban_done request is itself what moves the card to "done", not a
    // separate agent poll-then-PUT step. action_payload carries
    // {"kanban_card_id": "..."} (see the "Jóváhagyásra küldés" button on the
    // kanban card detail modal, web/app.js). Best-effort: a malformed/missing
    // payload or an already-archived card just skips this, never blocks the
    // approval response itself.
    if (approval && status === 'approved' && approval.category === 'kanban_done') {
      const linkedCardId = kanbanCardIdFromApproval(approval)
      if (linkedCardId) {
        try {
          const card = getKanbanCard(linkedCardId)
          if (card) moveKanbanCard(card.id, 'done', card.sort_order, resolved_by.trim())
        } catch { /* malformed payload -- approval itself already succeeded, don't fail the request over this */ }
      }
    }
    json(res, approval)
    return true
  }

  // POST /api/approvals/:id/verify -- dispatch a review of this approval to
  // 1+ agents (Boss 2026-08-08: "jóváhagyás előtt ellenőriztessük le
  // ingyenes modellekkel"). Each named agent gets a fresh 'pending' row and
  // an inter-agent task instructing it to review the change and report back
  // via POST .../verify-result -- decoupled from any particular session
  // being alive to relay the answer (unlike a plain inter-agent reply, which
  // only the ORIGINAL requester's live session would see).
  const verifyMatch = path.match(/^\/api\/approvals\/([^/]+)\/verify$/)
  if (verifyMatch && method === 'POST') {
    const approvalId = verifyMatch[1]
    const approval = getApproval(approvalId)
    if (!approval) { json(res, { error: 'Not found' }, 404); return true }

    let body: { agents?: unknown }
    try {
      body = JSON.parse((await readBody(req)).toString())
    } catch {
      json(res, { error: 'Invalid JSON' }, 400)
      return true
    }
    const agents = Array.isArray(body.agents) ? body.agents.filter((a): a is string => typeof a === 'string' && a.trim().length > 0) : []
    if (agents.length === 0) { json(res, { error: 'agents (non-empty string array) is required' }, 400); return true }

    const dispatched: string[] = []
    const failed: Array<{ agent: string; error: string }> = []
    // OpenRouter's :free models share a single 20 req/min budget ACROSS THE
    // WHOLE ACCOUNT, not per agent (kanban 45c3cfad, Boss 2026-08-08: several
    // agents 429'd simultaneously when a 14-agent verification round fired
    // near-instantly). This loop used to sleep between free-tier sends to pace
    // them, which paced only ITSELF -- a second round overlapping this one blew
    // the shared ceiling anyway, and a 12-agent pick held the HTTP response open
    // for ~44s. The pacing now lives in the message router, on process-wide
    // state every dispatch path shares (see src/openrouter-dispatch-throttle.ts),
    // so this endpoint just queues the work and answers immediately. The
    // verification rows below are created up front, so the UI shows each agent
    // as pending while the router feeds them out under the shared budget.
    for (const agent of agents) {
      if (agent === approval.agent_id) {
        // The requester verifying its own work defeats the point -- same
        // guard as the self-approval check on PATCH, applied here too.
        failed.push({ agent, error: 'The requesting agent cannot verify its own request' })
        continue
      }
      if (!existsSync(agentDir(agent))) {
        failed.push({ agent, error: 'Agent not found' })
        continue
      }
      if (!isAgentRunning(agent)) {
        const startResult = startAgentProcess(agent)
        if (!startResult.ok) {
          failed.push({ agent, error: startResult.error || 'Failed to start agent' })
          continue
        }
      }
      createOrResetApprovalVerification(approvalId, agent)
      const prompt = [
        `Ellenorzesi feladat (Boss kerte, jovahagyas elott): nezd at ezt a fuggo jovahagyast alaposan.`,
        `Kategoria: ${approval.category}`,
        `Leiras: ${approval.action_description}`,
        ``,
        `Ellenorizd a KODOT (git log/git show/git diff a relevans commitra, ha a leiras emlit egyet) ES ha a valtoztatas`,
        `dashboardon lathato UI-funkciot erint, probald ki tenylegesen is amennyire tudod (pl. curl-lel a relevans API vegpontokat, `,
        `vagy a fajlokban keresve hogy a UI-elem tenyleg megvan-e amit a leiras allit).`,
        ``,
        `Amikor kesz vagy, jelentsd vissza az eredmenyt EZZEL a hivassal (KOTELEZO, ne csak inter-agent uzenettel):`,
        `curl -s -X POST http://localhost:3420/api/approvals/${approvalId}/verify-result \\`,
        `  -H "Content-Type: application/json" \\`,
        `  -H "Authorization: Bearer $(cat /home/boss/marveen/store/.dashboard-token)" \\`,
        `  -d '{"agent":"${agent}","status":"pass","report":"rovid osszefoglalo"}'`,
        ``,
        `status legyen "pass" ha minden rendben, vagy "fail" ha barmi problemat talalsz -- a report mezoben`,
        `RÖVIDEN indokold (max nehany mondat), fail eseten konkretan mit talaltal hibasnak.`,
      ].join('\n')
      try {
        createAgentMessage(MAIN_AGENT_ID, agent, prompt)
        dispatched.push(agent)
      } catch (err) {
        failed.push({ agent, error: err instanceof Error ? err.message : 'Failed to dispatch' })
      }
    }
    logger.info({ approvalId, dispatched, failed }, 'Approval verification dispatched')
    json(res, { ok: true, dispatched, failed })
    return true
  }

  // POST /api/approvals/:id/verify-result -- an agent reports its verification
  // finding. Any agent can call this for itself (same bearer-token trust model
  // as every other fleet-facing endpoint); it only ever resolves the row for
  // the (approval, agent) pair named in the body, never someone else's.
  const verifyResultMatch = path.match(/^\/api\/approvals\/([^/]+)\/verify-result$/)
  if (verifyResultMatch && method === 'POST') {
    const approvalId = verifyResultMatch[1]
    if (!getApproval(approvalId)) { json(res, { error: 'Not found' }, 404); return true }

    let body: { agent?: unknown; status?: unknown; report?: unknown }
    try {
      body = JSON.parse((await readBody(req)).toString())
    } catch {
      json(res, { error: 'Invalid JSON' }, 400)
      return true
    }
    const { agent, status, report } = body
    if (typeof agent !== 'string' || !agent.trim()) { json(res, { error: 'agent is required' }, 400); return true }
    if (status !== 'pass' && status !== 'fail') { json(res, { error: 'status must be pass or fail' }, 400); return true }
    const reportText = typeof report === 'string' ? report.trim().slice(0, 2000) : null

    const updated = resolveApprovalVerification(approvalId, agent.trim(), status, reportText)
    if (!updated) { json(res, { error: 'No pending verification for this approval/agent -- was it dispatched via /verify?' }, 404); return true }
    logger.info({ approvalId, agent, status }, 'Approval verification resolved')

    // Boss 2026-08-08: "el is lehetne azt is tárolni, hogy mit talált, és a
    // kártyába is tegye hozzá" -- if this approval traces back to a kanban
    // card, leave the finding as a comment there too, not just on the
    // approval row, so the context lives next to the actual task. Best-effort:
    // no linked card (most approvals) or a comment-write failure never blocks
    // the verify-result response itself.
    const approvalForComment = getApproval(approvalId)
    const linkedCardId = approvalForComment ? kanbanCardIdFromApproval(approvalForComment) : null
    if (linkedCardId) {
      try {
        const icon = status === 'pass' ? '✅' : '❌'
        addKanbanComment(linkedCardId, agent.trim(), `${icon} Ellenőrzés (${status}): ${reportText || '(nincs indoklás)'}`)
      } catch (err) {
        logger.warn({ err, approvalId, linkedCardId }, 'Failed to post verification result as a kanban comment')
      }
    }
    json(res, { ok: true })
    return true
  }

  // GET /api/approvals/:id/verify -- list verification rows for this approval
  // (poll target for the dashboard while agents are still reviewing).
  if (verifyMatch && method === 'GET') {
    const approvalId = verifyMatch[1]
    if (!getApproval(approvalId)) { json(res, { error: 'Not found' }, 404); return true }
    json(res, listApprovalVerifications(approvalId))
    return true
  }

  return false
}
