/**
 * AGENT ORCHESTRATOR (kanban #336, 2. fazis, spec 5).
 *
 * A spec 16 lepese, ebben a sorrendben, egy helyen:
 *
 *   1. user message fogadasa        -> `runTurn(input)`
 *   2. session betoltese            -> `openSessionForWorkItem`
 *   3. projektkontextus             -> `buildContext`
 *   4. work item kontextus          -> `buildContext`
 *   5. releváns fajlok              -> `buildContext` (meretkorlatos)
 *   6. agent inference              -> `provider.stream()` a KOZOS kereten at
 *   7. terv                         -> a modell valasza (prozai vagy tool-hivas)
 *   8. tool kivalasztasa            -> `getTool`
 *   9. approval ellenorzes          -> `decideTool` + a MEGLEVO /api/approvals
 *  10. tool vegrehajtas             -> `executeTool`
 *  11. eredmeny ellenorzese         -> a tool sajat `ok`/`code`/`detail`-je
 *  12. verzio                       -> KESOBBI FAZIS (a hook helye jelolve)
 *  13. preview                      -> KESOBBI FAZIS
 *  14. UI frissites                 -> a hivo (SSE) dolga
 *  15. agent valasz                 -> `text` esemenyek + mentes
 *  16. audit                        -> `auditWorkbench`
 *
 * MINDEN modell-hivas a kozos `UsageManager`-en megy at (spec 0.2). Ha nincs
 * szolgaltato vagy betelt a keret, az agens NEM nemul el: ember-nyelvu (HU/EN)
 * `notice` esemenyt ad, es a beszelgetesbe is bekerul.
 */
import { randomUUID } from 'node:crypto'
import { MAIN_AGENT_ID } from '../config.js'
import { logger } from '../logger.js'
import { getProject } from '../projects.js'
import { getWorkItem } from '../workbench.js'
import { createApproval, createAgentMessage, listApprovals } from '../db.js'
import { buildContext, historyMessages } from './context.js'
import { auditWorkbench } from './audit.js'
import { executeTool } from './execute.js'
import { msg, type Lang } from './messages.js'
import { pickAIProvider, type AIMessage, type AIProvider } from './provider.js'
import {
  addAgentMessage, finishToolCall, listAgentMessages, openSessionForWorkItem, startToolCall,
  type AgentSessionRow,
} from './sessions.js'
import { decideTool, getTool } from './tools.js'
import { getRemaining, record, reserve } from './usage-manager.js'

/** Hany tool-kor lehet egy forduloban. A tizedik kor mar nem terv, hanem kor. */
export const MAX_TOOL_ROUNDS = 4
/** Egy felhasznaloi uzenet felso hatara. */
export const MESSAGE_MAX_CHARS = 8000

export type OrchestratorEvent =
  | { type: 'session'; sessionId: string }
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string; status: 'running' | 'ok' | 'error' | 'needs_approval' | 'blocked'; detail?: string; approvalId?: string }
  /** Ember-nyelvu kozlendo, ami NEM a modelltol jon (keret, szolgaltato, korlat). */
  | { type: 'notice'; code: string; message: string }
  | { type: 'done'; model: string | null }
  | { type: 'error'; code: string; message: string }

export interface TurnInput {
  projectId: string
  workItemId: string | null
  message: string
  lang: Lang
  /** Ki kuldi -- az auditba es az approval `agent_id`-jebe ez kerul. */
  actor: string
  signal?: AbortSignal
}

export type TurnFailure =
  | { ok: false; code: 'project_not_found' | 'work_item_not_found' | 'message_required' | 'message_too_long'; message: string }

/** Egy felhasznaloi uzenet elozetes ellenorzese. Kulon, hogy a vegpont a
 *  streamelés MEGKEZDESE ELOTT tudjon rendes HTTP-hibat adni. */
export function validateTurn(input: TurnInput): TurnFailure | { ok: true } {
  const text = String(input.message ?? '').trim()
  if (!text) return { ok: false, code: 'message_required', message: msg('message_required', input.lang) }
  if (text.length > MESSAGE_MAX_CHARS) {
    return { ok: false, code: 'message_too_long', message: msg('message_too_long', input.lang, { max: MESSAGE_MAX_CHARS }) }
  }
  if (!getProject(input.projectId)) {
    return { ok: false, code: 'project_not_found', message: msg('work_item_not_found', input.lang) }
  }
  if (input.workItemId) {
    const item = getWorkItem(input.workItemId)
    if (!item || item.project_id !== getProject(input.projectId)?.id) {
      return { ok: false, code: 'work_item_not_found', message: msg('work_item_not_found', input.lang) }
    }
  }
  return { ok: true }
}

/** Egy munkadarabhoz egyszerre egy fordulo fut. */
const running = new Set<string>()
export function isTurnRunning(key: string): boolean { return running.has(key) }

/** A modell valasza tool-hivas-e. CSAK akkor, ha a TELJES valasz egy JSON
 *  objektum `tool` mezovel -- egy prozai valaszban emlitett JSON nem az. */
export function parseToolCall(text: string): { tool: string; input: Record<string, unknown> } | null {
  const s = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
  if (!s.startsWith('{') || !s.endsWith('}')) return null
  let j: unknown
  try { j = JSON.parse(s) } catch { return null }
  if (!j || typeof j !== 'object') return null
  const o = j as Record<string, unknown>
  if (typeof o.tool !== 'string' || !o.tool.trim()) return null
  const input = o.input && typeof o.input === 'object' ? o.input as Record<string, unknown> : {}
  return { tool: o.tool.trim(), input }
}

/** Lehet-e meg tool-hivas ebbol a szovegbol (streaming kozben). Amig igen,
 *  nem kuldjuk ki a darabokat -- kulonben a felhasznalo nyers JSON-t latna. */
export function mayBeToolCall(soFar: string): boolean {
  const s = soFar.trimStart().replace(/^```(?:json)?\s*/i, '').trimStart()
  return s === '' || s.startsWith('{') || '{'.startsWith(s.slice(0, 1))
}

function usageNotice(lang: Lang): { code: string; message: string } | null {
  const r = getRemaining()
  if (r.allowed) return null
  if (r.reason === 'too_many_in_flight') {
    return { code: 'too_many_in_flight', message: msg('too_many_in_flight', lang, { n: r.usage.inFlight }) }
  }
  const pct = r.usage.usedPct === null ? '?' : Math.round(r.usage.usedPct)
  const reset = r.usage.resetsAt
    ? msg('limit_reset_known', lang, { when: new Date(r.usage.resetsAt).toLocaleString(lang === 'en' ? 'en-GB' : 'hu-HU') })
    : msg('limit_reset_unknown', lang)
  return { code: 'limit_critical', message: msg('limit_critical', lang, { pct, reset }) }
}

/**
 * A MEGLEVO jovahagyas-rendszer jegye egy toolhoz.
 *
 * Nem uj mechanizmus: ugyanaz a `createApproval` + `[APPROVAL_REQUEST]`
 * ertesites, amit a `routes/approvals.ts` hasznal, ugyanabba a listaba.
 */
export function requestToolApproval(params: {
  tool: string
  category: string
  actor: string
  projectId: string
  workItemId: string | null
  input: Record<string, unknown>
}): string {
  const id = randomUUID()
  const description = `Munkapad: ${params.tool} (projekt ${params.projectId}${params.workItemId ? `, munkadarab ${params.workItemId}` : ''})`
  createApproval({
    id,
    agent_id: params.actor || MAIN_AGENT_ID,
    category: params.category,
    action_description: description,
    action_payload: JSON.stringify({ source: 'workbench', tool: params.tool, project: params.projectId, workItem: params.workItemId, input: params.input }),
  })
  try {
    createAgentMessage('system', MAIN_AGENT_ID, [
      '[APPROVAL_REQUEST]', `id=${id}`, `agent=${params.actor}`,
      `category=${params.category}`, `action=${description}`, 'timeout_at=null',
    ].join(' '))
  } catch (err) {
    logger.warn({ err, approvalId: id }, 'workbench-agent: approval notification failed')
  }
  return id
}

/** Van-e MAR jovahagyott jegy ehhez a toolhoz -- igy a tulajdonos "igen"-je
 *  utan a kovetkezo keres tenylegesen lefut, ujabb kerdes nelkul. */
export function approvedApprovalFor(tool: string, projectId: string): string | null {
  let rows: { id: string; action_payload: string | null }[]
  try {
    rows = listApprovals({ status: 'approved', limit: 50 }) as { id: string; action_payload: string | null }[]
  } catch {
    // Nincs meg approvals tabla (friss telepites): nincs jog, de ez nem hiba.
    return null
  }
  for (const a of rows) {
    try {
      const p = JSON.parse(a.action_payload || '{}')
      if (p.source === 'workbench' && p.tool === tool && p.project === projectId) return a.id
    } catch { /* egy serult payload nem ad jogot */ }
  }
  return null
}

/**
 * EGY beszelgetes-fordulo. Esemenyeket ad vissza, ahogy keletkeznek.
 *
 * A hivo (SSE-vegpont) csak tovabbitja oket; minden mentes (uzenet,
 * tool-hivas, audit) itt tortenik, tehat egy megszakadt kliens-kapcsolat nem
 * veszejti el a mar megtortent munkat.
 */
export async function* runTurn(input: TurnInput, providerOverride?: AIProvider): AsyncGenerator<OrchestratorEvent> {
  const lang = input.lang
  const project = getProject(input.projectId)
  if (!project) {
    yield { type: 'error', code: 'project_not_found', message: msg('work_item_not_found', lang) }
    return
  }
  const workItem = input.workItemId ? getWorkItem(input.workItemId) ?? null : null
  if (input.workItemId && (!workItem || workItem.project_id !== project.id)) {
    yield { type: 'error', code: 'work_item_not_found', message: msg('work_item_not_found', lang) }
    return
  }

  const key = workItem ? `item:${workItem.id}` : `project:${project.id}`
  if (running.has(key)) {
    yield { type: 'error', code: 'busy', message: msg('busy', lang) }
    return
  }
  running.add(key)

  let session: AgentSessionRow | null = null
  try {
    session = workItem
      ? openSessionForWorkItem(project.id, workItem.id, lang)
      : openSessionForWorkItem(project.id, `project:${project.id}`, lang)
    yield { type: 'session', sessionId: session.id }

    addAgentMessage(session.id, 'user', input.message.trim())
    auditWorkbench({ agent: input.actor, tool: 'workbench.chat', op: 'user-message', target: workItem?.id || project.id, cwd: project.id })

    const provider = providerOverride ?? pickAIProvider()
    if (!provider) {
      const m = msg('no_provider', lang)
      addAgentMessage(session.id, 'system', m)
      yield { type: 'notice', code: 'no_provider', message: m }
      yield { type: 'done', model: null }
      return
    }
    const avail = provider.availability()
    if (!avail.available) {
      const m = msg('no_provider', lang)
      addAgentMessage(session.id, 'system', m)
      yield { type: 'notice', code: 'no_provider', message: m }
      yield { type: 'done', model: null }
      return
    }

    const ctx = buildContext(project, workItem, lang)
    const history = historyMessages(listAgentMessages(session.id))
    // A kontextus-blokk az ELSO user-uzenet ele kerul, hogy a modell a
    // tenyeket a keressel egyutt lassa.
    const messages: AIMessage[] = history.length
      ? [{ role: 'user', content: `${ctx.contextText}\n\n${history[0].content}` }, ...history.slice(1)]
      : [{ role: 'user', content: `${ctx.contextText}\n\n${input.message.trim()}` }]

    let lastModel: string | null = null

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      // --- a kozos keret kapuja (spec 0.2) --------------------------------
      const blocked = usageNotice(lang)
      if (blocked) {
        addAgentMessage(session.id, 'system', blocked.message)
        yield { type: 'notice', code: blocked.code, message: blocked.message }
        yield { type: 'done', model: lastModel }
        return
      }
      const res = reserve()
      if (!res.ok) {
        const m = res.reason === 'too_many_in_flight'
          ? msg('too_many_in_flight', lang, { n: res.usage.inFlight })
          : msg('limit_critical', lang, { pct: res.usage.usedPct === null ? '?' : Math.round(res.usage.usedPct), reset: msg('limit_reset_unknown', lang) })
        addAgentMessage(session.id, 'system', m)
        yield { type: 'notice', code: res.reason, message: m }
        yield { type: 'done', model: lastModel }
        return
      }

      const startedAt = Date.now()
      let full = ''
      let emitted = 0
      let failure: { code: string; message: string } | null = null
      let outcome: 'ok' | 'error' | 'limit' = 'ok'

      try {
        for await (const chunk of provider.stream({ system: ctx.system, messages, lang, signal: input.signal })) {
          if (chunk.kind === 'text') {
            full += chunk.text
            // Amig tool-hivas is lehet belole, nem kuldunk ki semmit.
            if (!mayBeToolCall(full)) {
              const pending = full.slice(emitted)
              if (pending) { emitted = full.length; yield { type: 'text', text: pending } }
            }
          } else if (chunk.kind === 'done') {
            lastModel = chunk.model
          } else {
            outcome = chunk.code === 'limit' ? 'limit' : 'error'
            failure = chunk.code === 'limit'
              ? { code: 'limit_critical', message: msg('limit_critical', lang, { pct: '100', reset: msg('limit_reset_unknown', lang) }) }
              : chunk.code === 'not_configured'
                ? { code: 'no_provider', message: msg('no_provider', lang) }
                : chunk.code === 'no_answer'
                  ? { code: 'provider_no_answer', message: msg('provider_no_answer', lang) }
                  : { code: 'provider_failed', message: msg('provider_failed', lang, { detail: chunk.detail }) }
          }
        }
      } catch (e) {
        outcome = 'error'
        failure = { code: 'provider_failed', message: msg('provider_failed', lang, { detail: e instanceof Error ? e.message : String(e) }) }
      } finally {
        record(res.reservation.id, {
          agent: input.actor, model: provider.model(), outcome, durationMs: Date.now() - startedAt,
        })
      }

      if (failure) {
        addAgentMessage(session.id, 'system', failure.message)
        yield { type: 'notice', code: failure.code, message: failure.message }
        yield { type: 'done', model: lastModel }
        return
      }

      const call = parseToolCall(full)
      if (!call) {
        // Prozai valasz: ami meg nem ment ki (mert tool-hivasnak nezett), most megy.
        const pending = full.slice(emitted)
        if (pending) yield { type: 'text', text: pending }
        addAgentMessage(session.id, 'assistant', full)
        auditWorkbench({ agent: input.actor, tool: 'workbench.chat', op: 'agent-answer', target: workItem?.id || project.id, cwd: project.id })
        yield { type: 'done', model: lastModel }
        return
      }

      // --- 8-11: tool kivalasztas, approval, vegrehajtas -------------------
      const tool = getTool(call.tool)
      if (!tool) {
        const m = msg('tool_unknown', lang, { tool: call.tool })
        yield { type: 'tool', name: call.tool, status: 'error', detail: m }
        messages.push({ role: 'assistant', content: full })
        messages.push({ role: 'user', content: `TOOL RESULT (${call.tool}): error -- no such tool. Use only the listed tools, or answer in prose.` })
        continue
      }

      const row = startToolCall(session.id, tool.name, call.input)
      yield { type: 'tool', name: tool.name, status: 'running' }

      const decision = decideTool(tool, input.actor)
      if (decision.kind === 'blocked') {
        const m = msg('tool_blocked', lang, { tool: tool.name })
        finishToolCall(row.id, 'blocked', { reason: 'autonomy_level', level: decision.level })
        auditWorkbench({ agent: input.actor, tool: tool.name, op: 'blocked', target: workItem?.id || project.id, cwd: project.id })
        yield { type: 'tool', name: tool.name, status: 'blocked', detail: m }
        messages.push({ role: 'assistant', content: full })
        messages.push({ role: 'user', content: `TOOL RESULT (${tool.name}): blocked by the owner's autonomy settings. Tell the owner in plain words; do not retry.` })
        continue
      }
      if (decision.kind === 'approval') {
        const already = approvedApprovalFor(tool.name, project.id)
        if (!already) {
          const approvalId = requestToolApproval({
            tool: tool.name, category: decision.category, actor: input.actor,
            projectId: project.id, workItemId: workItem?.id ?? null, input: call.input,
          })
          const m = msg('tool_needs_approval', lang, { tool: tool.name })
          finishToolCall(row.id, 'needs_approval', { approvalId }, approvalId)
          auditWorkbench({ agent: input.actor, tool: tool.name, op: 'approval-request', target: workItem?.id || project.id, cwd: project.id })
          yield { type: 'tool', name: tool.name, status: 'needs_approval', detail: m, approvalId }
          messages.push({ role: 'assistant', content: full })
          messages.push({ role: 'user', content: `TOOL RESULT (${tool.name}): waiting for the owner's approval. Tell the owner in plain words that you filed an approval request; do not retry now.` })
          continue
        }
      }

      const result = executeTool(tool.name, call.input, { projectId: project.id, workItemId: workItem?.id ?? null, lang })
      if (result.ok) {
        finishToolCall(row.id, 'ok', result.data)
        auditWorkbench({ agent: input.actor, tool: tool.name, op: tool.destructive ? 'write' : 'read', target: workItem?.id || project.id, cwd: project.id })
        yield { type: 'tool', name: tool.name, status: 'ok' }
        // 12-13: verzio + preview -- KESOBBI FAZIS. A hely itt van; a 2.
        // fazis szandekosan nem keszit verziot egy tool-futasbol.
        messages.push({ role: 'assistant', content: full })
        messages.push({ role: 'user', content: `TOOL RESULT (${tool.name}): ${JSON.stringify(result.data).slice(0, 6000)}` })
      } else {
        const m = msg('tool_failed', lang, { tool: tool.name, detail: result.detail })
        finishToolCall(row.id, 'error', { code: result.code, detail: result.detail })
        auditWorkbench({ agent: input.actor, tool: tool.name, op: 'error', target: workItem?.id || project.id, cwd: project.id })
        yield { type: 'tool', name: tool.name, status: 'error', detail: m }
        messages.push({ role: 'assistant', content: full })
        messages.push({ role: 'user', content: `TOOL RESULT (${tool.name}): error ${result.code} -- ${result.detail}. Do not invent the answer; tell the owner what is missing.` })
      }
    }

    // Kifutottunk a korokbol: ez nem hallgatas, kimondjuk.
    const m = msg('provider_no_answer', lang)
    addAgentMessage(session.id, 'system', m)
    yield { type: 'notice', code: 'max_rounds', message: m }
    yield { type: 'done', model: lastModel }
  } finally {
    running.delete(key)
  }
}

/** Csak teszthez: a "fut mar" jelzo nullazasa. */
export function resetRunningForTest(): void { running.clear() }
