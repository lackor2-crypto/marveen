import { randomUUID } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT, MAIN_AGENT_ID, currentOwnerName } from '../../config.js'
import {
  createApproval, getApproval, resolveApproval, listApprovals, expireTimedOutApprovals,
  createAgentMessage, moveKanbanCard, getKanbanCard, addKanbanComment,
  createOrResetApprovalVerification, listApprovalVerifications, resolveApprovalVerification,
  listPendingApprovals, updateApprovalDescription,
  type Approval,
} from '../../db.js'
import { logger } from '../../logger.js'
import { loadAutonomyConfig, effectiveLevel } from '../../autonomy.js'
import { readBody, json } from '../http-helpers.js'
import { agentDir, listAgentNames, readAgentDisplayName } from '../agent-config.js'
import { currentBotName } from '../../config.js'
import { startAgentProcess, isAgentRunning, sessionExistsOnHost } from '../agent-process.js'
import { isMainChannelsAgent, MAIN_CHANNELS_SESSION } from '../main-agent.js'
import { listKanbanCards } from '../../db.js'
import { similarCardsBeforeClose, approvalCardId } from '../../kanban-related.js'
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

// Boss, 2026-08-27 (Telegram 593): "a jovoben soha ne kelljen ilyet csinalni
// hogy brmit jova kelljen hagyni nekem. csak mert a marveen t modositom.
// akarmelyik agenttel."
//
// The autonomy levels used to be advice only: they were written into every
// agent's CLAUDE.md and nothing checked them here, so an agent that had not
// re-read its file -- or was simply being careful -- still filed a request and
// the owner still got pinged. That is precisely the friction he asked to be
// rid of. So the level is now ENFORCED at the point the request arrives: if
// this agent already stands at level 3 for this category, the request is
// created AND resolved in the same breath, and nobody is woken up.
//
// It is created rather than rejected outright so the action still leaves a row
// in the approvals list -- resolved_by 'autonomy' says who decided and why. An
// unreadable config grants nothing: the request goes to the owner as before.
function autonomyGrantsCategory(agentId: string, category: string): { granted: boolean; level: number } {
  try {
    const config = loadAutonomyConfig()
    const cat = config.categories.find(c => c.key === category)
    if (!cat) return { granted: false, level: 0 }
    const level = effectiveLevel(cat, agentId, config)
    return { granted: level >= 3, level }
  } catch {
    return { granted: false, level: 0 }
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

/**
 * The invariant itself, checked as a whole rather than trusted event by event.
 *
 * The raising and withdrawing halves above hang off the two HTTP routes, so
 * anything that moves a card by another path leaves the counts drifting --
 * and there IS such a path: the stuck-task watchdog moves cards straight
 * through the db layer (markScheduledTaskKanbanWaiting). Old rows created
 * before either half existed drift the same way; the live board had four of
 * them when this was written.
 *
 * So once a minute both directions are re-established from the actual state:
 *   - a waiting card with no open request gets one raised,
 *   - an open `kanban_done` request whose card is no longer waiting (or no
 *     longer exists) is closed as `timeout`, never as a verdict.
 * Everything it does is logged, and it never touches other categories.
 */
export function reconcileWaitingApprovals(): { raised: number; withdrawn: number } {
  let raised = 0
  let withdrawn = 0
  try {
    const cards = listKanbanCards()
    for (const card of cards) {
      if (card.status !== 'waiting') continue
      if (pendingApprovalForCard(card.id)) continue
      if (ensureApprovalForWaitingCard(card.id, 'reconcile')) raised++
    }
    const byId = new Map(cards.map(c => [c.id, c]))
    for (const pending of listPendingApprovals()) {
      if (pending.category !== 'kanban_done') continue
      const cardId = approvalCardId(pending.action_payload, pending.action_description)
      if (!cardId) continue
      // Prefix tolerance, same as pendingApprovalForCard: descriptions carry an
      // 8-hex short id while the card row holds the full one.
      const card = byId.get(cardId)
        || cards.find(c => c.id.startsWith(cardId) || cardId.startsWith(c.id))
      if (card && card.status === 'waiting') continue
      const hol = card ? `a(z) "${card.status}" oszlopban van` : 'már nem létezik'
      const ok = resolveApproval(
        pending.id, 'timeout', MAIN_AGENT_ID, null,
        `A kérés tárgya nem várakozik döntésre: a kártya ${hol}. Az egyeztetés zárta le `
        + 'automatikusan, nem Boss döntése -- ha a munka ismét várakozóba kerül, új kérés keletkezik.',
      )
      if (ok) withdrawn++
    }
    if (raised || withdrawn) {
      logger.info({ raised, withdrawn }, 'Waiting/approval invariant reconciled')
    }
  } catch (err) {
    // Bookkeeping only: never let this take the sweeper (or the process) down.
    logger.warn({ err }, 'Waiting/approval reconcile failed')
  }
  return { raised, withdrawn }
}

export function startApprovalTimeoutSweeper(): NodeJS.Timeout {
  return setInterval(() => {
    try {
      const expired = expireTimedOutApprovals()
      if (expired > 0) logger.info({ expired }, 'Approval timeout sweep: expired pending approvals')
      // Same tick, same cheap SQLite reads: keep the waiting column and the
      // approvals list numerically identical, whatever moved the cards.
      reconcileWaitingApprovals()
    } catch (err) {
      logger.warn({ err }, 'Approval timeout sweep failed')
    }
  }, 60_000)
}

/** The pending approval already open for this card, if there is one. */
export function pendingApprovalForCard(cardId: string): Approval | undefined {
  return listPendingApprovals().find(a => {
    const id = approvalCardId(a.action_payload, a.action_description)
    return id != null && (id === cardId || cardId.startsWith(id) || id.startsWith(cardId))
  })
}

/**
 * Raise the approval that a card entering `waiting` implies.
 *
 * Boss, 2026-08-11: "ha mar egyszer bekerult a varakozo kanban dobozba akkor
 * mar bent kellene lennie a jovairasokban!!! az hogy betesz barki barmit a
 * varakozoba, az valtja ki hogy a jovairasba is bekeruljon!" -- and he is
 * right about the semantics too: a card may only enter waiting once the work
 * on it is finished. `waiting` therefore MEANS "done, awaiting Boss", and a
 * waiting card with nobody being asked is a card parked in silence.
 *
 * The audit found four of those on the live board, which is what a
 * separate-step design produces: the move and the request were two actions,
 * and the second one is the one that gets forgotten. So the move raises it
 * itself, from the dashboard drag just as much as from the API.
 *
 * Idempotent on purpose -- a card dragged out of waiting and back must not
 * stack up requests, and an agent that afterwards files its own properly
 * written request updates this one rather than adding a second.
 */
export function ensureApprovalForWaitingCard(
  cardId: string, actor?: string | null, descriptionOverride?: string | null,
): Approval | null {
  try {
    if (pendingApprovalForCard(cardId)) return null
    const card = getKanbanCard(cardId)
    if (!card) return null
    const requester = (actor || card.assignee || MAIN_AGENT_ID).trim()
    // The default text states that the work is finished, because that is what a
    // card entering waiting normally means. One caller parks a card in waiting
    // for the opposite reason -- a scheduled task that may be STUCK -- and must
    // not have that claim written in its name, so it passes its own wording.
    const approval = createApproval({
      id: randomUUID(),
      agent_id: requester,
      category: 'kanban_done',
      action_description: descriptionOverride?.trim()
        || `Kártya: ${card.title} (${card.id}) -- várakozóba került, tehát a munka elkészült rajta. `
        + 'Ezt a kérést a kártya mozgatása hozta létre automatikusan, ezért még nincs benne, mi lett tesztelve: '
        + `a felelős ágens egészítse ki, mielőtt ${currentOwnerName()} dönt.`,
      action_payload: JSON.stringify({ kanban_card_id: card.id }),
      timeout_at: getTimeoutAt('kanban_done'),
    })
    notifyMainAgent(approval)
    logger.info({ cardId, requester, approvalId: approval.id }, 'Approval auto-raised for card entering waiting')
    return approval
  } catch (err) {
    // Non-fatal: the move itself already succeeded and must not be undone by a
    // bookkeeping failure. The kanban-audit sweep catches what slips through.
    logger.warn({ err, cardId }, 'Failed to auto-raise approval for waiting card')
    return null
  }
}

/**
 * The other half of the same invariant: a card that LEAVES waiting must not
 * leave an open request standing behind it.
 *
 * Boss, 2026-08-16: "a jovahagyasok menupont alatt 19 van soron ami jovahagyasra
 * var. de a kanban ban a varakozoban pedig kevesebb van. ennek a kettonek
 * pontosan ugyanannak a szamnak kellene lennie." He is right, and until now the
 * mechanism only had an entering side -- so pulling a card back to in_progress
 * left its request pending forever. That is exactly what the audit kept
 * reporting as orphans, and what made the two counts drift apart.
 *
 * Resolved as `timeout`, deliberately not `rejected`: Boss did not judge the
 * work, the card simply went back to being worked on. `rejected` would land in
 * the red "elutasitva" column and imply a verdict nobody gave. The reason line
 * says which column it moved to, so the history stays readable.
 *
 * Only the auto-raised `kanban_done` request is touched. A pending request of
 * any other category that happens to mention the same card belongs to somebody
 * else's workflow and is left alone.
 */
export function withdrawApprovalForCardLeavingWaiting(
  cardId: string, newStatus: string, actor?: string | null,
): boolean {
  try {
    const pending = pendingApprovalForCard(cardId)
    if (!pending || pending.category !== 'kanban_done') return false
    const resolvedBy = (actor || MAIN_AGENT_ID).trim()
    const ok = resolveApproval(
      pending.id, 'timeout', resolvedBy, null,
      `A kártya átkerült a(z) "${newStatus}" oszlopba, tehát már nem várakozik döntésre. `
      + 'A kérést a mozgatás zárta le automatikusan, nem Boss döntése -- ha a munka később '
      + 'ismét várakozóba kerül, új kérés keletkezik.',
    )
    if (ok) {
      logger.info({ cardId, newStatus, approvalId: pending.id },
        'Approval withdrawn for card leaving waiting')
    }
    return ok
  } catch (err) {
    // Non-fatal for the same reason as the raising side: the move already
    // succeeded and must not be undone by bookkeeping.
    logger.warn({ err, cardId }, 'Failed to withdraw approval for card leaving waiting')
    return false
  }
}


/**
 * Map whatever the caller called itself to this install's canonical agent id.
 *
 * Accepts the id itself (unchanged), the main agent's display name, or any
 * sub-agent's display name. Anything unrecognised is returned as-is: a wrong
 * guess here would misfile the request, and an unknown name is more likely a
 * new agent than a typo.
 */
export function canonicalAgentId(raw: string): string {
  const value = raw.trim()
  if (!value) return value
  if (value === MAIN_AGENT_ID) return value
  if (value.toLowerCase() === currentBotName().toLowerCase()) return MAIN_AGENT_ID
  try {
    for (const name of listAgentNames()) {
      if (name === value) return name
      if (readAgentDisplayName(name).toLowerCase() === value.toLowerCase()) return name
    }
  } catch { /* agent listing unavailable -- fall through to the raw value */ }
  return value
}

/**
 * Who a verification task is sent "from". See the call sites for the why; kept
 * here so the dispatch path and the stale-verification sweep cannot drift apart.
 */
export function verificationSender(targetAgent: string): string {
  return isMainChannelsAgent(targetAgent) ? 'system' : MAIN_AGENT_ID
}

export async function tryHandleApprovals(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx

  // POST /api/approvals -- create new approval request
  if (path === '/api/approvals' && method === 'POST') {
    let body: { agent_id?: unknown; category?: unknown; action_description?: unknown; action_payload?: unknown; noKanbanCard?: unknown; similar_reviewed?: unknown }
    try {
      body = JSON.parse((await readBody(req)).toString())
    } catch {
      json(res, { error: 'Invalid JSON' }, 400)
      return true
    }

    const { agent_id, category, action_description, action_payload, noKanbanCard } = body
    const similarReviewedRaw = body.similar_reviewed
    if (typeof agent_id !== 'string' || !agent_id.trim()) {
      json(res, { error: 'agent_id is required' }, 400)
      return true
    }
    // An agent that files a request under its PERSONA ("Marvin") instead of its
    // id ("lackor2-bot") splits its own history in two: the approvals list then
    // offers both as separate agents, and the verification dispatch -- which
    // addresses a real agent id -- cannot reach "Marvin" at all. Canonicalise on
    // the way in, so the id is the id no matter what the caller typed.
    const requesterId = canonicalAgentId(agent_id.trim())
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

    // A card is not finished when its code is finished -- it is finished when the
    // BOARD says so, and that includes the cards next to it. Boss, 2026-08-11:
    // five cards were handed out as work, three of them were long done and
    // simply never moved or submitted. His instruction after that was blunt:
    // "kenyszeritsd ki hogy vegye eszre" -- a rule written in a skill had been
    // in place since 2026-08-05 and was still skipped, so this is the same
    // enforcement the create path already applies, moved to the moment a card
    // is declared done.
    //
    // The caller answers with `similar_reviewed`: the ids it looked at, or an
    // empty array meaning "checked, nothing else is covered by this work".
    const requestCardId = noKanbanCard === true ? null : approvalCardId(action_payload, action_description)

    if (noKanbanCard !== true) {
      // One listKanbanCards() call, not one per lookup: it also runs the
      // done-card auto-archive UPDATE, so each call is a write.
      const board = listKanbanCards().map(c => ({ id: c.id, seq: c.seq ?? null, title: c.title, status: c.status }))
      const similar = similarCardsBeforeClose(requestCardId, board, similarReviewedRaw)
      if (similar.length > 0) {
        json(res, {
          error: 'Mielőtt lezárod: nézd át a hasonló, MÉG NYITOTT kártyákat -- lehet hogy ezt a munkát már lefedi valamelyik, '
            + 'vagy részben lefedi. Mindegyikkel csinálj valamit: add fel jóváhagyásra, vagy fűzd hozzá kommentben mi készült el belőle. '
            + 'Aztán küldd újra a "similar_reviewed" mezővel: similar_reviewed: ["<id>", ...] az átnézettekkel, vagy [] ha egyik sem kapcsolódik.',
          similar,
        }, 400)
        return true
      }
    }

    // Moving a card to waiting now raises an approval by itself, so by the time
    // the responsible agent files its own -- with the description that actually
    // says what was built and how it was tested -- one is usually already open.
    // Update that row instead of adding a second: Boss decides about a piece of
    // work once, not twice, and two rows for one card is exactly the confusion
    // this whole mechanism exists to remove.
    if (requestCardId) {
      const existing = pendingApprovalForCard(requestCardId)
      if (existing) {
        updateApprovalDescription(
          existing.id,
          action_description.trim(),
          typeof action_payload === 'string' ? action_payload : null,
        )
        const refreshed = getApproval(existing.id) ?? existing
        logger.info({ id: existing.id, agent_id, cardId: requestCardId }, 'Existing pending approval updated instead of duplicated')
        json(res, refreshed, 200)
        return true
      }
    }

    const id = randomUUID()
    const timeout_at = getTimeoutAt(category)
    const approval = createApproval({
      id,
      agent_id: requesterId,
      category: category.trim(),
      action_description: action_description.trim(),
      action_payload: typeof action_payload === 'string' ? action_payload : null,
      timeout_at,
    })

    const grant = autonomyGrantsCategory(requesterId, category.trim())
    if (grant.granted) {
      resolveApproval(
        id, 'approved', 'autonomy', null,
        `Az önállósági beállítás szerint a(z) "${category.trim()}" kategória ennél az ágensnél `
        + `${grant.level}. szinten van, tehát nem kell hozzá tulajdonosi jóváhagyás. `
        + 'Ez a dashboard Beállítások / Autonómia lapján megváltoztatható.',
      )
      const resolved = getApproval(id) ?? approval
      logger.info({ id, agent_id, category, level: grant.level }, 'Approval auto-approved by autonomy level')
      json(res, resolved, 201)
      return true
    }

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
    // Kártya 62c63a5e (#108): a verify-result ág már régóta rámásolja a
    // reviewer-agent leletét a kapcsolódó kártyára, de maga a záró döntés
    // (ez az endpoint) eddig semmit nem írt oda -- a resolutionReason csak
    // az approval sorban maradt, a kártyán soha nem látszott miért lett
    // approved/rejected. Ugyanazt a best-effort mintát követi mint lent a
    // verify-result ág: soha nem blokkolja a választ, hiányzó/hibás
    // kártya-kapcsolat csendben kimarad.
    if (approval) {
      const linkedCardId = kanbanCardIdFromApproval(approval)
      if (linkedCardId) {
        try {
          const icon = status === 'approved' ? '✅' : status === 'rejected' ? '❌' : '⏱️'
          addKanbanComment(linkedCardId, resolved_by.trim(), `${icon} Jóváhagyás lezárva (${status}): ${resolutionReason || '(nincs indoklás)'}`)
        } catch (err) {
          logger.warn({ err, approvalId: idMatch[1], linkedCardId }, 'Failed to post approval resolution as a kanban comment')
        }
      }
    }
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
      // The main agent (Marvin) is pickable too (Boss 2026-08-24), but its
      // lifecycle is NOT the sub-agent one: it has no agents/<name> dir and no
      // `agent-<name>` tmux session, so agentDir() would resolve to the project
      // root (existsSync always true) and startAgentProcess() would spawn a rogue
      // duplicate session. See isMainChannelsAgent() in main-agent.ts. Its session
      // is service-managed (systemd/launchd), so this path only CHECKS it and, if
      // it is down, says so with the next step instead of starting anything.
      if (isMainChannelsAgent(agent)) {
        if (!sessionExistsOnHost(null, MAIN_CHANNELS_SESSION)) {
          failed.push({ agent, error: `Main agent session (${MAIN_CHANNELS_SESSION}) is not running -- restart it on the Agents page (its own card), then start the verification again` })
          continue
        }
      } else {
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
      }
      createOrResetApprovalVerification(approvalId, agent)
      const prompt = [
        `Ellenorzesi feladat (${currentOwnerName()} kerte, jovahagyas elott): nezd at ezt a fuggo jovahagyast alaposan.`,
        `Kategoria: ${approval.category}`,
        `Leiras: ${approval.action_description}`,
        ``,
        `EZ EGY CSAK-OLVASO ELLENORZES. Amit szabad: git log/git show/git diff a relevans commitra, a forrasfajlok`,
        `olvasasa es keresese, a tesztek futtatasa IZOLALT checkoutban, es olvaso (GET) API-hivas a dashboardon.`,
        `TILOS barmilyen allapotvaltoztato hivas az ELO rendszeren: nincs POST/PUT/PATCH/DELETE (az egyetlen kivetel a`,
        `lentebbi verify-result jelentes), nincs jelszo-, felhasznalo-, agens-, beallitas- vagy kartya-modositas, nincs`,
        `elo levelkuldes, nincs szolgaltatas-ujrainditas es nincs semmi, ami fajlt ir a repon kivul. Egy "csak kiprobalom"`,
        `hivas itt valodi kart okoz: 2026-08-24-en egy ilyen proba atallitotta a dashboard jelszavat es kileptette a Bosst.`,
        `Ha a valtoztatas UI-t erint, a fajlokban keresve igazold, hogy az elem tenyleg megvan -- ne kattintsd vegig elesben.`,
        `Ha az ellenorzeshez elkerulhetetlen lenne egy iro hivas, NE tedd meg: ird le a jelentesben, hogy mit nem tudtal`,
        `igy ellenorizni.`,
        ``,
        `Amikor kesz vagy, jelentsd vissza az eredmenyt EZZEL a hivassal (KOTELEZO, ne csak inter-agent uzenettel):`,
        `curl -s -X POST http://localhost:3420/api/approvals/${approvalId}/verify-result \\`,
        `  -H "Content-Type: application/json" \\`,
        `  -H "Authorization: Bearer $(cat ${join(PROJECT_ROOT, 'store', '.dashboard-token')})" \\`,
        `  -d '{"agent":"${agent}","status":"pass","report":"rovid osszefoglalo"}'`,
        ``,
        `status legyen "pass" ha minden rendben, vagy "fail" ha barmi problemat talalsz -- a report mezoben`,
        `RÖVIDEN indokold (max nehany mondat), fail eseten konkretan mit talaltal hibasnak.`,
      ].join('\n')
      try {
        // Sender: MAIN_AGENT_ID stands for "the dashboard/coordinator" for
        // sub-agents. For the main agent itself that would be a from === to
        // self-message, which classifyAgentMessage() rejects as trusted (see
        // team-trust.ts) AND which reads to the agent as a message from itself.
        // 'system' is the same sender the approval notifications already use.
        createAgentMessage(verificationSender(agent), agent, prompt)
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
