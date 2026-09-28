// AI Munkapad -- agent-vegpontok (kanban #336, 740b432a, 2. fazis).
//
//   GET  /api/workbench/agent/status?project=<id>   -- van-e szolgaltato, hol all a kozos keret
//   POST /api/workbench/agent/message               -- uzenet kuldese, STREAMELT valasz (SSE)
//   GET  /api/workbench/agent/session?workItem=<id> -- a beszelgetes eddigi uzenetei + tool-hivasai + fut-e valasz
//   POST /api/workbench/agent/stop                  -- a futo valasz leallitasa (a szerveren is)
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
import { settleWorkbenchApprovals } from '../../workbench-agent/approved-runner.js'
import { pickAIProvider } from '../../workbench-agent/provider.js'
import { getRemaining } from '../../workbench-agent/usage-manager.js'
import { workbenchAccountStatuses, isKnownWorkbenchAccount } from '../../workbench-agent/accounts.js'
import {
  runTurn, validateTurn, MESSAGE_MAX_CHARS, turnKey, isTurnRunning, claimTurn, releaseTurn,
} from '../../workbench-agent/orchestrator.js'
import { decideWorkbenchBackend } from '../../workbench-agent/backend-router.js'
import { runCodeBridgeTurn, buildCodeBridgePrompt } from '../../workbench-agent/code-bridge-turn.js'
import { codeBridgeHealth, enqueueCodeTask, getCodeTask, cancelCodeTask } from '../code-bridge-store.js'
import { projectFileTarget } from '../../project-files.js'
import {
  ensureAgentTables, listAgentMessages, listToolCalls, openSessionForWorkItem, projectSessionKey, addAgentMessage,
} from '../../workbench-agent/sessions.js'
import { TOOLS } from '../../workbench-agent/tools.js'
import type { RouteContext } from './types.js'

/** Egy agens-fordulo leghosszabb ideje (tobb tool-korrel egyutt). */
const TURN_MAX_MS = 15 * 60 * 1000
/** A kod-hidas (teljes erteku) fordulo ennyit var a chatben; utana a hatterben
 *  figyeli tovabb, es a kesve erkezo valasz is a beszelgetesbe kerul. */
const CODE_BRIDGE_CHAT_WAIT_MS = TURN_MAX_MS - 30_000

/**
 * A futo fordulok leallito-kapcsoloja, zar-kulcs szerint. A Leallitas gomb
 * ezen at allitja le a SZERVEREN is a valaszt -- eddig csak a bongeszo
 * olvasasa allt le, a szerveren a fordulo tovabb futott, es amig vegzett,
 * minden uj uzenet "mar fut egy valasz" hibat kapott.
 */
const turnControllers = new Map<string, AbortController>()

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
    // A keret annak a fioknak a kerete, amelyikkel a kovetkezo valasz
    // MENNE (#402) -- nem mindig a fo agense.
    let account: string | null = null
    try { account = provider?.accounts?.()[0] || null } catch { account = null }
    const remaining = getRemaining(account || undefined)
    const u = remaining.usage
    json(res, {
      provider: provider
        ? { id: provider.id, model: provider.model(), account, available: true }
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
      // #426: MINDEN bejelentkezett fiok, elo zold/piros allapottal -- a
      // feluleti fiokvalasztohoz. Az elso a jelenlegi 'auto' valasztasa.
      accounts: workbenchAccountStatuses(),
      tools: TOOLS.map((t) => ({
        name: t.name, destructive: t.destructive, reversible: t.reversible,
        external_effect: t.external_effect, autonomyCategory: t.autonomyCategory,
      })),
      maxMessageChars: MESSAGE_MAX_CHARS,
    })
    return true
  }

  // --- modell a feluletrol ----------------------------------------------------
  //
  // Csak a modell allithato. A sajat Anthropic API-kulcs utja a tulajdonos
  // dontesere (#404) kikerult: a Munkapad kizarolag a bejelentkezett
  // Claude-elofizetest hasznalja. Egy POST-ban kuldott regi
  // `WORKBENCH_ANTHROPIC_API_KEY` mezot nem mentunk el (nem ismert beallitas).
  if (path === '/api/workbench/agent/config' && method === 'GET') {
    json(res, { WORKBENCH_MODEL: String(getEffectiveSettingValue('WORKBENCH_MODEL') ?? '') })
    return true
  }

  if (path === '/api/workbench/agent/config' && method === 'POST') {
    const body = await readJson(req)
    if (!body) return fail(res, 400, 'bad_json', lang, msg('bad_json', lang))
    const saved: string[] = []
    if ('WORKBENCH_MODEL' in body) {
      const raw = body['WORKBENCH_MODEL']
      const out = setOverride('WORKBENCH_MODEL', raw === null ? '' : raw)
      if (!out.ok) return fail(res, 400, 'config_invalid', lang, out.error)
      saved.push('WORKBENCH_MODEL')
    }
    if (saved.length === 0) return fail(res, 400, 'no_known_settings', lang)
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
      await settleWorkbenchApprovals(session.id).catch(() => 0)
      json(res, {
        session,
        messages: listAgentMessages(session.id),
        toolCalls: listToolCalls(session.id),
        // Elnavigalas utan visszaterve a felulet ebbol tudja, hogy a valasz
        // meg KESZUL a szerveren (es megvarja), nem pedig elveszett.
        running: isTurnRunning(turnKey(project.id, null)),
      })
      return true
    }
    if (!workItemId) return fail(res, 400, 'work_item_required', lang)
    const item = getWorkItem(workItemId)
    if (!item) return fail(res, 404, 'work_item_not_found', lang, msg('work_item_not_found', lang))
    const session = openSessionForWorkItem(item.project_id, item.id, lang)
    await settleWorkbenchApprovals(session.id).catch(() => 0)
    json(res, {
      session,
      messages: listAgentMessages(session.id),
      toolCalls: listToolCalls(session.id),
      running: isTurnRunning(turnKey(item.project_id, item.id)),
    })
    return true
  }

  // --- a futo valasz leallitasa ----------------------------------------------
  if (path === '/api/workbench/agent/stop' && method === 'POST') {
    const body = await readJson(req)
    if (!body) return fail(res, 400, 'bad_json', lang, msg('bad_json', lang))
    const projectId = String(body.project_id ?? '').trim()
    if (!projectId) return fail(res, 400, 'project_required', lang)
    const project = getProject(projectId)
    if (!project) return fail(res, 404, 'project_not_found', lang)
    const workItemId = body.work_item_id === undefined || body.work_item_id === null
      ? null
      : String(body.work_item_id).trim() || null
    const key = turnKey(project.id, workItemId)
    const ac = turnControllers.get(key)
    if (ac) ac.abort()
    json(res, { stopped: !!ac, running: isTurnRunning(key) })
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

    // #426: a felhasznalo valaszthat KONKRET fiokot; egy ismeretlen nevet nem
    // engedunk a hivasba (ures / 'auto' / ismeretlen -> a rendes auto-valasztas
    // fut a fallbackkal). Igy egy elgepelt vagy elavult nev nem nemitja el a
    // Munkapadot.
    const wantAccount = String(body.account ?? '').trim()
    const account = wantAccount && wantAccount !== 'auto' && isKnownWorkbenchAccount(wantAccount)
      ? wantAccount
      : undefined

    const input = {
      projectId: project.id,
      workItemId,
      message: String(body.message ?? ''),
      lang,
      actor: actor(ctx),
      account,
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
    // A bongeszo elmenese (elnavigalas, ujratoltes) NEM allitja le a valaszt:
    // a fordulo a szerveren vegigfut es a beszelgetesbe mentodik, visszaterve a
    // felulet betolti (a session-lekeres `running` mezoje mondja meg, hogy meg
    // keszul). Leallitani a Leallitas gomb (/stop) vagy a felso idokorlat tud.
    // Merve (Node 22): a `req` 'close' a body beolvasasa utan mar NEM sul el;
    // a kapcsolat bontasat a `res` 'close' jelzi -- azt csak arra hasznaljuk,
    // hogy ne irjunk egy lezart kapcsolatba.
    let clientGone = false
    res.on('close', () => { clientGone = true })
    // Felso korlat egy fordulora: ha a szolgaltato kapcsolata megakad, a
    // "fut mar" zar ne foghassa orokre a munkadarabot.
    const turnCap = setTimeout(() => ac.abort(), TURN_MAX_MS)
    const key = turnKey(project.id, workItemId)
    // Csak a SAJAT fordulonk kapcsoloja kerul a nyilvantartasba: egy "mar fut"
    // miatt elutasitott keres nem irhatja felul a futoet.
    const ownsController = !turnControllers.has(key)
    if (ownsController) turnControllers.set(key, ac)

    const send = (event: string, data: unknown): void => {
      if (clientGone) return
      try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`) } catch { clientGone = true }
    }

    // #433 (B opcio): a teljes erteku mod eldontese. A kapcsolo ALAPBOL ki:
    // ilyenkor a megszokott projekt-asszisztens fut, semmi nem valtozik. Ha be
    // van kapcsolva ES van online kod-hid worker -> a valodi Claude Code
    // sessionhoz iranyitunk; ha be van kapcsolva, de nincs worker, a chat NEM
    // hal meg: setup-jelzest kuldunk, es tovabb fut a megszokott asszisztens.
    const fullAgentEnabled = String(getEffectiveSettingValue('WORKBENCH_FULL_AGENT')) === '1'
    const workerOnline = fullAgentEnabled ? codeBridgeHealth().workerOnline : false
    const decision = decideWorkbenchBackend({ fullAgentEnabled, workerOnline })

    try {
      if (decision.backend === 'code-bridge') {
        // Ugyanaz a "fut mar" zar, mint a projekt-asszisztensnel: igy a
        // felulet visszaterve latja, hogy keszul a valasz, es a Leallitas is mukodik.
        if (!claimTurn(key)) {
          send('error', { type: 'error', code: 'busy', message: msg('busy', lang) })
        } else {
          try {
            const item = workItemId ? getWorkItem(workItemId) : null
            const session = item
              ? openSessionForWorkItem(project.id, item.id, lang)
              : openSessionForWorkItem(project.id, projectSessionKey(project.id), lang)
            send('session', { type: 'session', sessionId: session.id })
            const folder = projectFileTarget(project, '')
            const prompt = buildCodeBridgePrompt({
              projectName: project.name || project.id,
              projectFolder: folder.ok ? folder.dirAbs : null,
              workItem: item ? { title: item.title, type: item.type } : null,
              history: listAgentMessages(session.id),
              message: input.message.trim(),
              lang,
            })
            for await (const ev of runCodeBridgeTurn(
              {
                projectRef: project.name || project.id,
                message: input.message,
                prompt,
                lang,
                requestedBy: input.actor ?? null,
                chatId: null,
                signal: ac.signal,
              },
              {
                enqueue: (i) => {
                  const r = enqueueCodeTask({ project: i.project, prompt: i.prompt, origin: 'dashboard', requestedBy: i.requestedBy, chatId: i.chatId })
                  return 'error' in r ? { ok: false, message: r.error } : { ok: true, id: r.task.id }
                },
                getTask: (id) => {
                  const t = getCodeTask(id)
                  return t ? { status: t.status, result: t.result, summary: t.summary, error: t.error } : null
                },
                now: () => Date.now(),
                sleep: (ms, signal) => new Promise<void>((resolve) => {
                  const to = setTimeout(resolve, ms)
                  signal?.addEventListener('abort', () => { clearTimeout(to); resolve() }, { once: true })
                }),
                timeoutMs: CODE_BRIDGE_CHAT_WAIT_MS,
                record: (role, content) => { if (content.trim()) addAgentMessage(session.id, role, content) },
                cancel: (id) => { cancelCodeTask(id) },
              },
            )) {
              // A kliens elmenetele utan is vegigolvassuk: a valasz igy a
              // beszelgetesbe kerul, nem szakad felbe.
              send(ev.type, ev)
            }
          } finally {
            releaseTurn(key)
          }
        }
      } else {
        // Bekapcsolt teljes mod worker nelkul: eloszor a setup-jelzes, aztan a
        // megszokott asszisztens valaszol (sose halott chat).
        if (decision.needsWorkerSetup) {
          send('notice', { type: 'notice', code: 'code_bridge_no_worker', message: msg('code_bridge_no_worker', lang) })
        }
        for await (const ev of runTurn({ ...input, signal: ac.signal })) {
          // A kliens elmenetele utan is vegigolvassuk (lasd fent).
          send(ev.type, ev)
        }
      }
    } catch (e) {
      // SOSE talalgatjuk az okot: a tenyleges hiba megy ki.
      send('error', { type: 'error', code: 'internal', message: msg('provider_failed', lang, { detail: e instanceof Error ? e.message : String(e) }) })
    } finally {
      clearTimeout(turnCap)
      if (ownsController && turnControllers.get(key) === ac) turnControllers.delete(key)
    }
    if (!clientGone) { try { res.end() } catch { /* mar lezarult */ } }
    return true
  }

  return false
}
