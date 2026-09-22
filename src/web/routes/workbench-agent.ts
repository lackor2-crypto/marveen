// AI Munkapad -- agent-vegpontok (kanban #336, 740b432a, 2. fazis).
//
//   GET  /api/workbench/agent/status?project=<id>   -- van-e szolgaltato, hol all a kozos keret
//   POST /api/workbench/agent/message               -- uzenet kuldese, STREAMELT valasz (SSE)
//   GET  /api/workbench/agent/session?workItem=<id> -- a beszelgetes eddigi uzenetei + tool-hivasai
//   GET  /api/workbench/agent/config                -- modell + VAN-E kulcs (a kulcs SOSE jon vissza)
//   POST /api/workbench/agent/config                -- modell / kulcs beallitasa a feluletrol
//
// A chat FELULETE a 3. fazise. Ez a vegpont mar most meghivhato a feluletrol
// (fetch + ReadableStream) es teszthelheto.
//
// Minden hiba `{ error: <kod>, message: <emberi mondat> }` alaku, a keres
// nyelven. A streamben ugyanez `event: notice` / `event: error` sorkent jon.
import { json, readBody } from '../http-helpers.js'
import { getEffectiveSettingValue, setOverride } from '../../settings-store.js'
import { APP_LANG } from '../../config.js'
import { getProject } from '../../projects.js'
import { getWorkItem } from '../../workbench.js'
import { ensureWorkbenchAgent } from '../../workbench-agent/index.js'
import { msg, type Lang } from '../../workbench-agent/messages.js'
import { pickAIProvider } from '../../workbench-agent/provider.js'
import { getRemaining } from '../../workbench-agent/usage-manager.js'
import { runTurn, validateTurn, MESSAGE_MAX_CHARS } from '../../workbench-agent/orchestrator.js'
import {
  ensureAgentTables, listAgentMessages, listToolCalls, openSessionForWorkItem, projectSessionKey,
} from '../../workbench-agent/sessions.js'
import { TOOLS } from '../../workbench-agent/tools.js'
import type { RouteContext } from './types.js'

function uiLang(url: URL): Lang {
  const v = url.searchParams.get('lang')
  return v === 'en' || v === 'hu' ? v : (APP_LANG === 'en' ? 'en' : 'hu')
}

const LOCAL_MESSAGES: Record<string, { hu: string; en: string }> = {
  project_required: {
    hu: 'Nincs megadva, melyik projekt Munkapadját nyitod meg.',
    en: 'It is not given which project\'s Workbench you are opening.',
  },
  project_not_found: {
    hu: 'Ez a projekt nem található (lehet, hogy közben törölték).',
    en: 'This project was not found (it may have been deleted).',
  },
  work_item_required: {
    hu: 'Nincs megadva, melyik munkadarabról van szó.',
    en: 'It is not given which work item this is about.',
  },
  no_known_settings: {
    hu: 'A kérés egyetlen ismert Munkapad-beállítást sem tartalmazott.',
    en: 'The request contained no known Workbench setting.',
  },
}

function fail(res: RouteContext['res'], status: number, code: string, lang: Lang, message?: string): true {
  const local = LOCAL_MESSAGES[code]
  json(res, { error: code, message: message ?? (local ? local[lang] : code) }, status)
  return true
}

async function readJson(req: RouteContext['req']): Promise<Record<string, unknown> | null> {
  try {
    const raw = (await readBody(req)).toString('utf-8').trim()
    if (!raw) return {}
    const v = JSON.parse(raw)
    return v && typeof v === 'object' ? v as Record<string, unknown> : null
  } catch {
    return null
  }
}

/** Ki kuldi. A bejelentkezett munkamenet neve; semmi beegetve. */
function actor(ctx: RouteContext): string {
  const a = ctx.auth
  if (!a) return 'dashboard'
  if (a.kind === 'session' && a.user) return a.user
  if (a.kind === 'federation' && a.peer) return a.peer
  if (a.kind === 'device' && a.device) return a.device
  return a.kind
}

export async function tryHandleWorkbenchAgent(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx
  if (!path.startsWith('/api/workbench/agent')) return false
  const lang = uiLang(url)
  ensureWorkbenchAgent()
  ensureAgentTables()

  // --- allapot: van-e szolgaltato, hol all a kozos keret --------------------
  if (path === '/api/workbench/agent/status' && method === 'GET') {
    const provider = pickAIProvider()
    const remaining = getRemaining()
    const u = remaining.usage
    json(res, {
      provider: provider
        ? { id: provider.id, model: provider.model(), available: true }
        // A ket eset KULONBOZIK: nincs beallitva vs nem latunk oda.
        : { id: null, model: null, available: false, message: msg('no_provider', lang) },
      usage: {
        // usedPct === null = NINCS meres. Nem 0%.
        usedPct: u.usedPct,
        measured: u.usedPct !== null,
        measuredAt: u.measuredAt,
        stale: u.stale,
        resetsAt: u.resetsAt,
        tier: u.tier,
        inFlight: u.inFlight,
        message: u.usedPct === null ? msg('usage_unknown', lang) : null,
      },
      allowed: remaining.allowed,
      blockedReason: remaining.reason,
      tools: TOOLS.map((t) => ({
        name: t.name, destructive: t.destructive, reversible: t.reversible,
        external_effect: t.external_effect, autonomyCategory: t.autonomyCategory,
      })),
      maxMessageChars: MESSAGE_MAX_CHARS,
    })
    return true
  }

  // --- modell + API-kulcs a feluletrol --------------------------------------
  //
  // MIERT KULON VEGPONT, es nem az altalanos /api/settings: a
  // `WORKBENCH_ANTHROPIC_API_KEY` titkos (`secret: true`), az altalanos
  // beallitas-vegpont pedig a titkos kulcsokat KI IS HAGYJA a listabol es
  // VISSZA IS UTASITJA irasra. Dedikalt, NEM-VISSZHANGZO ut nelkul a kulcsot
  // csak kezzel, fajlbol lehetne beallitani -- vagyis a "titkos" jelolestol
  // valna konfiguralhatatlanna. Ugyanaz a minta, mint a CODE_BOT_TOKEN-e:
  // a GET csak azt mondja meg, VAN-E kulcs, az erteket soha.
  if (path === '/api/workbench/agent/config' && method === 'GET') {
    json(res, {
      WORKBENCH_MODEL: String(getEffectiveSettingValue('WORKBENCH_MODEL') ?? ''),
      // Csak a TENY, sosem az ertek -- se nyersen, se maszkolva.
      keyConfigured: String(getEffectiveSettingValue('WORKBENCH_ANTHROPIC_API_KEY') ?? '').trim().length > 0,
    })
    return true
  }

  if (path === '/api/workbench/agent/config' && method === 'POST') {
    const body = await readJson(req)
    if (!body) return fail(res, 400, 'bad_json', lang, msg('bad_json', lang))
    const ALLOWED = ['WORKBENCH_MODEL', 'WORKBENCH_ANTHROPIC_API_KEY']
    const saved: string[] = []
    for (const key of ALLOWED) {
      if (!(key in body)) continue
      const raw = body[key]
      // Az erintetlen titkos mezo URESEN posztol vissza (a felulet sosem kapja
      // meg a meglevo kulcsot, tehat nem is tudja visszakuldeni). Ez NEM
      // torlesi szandek -- a torles kimondott: `null`.
      if (key === 'WORKBENCH_ANTHROPIC_API_KEY' && raw === '') continue
      const out = setOverride(key, raw === null ? '' : raw)
      if (!out.ok) return fail(res, 400, 'config_invalid', lang, out.error)
      saved.push(key)
    }
    if (saved.length === 0) return fail(res, 400, 'no_known_settings', lang)
    // A mentett KULCSOT sosem logoljuk -- csak azt, hogy melyik mezo valtozott.
    json(res, { saved })
    return true
  }

  // --- egy beszelgetes eddigi tartalma --------------------------------------
  //
  // KET beszelgetes-fajta van, es mindkettot vissza kell tudni olvasni:
  //   ?workItem=<id>  -- egy munkadarabhoz tartozo beszelgetes
  //   ?project=<id>   -- a munkadarab NELKULI, projekt-szintu beszelgetes
  // A masodik nelkul az oldal ujratoltese utan a mar lefolytatott beszelgetes
  // URESNEK latszana, holott ott all az adatbazisban -- vagyis a felulet a
  // "meg nincs semmi"-t es a "nem latok oda"-t osszemosna.
  if (path === '/api/workbench/agent/session' && method === 'GET') {
    const workItemId = (url.searchParams.get('workItem') || '').trim()
    const projectId = (url.searchParams.get('project') || '').trim()
    if (!workItemId && projectId) {
      const project = getProject(projectId)
      if (!project) return fail(res, 404, 'project_not_found', lang)
      const session = openSessionForWorkItem(project.id, projectSessionKey(project.id), lang)
      json(res, {
        session,
        messages: listAgentMessages(session.id),
        toolCalls: listToolCalls(session.id),
      })
      return true
    }
    if (!workItemId) return fail(res, 400, 'work_item_required', lang)
    const item = getWorkItem(workItemId)
    if (!item) return fail(res, 404, 'work_item_not_found', lang, msg('work_item_not_found', lang))
    const session = openSessionForWorkItem(item.project_id, item.id, lang)
    json(res, {
      session,
      messages: listAgentMessages(session.id),
      toolCalls: listToolCalls(session.id),
    })
    return true
  }

  // --- uzenet + streamelt valasz -------------------------------------------
  if (path === '/api/workbench/agent/message' && method === 'POST') {
    const body = await readJson(req)
    if (!body) return fail(res, 400, 'bad_json', lang, msg('bad_json', lang))
    const projectId = String(body.project_id ?? '').trim()
    if (!projectId) return fail(res, 400, 'project_required', lang)
    const project = getProject(projectId)
    if (!project) return fail(res, 404, 'project_not_found', lang)
    const workItemId = body.work_item_id === undefined || body.work_item_id === null
      ? null
      : String(body.work_item_id).trim() || null

    const input = {
      projectId: project.id,
      workItemId,
      message: String(body.message ?? ''),
      lang,
      actor: actor(ctx),
    }
    // A streamelés MEGKEZDESE ELOTT rendes HTTP-hiba, hogy a felulet a
    // megszokott modon tudja kiirni.
    const v = validateTurn(input)
    if (!v.ok) return fail(res, v.code === 'work_item_not_found' || v.code === 'project_not_found' ? 404 : 400, v.code, lang, v.message)

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })

    const ac = new AbortController()
    let closed = false
    const stop = (): void => { if (!closed) { closed = true; ac.abort() } }
    req.on('close', stop)
    req.on('error', stop)

    const send = (event: string, data: unknown): void => {
      if (closed) return
      try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`) } catch { stop() }
    }

    try {
      for await (const ev of runTurn({ ...input, signal: ac.signal })) {
        send(ev.type, ev)
        if (closed) break
      }
    } catch (e) {
      // SOSE talalgatjuk az okot: a tenyleges hiba megy ki.
      send('error', { type: 'error', code: 'internal', message: msg('provider_failed', lang, { detail: e instanceof Error ? e.message : String(e) }) })
    }
    if (!closed) { try { res.end() } catch { /* mar lezarult */ } }
    return true
  }

  return false
}
