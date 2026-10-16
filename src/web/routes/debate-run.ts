// Starting and driving a debate from the dashboard (the Workbench "Vitaztatas" button).
// The read side (list / detail / delete) stays in routes/debate.ts; this file is the write side:
//
//   GET  /api/debate/models                    the models to pick from (DEBATE_MODELS + the OpenRouter catalog)
//   POST /api/debate/attachment                {rel} | {item} | {name, data_base64} -> the file's text
//   POST /api/debate/run                       one round (the first, or the next of {session}); {mode} picks the debate mode
//   POST /api/debate/estimate                  the expected cost of the next round (and of closing), before it is run
//   GET  /api/debate/sessions/:id/state        what the Workbench panel needs to resume a debate
//   POST /api/debate/sessions/:id/conclude     close it (a model writes the summary unless the owner gives one; {judge} picks a third model)
//   POST /api/debate/sessions/:id/apply-preview {item}  the old / new text of every change the review agreed on, against a document
//   POST /api/debate/sessions/:id/apply        {item, ids}  writes the ticked changes into the document as ONE new step (Undo gives it back)

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'
import { json, readBody } from '../http-helpers.js'
import { logger } from '../../logger.js'
import type { RouteContext } from './types.js'
import { getSecret } from '../vault.js'
import { getEffectiveSettingValue } from '../../settings-store.js'
import { getProject } from '../../projects.js'
import { resolveLifePath } from '../../life-explorer.js'
import { sniffType, extractTextContent, T } from '../../life-inbox-analyze.js'
import { getWorkItem } from '../../workbench.js'
import { hasDocModel, documentOutline } from '../../workbench-docmodel.js'
import { scheduleOutlineMirror } from '../../workbench-docmirror.js'
import { docHistoryState } from '../../workbench-dochistory.js'
import {
  runDebateRound, concludeDebate, loadDebateSession, estimateNextRound,
  DebateKeyMissingError, DebateBusyError, DebateInputError,
  MAX_ATTACHMENT_CHARS,
} from '../../debate-run.js'
import { BUILTIN_MODES, DEFAULT_MODE_ID, DEFAULT_STRENGTH, STRENGTHS, modelCountOf } from '../../debate-modes.js'
import { loadCustomModes } from '../../debate-mode-store.js'
import { applicableChanges, previewForItem, applyChanges } from '../../debate-apply.js'
import { openRouterModelsWithin } from '../openrouter-models.js'
import type { ModelPrice } from '../../debate-estimate.js'
import { toPickerId } from '../../debate-claude-cli.js'

function lang(url: URL): string {
  const v = url.searchParams.get('lang')
  return v === 'en' ? 'en' : 'hu'
}

function fail(res: RouteContext['res'], status: number, error: string, message: string): true {
  json(res, { error, message }, status)
  return true
}

/** The stored text of a document work item: chapter titles and paragraphs, in order. */
function itemText(itemId: string): { name: string; text: string } | null {
  const item = getWorkItem(itemId)
  if (!item || item.deleted_at || !hasDocModel(itemId)) return null
  const lines: string[] = []
  for (const s of documentOutline(itemId).sections) {
    if (s.title && !s.untitled) lines.push(`## ${s.title}`)
    for (const b of s.blocks) if (b.text) lines.push(b.text)
  }
  return { name: item.title, text: lines.join('\n\n') }
}

/** A file's text through the same reader the inbox uses; null for pictures and scans without a text layer. */
function fileText(abs: string): string | null {
  const content = extractTextContent(sniffType(abs), abs)
  return content.text.trim() ? content.text : null
}

function attachmentOut(name: string, text: string): { name: string; text: string; chars: number; truncated: boolean } {
  return { name, text: text.slice(0, MAX_ATTACHMENT_CHARS), chars: Math.min(text.length, MAX_ATTACHMENT_CHARS), truncated: text.length > MAX_ATTACHMENT_CHARS }
}

function errorFor(res: RouteContext['res'], l: string, err: unknown, status?: number): true {
  if (err instanceof DebateKeyMissingError) {
    return fail(res, 409, 'no_key', T(l,
      'Nincs OpenRouter-kulcs a Széfben, ezért a modelleket nem lehet elérni. Add meg a Széf oldalon („openrouter-fleet-key”).',
      'There is no OpenRouter key in the Vault, so the models cannot be reached. Add it on the Vault page ("openrouter-fleet-key").'))
  }
  if (err instanceof DebateBusyError) {
    return fail(res, 409, 'busy', T(l, 'Ennek a vitának egy köre még fut. Várd meg a végét.', 'A round of this debate is still running. Wait for it to finish.'))
  }
  if (err instanceof DebateInputError) {
    const code = err.code.startsWith('summary_failed') ? 'summary_failed' : err.code
    const detail = err.code.startsWith('summary_failed:') ? err.code.slice('summary_failed:'.length) : ''
    const msg: Record<string, [string, string]> = {
      session_not_found: ['Ez a vita nem található.', 'This debate was not found.'],
      session_concluded: ['Ez a vita már le van zárva.', 'This debate is already closed.'],
      mode_unknown: ['Ez a vitáztatási mód nem létezik.', 'This debate mode does not exist.'],
      round_limit: ['Ez a mód ennél több kört nem enged. Zárd le a vitát.', 'This mode allows no more rounds. Close the debate.'],
      not_concluded: ['Az Alkalmaz csak a lezárt vitán érhető el. Előbb zárd le a vitát.', 'Apply is only available on a closed debate. Close the debate first.'],
      item_missing: ['Válaszd ki a munkadarabot, amelyikbe a változtatásokat be kell írni.', 'Pick the work item the changes are to be written into.'],
      item_not_found: ['Ez a munkadarab nem található.', 'This work item was not found.'],
      item_not_document: ['Ennek a munkadarabnak nincs szerkeszthető szövege (nem dokumentum).', 'This work item has no editable text (it is not a document).'],
      item_other_project: ['Ez a munkadarab nem ugyanahhoz a projekthez tartozik, mint a vita.', 'This work item belongs to a different project than the debate.'],
      project_archived: ['A projekt archivált, ezért csak olvasható. Állítsd vissza a Projektek oldalon.', 'The project is archived, so it is read-only. Restore it on the Projects page.'],
      nothing_to_apply: ['Ebből a vitából nincs mit beírni: a védő nem fogadott el olyan kifogást, amelyhez idézet és új megfogalmazás tartozna.', 'There is nothing to write from this debate: the defender accepted no objection that has both a quote and a new wording.'],
      question_missing: ['Írd be a kérdést vagy a feladatot.', 'Type the question or the task.'],
      two_models_required: ['Válassz ki két különböző modellt.', 'Pick two different models.'],
      three_models_required: ['Ehhez a módhoz három különböző modell kell: két kötekedő és egy védő.', 'This mode needs three different models: two critics and a defender.'],
      summary_failed: [`Az összefoglalót nem sikerült megírni (${detail}). A vita nyitva maradt, próbáld újra.`, `The summary could not be written (${detail}). The debate stays open, try again.`],
    }
    const m = msg[code] ?? [err.code, err.code]
    return fail(res, status ?? (code === 'session_not_found' ? 404 : code === 'summary_failed' ? 502 : 400), code, T(l, m[0], m[1]))
  }
  logger.error({ err }, '[debate] request failed')
  return fail(res, 500, 'failed', T(l, 'A vitáztatás hibára futott.', 'The debate failed.'))
}

export async function tryHandleDebateRun(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx
  const l = lang(url)

  if (path === '/api/debate/models' && method === 'GET') {
    const raw = String(getEffectiveSettingValue('DEBATE_MODELS') ?? '')
    const defaults = raw.split(',').map(s => s.trim()).filter(Boolean).map(toPickerId)
    const hasKey = getSecret('openrouter-fleet-key') !== null
    const catalog: { id: string; name: string; free: boolean }[] = []
    const catalogError = false
    json(res, {
      defaults, catalog, has_key: hasKey, catalog_error: catalogError,
      modes: [...Object.values(BUILTIN_MODES), ...loadCustomModes()].map(m => ({
        id: m.id, builtin: m.builtin === true, roles: m.roles, name: m.builtin ? null : (m.name ?? m.id), description: m.builtin ? null : (m.description ?? ''),
        strength: m.strength ?? DEFAULT_STRENGTH, swap_roles: m.swapRoles === true, max_rounds: m.maxRounds ?? null, models: modelCountOf(m),
      })),
      default_mode: DEFAULT_MODE_ID, strengths: STRENGTHS,
    })
    return true
  }

  if (path === '/api/debate/attachment' && method === 'POST') {
    let body: { rel?: string; item?: string; name?: string; data_base64?: string }
    try { body = JSON.parse((await readBody(req)).toString()) } catch { return fail(res, 400, 'bad_json', T(l, 'Hibás kérés.', 'Bad request.')) }
    const noText = (): true => fail(res, 422, 'no_text', T(l,
      'Ebből a fájlból nem tudtam szöveget kiolvasni (kép vagy beszkennelt lap lehet). Másold be a szövegét a kérdés mezőbe.',
      'I could not read any text from this file (it may be a picture or a scan). Paste its text into the question field.'))
    if (body.item) {
      const it = itemText(String(body.item))
      if (!it || !it.text.trim()) return fail(res, 404, 'no_item_text', T(l, 'Ennek a munkadarabnak nincs olvasható szövege.', 'This work item has no readable text.'))
      json(res, attachmentOut(it.name, it.text))
      return true
    }
    if (body.rel) {
      const abs = resolveLifePath(String(body.rel))
      if (!abs) return fail(res, 404, 'outside', T(l, 'Ez a hely nincs a Marveen mappáján belül.', 'This location is outside the Marveen folder.'))
      let text: string | null = null
      try { text = fileText(abs) } catch { text = null }
      if (!text) return noText()
      json(res, attachmentOut(basename(abs), text))
      return true
    }
    const name = basename(String(body.name ?? '')).slice(0, 200)
    if (!name || typeof body.data_base64 !== 'string' || !body.data_base64) return fail(res, 400, 'bad_input', T(l, 'Hiányzik a fájl.', 'The file is missing.'))
    // The reader works on a path: the upload goes to a throwaway folder that is removed straight away.
    const dir = mkdtempSync(join(tmpdir(), 'marveen-debate-'))
    try {
      const tmp = join(dir, 'upload' + extname(name).toLowerCase().replace(/[^.a-z0-9]/g, ''))
      writeFileSync(tmp, Buffer.from(body.data_base64, 'base64'))
      const text = fileText(tmp)
      if (!text) return noText()
      json(res, attachmentOut(name, text))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
    return true
  }

  if (path === '/api/debate/run' && method === 'POST') {
    let body: { session?: string; project?: string; workItem?: string; question?: string; models?: string[]; attachments?: unknown; steer?: string; mode?: string; strength?: string; swapRoles?: boolean; judge?: string }
    try { body = JSON.parse((await readBody(req)).toString()) } catch { return fail(res, 400, 'bad_json', T(l, 'Hibás kérés.', 'Bad request.')) }
    const project = body.project ? getProject(String(body.project))?.id ?? null : null
    try {
      const workItem = project && body.workItem ? (getWorkItem(String(body.workItem))?.project_id === project ? String(body.workItem) : null) : null
      const out = await runDebateRound({ ...body, project, workItem })
      if (!out.responses.some(r => r.ok)) {
        // The reason per model (HTTP status / the maker's own message) is what the owner needs to see, and it is the
        // only trace of a round that fails in a second: nothing is filed for it (Boss TG 2939).
        const why = out.responses.map(r => `${r.model}: ${String(r.error || '?').replace(/\s+/g, ' ').slice(0, 160)}`).join(' | ').slice(0, 500)
        logger.warn({ reasons: why }, '[debate] every model of the round failed')
        json(res, { error: 'all_failed', message: T(l, `Egyik modell sem válaszolt, a kör nem lett mentve. Ok: ${why}`, `No model answered, the round was not saved. Reason: ${why}`), ...out }, 502)
        return true
      }
      json(res, out)
    } catch (err) {
      errorFor(res, l, err)
    }
    return true
  }

  const stateMatch = path.match(/^\/api\/debate\/sessions\/([^/]+)\/state$/)
  if (stateMatch && method === 'GET') {
    const st = loadDebateSession(decodeURIComponent(stateMatch[1]))
    if (!st) return fail(res, 404, 'session_not_found', T(l, 'Ez a vita nem található.', 'This debate was not found.'))
    json(res, { ...st, attachments: st.attachments.map(a => ({ name: a.name, chars: a.text.length })) })
    return true
  }

  if (path === '/api/debate/estimate' && method === 'POST') {
    let body: { session?: string; question?: string; models?: string[]; attachments?: unknown; steer?: string; mode?: string; strength?: string; swapRoles?: boolean; judge?: string }
    try { body = JSON.parse((await readBody(req)).toString()) } catch { return fail(res, 400, 'bad_json', T(l, 'Hibás kérés.', 'Bad request.')) }
    const prices = new Map<string, ModelPrice>()
    try {
      for (const m of (await openRouterModelsWithin(Date.now(), 3000)) ?? []) prices.set(m.id, { promptPrice: m.promptPrice, completionPrice: m.completionPrice })
    } catch (err) {
      logger.warn({ err: String((err as Error)?.message || err) }, '[debate] price catalog unavailable for the estimate')
    }
    try {
      json(res, { ...estimateNextRound(body, prices), prices_known: prices.size > 0 })
    } catch (err) {
      errorFor(res, l, err)
    }
    return true
  }

  const applyMatch = path.match(/^\/api\/debate\/sessions\/([^/]+)\/(apply|apply-preview)$/)
  if (applyMatch && method === 'POST') {
    let body: { item?: string; ids?: unknown }
    try { body = JSON.parse((await readBody(req)).toString() || '{}') } catch { return fail(res, 400, 'bad_json', T(l, 'Hibás kérés.', 'Bad request.')) }
    const st = loadDebateSession(decodeURIComponent(applyMatch[1]))
    if (!st) return fail(res, 404, 'session_not_found', T(l, 'Ez a vita nem található.', 'This debate was not found.'))
    const deny = (code: string, status: number): true => errorFor(res, l, new DebateInputError(code), status)
    // Nothing is ever written to a document before the debate is closed (Boss 2026-10-14): no preview either, the board may still change.
    if (!st.concluded) return deny('not_concluded', 409)
    if (!body.item) return deny('item_missing', 400)
    const item = getWorkItem(String(body.item))
    if (!item || item.deleted_at) return deny('item_not_found', 404)
    if (!hasDocModel(item.id)) return deny('item_not_document', 400)
    if (st.project && item.project_id !== st.project) return deny('item_other_project', 409)
    const project = getProject(item.project_id)
    if (project && project.archived_at != null) return deny('project_archived', 409)
    const changes = applicableChanges(st.board)
    if (!changes.length) return deny('nothing_to_apply', 409)

    if (applyMatch[2] === 'apply-preview') {
      json(res, { item: { id: item.id, title: item.title }, changes: previewForItem(item.id, changes) })
      return true
    }
    const ids = new Set(Array.isArray(body.ids) ? body.ids.map(x => String(x)) : [])
    const out = applyChanges(item.id, changes, ids)
    if (out.applied.length) scheduleOutlineMirror(item.id)
    json(res, { ...out, history: docHistoryState(item.id), changes: previewForItem(item.id, changes) })
    return true
  }

  const concludeMatch = path.match(/^\/api\/debate\/sessions\/([^/]+)\/conclude$/)
  if (concludeMatch && method === 'POST') {
    let body: { summary?: string; consensus?: boolean; judge?: string } = {}
    try { const raw = (await readBody(req)).toString(); if (raw.trim()) body = JSON.parse(raw) } catch { return fail(res, 400, 'bad_json', T(l, 'Hibás kérés.', 'Bad request.')) }
    try {
      json(res, await concludeDebate(decodeURIComponent(concludeMatch[1]), body))
    } catch (err) {
      errorFor(res, l, err)
    }
    return true
  }

  return false
}
