// Starting and driving a debate from the dashboard (the Workbench "Vitaztatas" button).
// The read side (list / detail / delete) stays in routes/debate.ts; this file is the write side:
//
//   GET  /api/debate/models                    the models to pick from (DEBATE_MODELS + the OpenRouter catalog)
//   POST /api/debate/attachment                {rel} | {item} | {name, data_base64} -> the file's text
//   POST /api/debate/run                       one round (the first, or the next of {session})
//   GET  /api/debate/sessions/:id/state        what the Workbench panel needs to resume a debate
//   POST /api/debate/sessions/:id/conclude     close it (a model writes the summary unless the owner gives one)

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'
import { json, readBody } from '../http-helpers.js'
import { logger } from '../../logger.js'
import type { RouteContext } from './types.js'
import { getSecret } from '../vault.js'
import { fetchAllOpenRouterModels } from '../openrouter-models.js'
import { getEffectiveSettingValue } from '../../settings-store.js'
import { getProject } from '../../projects.js'
import { resolveLifePath } from '../../life-explorer.js'
import { sniffType, extractTextContent, T } from '../../life-inbox-analyze.js'
import { getWorkItem } from '../../workbench.js'
import { hasDocModel, documentOutline } from '../../workbench-docmodel.js'
import {
  runDebateRound, concludeDebate, loadDebateSession,
  DebateKeyMissingError, DebateBusyError, DebateInputError,
  MAX_ATTACHMENT_CHARS,
} from '../../debate-run.js'

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

function errorFor(res: RouteContext['res'], l: string, err: unknown): true {
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
      question_missing: ['Írd be a kérdést vagy a feladatot.', 'Type the question or the task.'],
      two_models_required: ['Válassz ki két különböző modellt.', 'Pick two different models.'],
      summary_failed: [`Az összefoglalót nem sikerült megírni (${detail}). A vita nyitva maradt, próbáld újra.`, `The summary could not be written (${detail}). The debate stays open, try again.`],
    }
    const m = msg[code] ?? [err.code, err.code]
    return fail(res, code === 'session_not_found' ? 404 : code === 'summary_failed' ? 502 : 400, code, T(l, m[0], m[1]))
  }
  logger.error({ err }, '[debate] request failed')
  return fail(res, 500, 'failed', T(l, 'A vitáztatás hibára futott.', 'The debate failed.'))
}

export async function tryHandleDebateRun(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx
  const l = lang(url)

  if (path === '/api/debate/models' && method === 'GET') {
    const raw = String(getEffectiveSettingValue('DEBATE_MODELS') ?? '')
    const defaults = raw.split(',').map(s => s.trim()).filter(Boolean)
    const hasKey = getSecret('openrouter-fleet-key') !== null
    let catalog: { id: string; name: string; free: boolean }[] = []
    let catalogError = false
    if (hasKey) {
      try {
        catalog = (await fetchAllOpenRouterModels(Date.now())).map(m => ({ id: m.id, name: m.name, free: m.free }))
      } catch (err) {
        catalogError = true
        logger.warn({ err: String((err as Error)?.message || err) }, '[debate] model catalog fetch failed')
      }
    }
    json(res, { defaults, catalog, has_key: hasKey, catalog_error: catalogError })
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
    let body: { session?: string; project?: string; question?: string; models?: string[]; attachments?: unknown; steer?: string }
    try { body = JSON.parse((await readBody(req)).toString()) } catch { return fail(res, 400, 'bad_json', T(l, 'Hibás kérés.', 'Bad request.')) }
    const project = body.project ? getProject(String(body.project))?.id ?? null : null
    try {
      const out = await runDebateRound({ ...body, project })
      if (!out.responses.some(r => r.ok)) {
        json(res, { error: 'all_failed', message: T(l, 'Egyik modell sem válaszolt, a kör nem lett mentve. Próbáld újra.', 'No model answered, the round was not saved. Try again.'), ...out }, 502)
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

  const concludeMatch = path.match(/^\/api\/debate\/sessions\/([^/]+)\/conclude$/)
  if (concludeMatch && method === 'POST') {
    let body: { summary?: string; consensus?: boolean } = {}
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
