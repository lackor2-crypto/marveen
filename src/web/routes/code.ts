// REST surface of the VS Code Claude Code bridge.
//
// Two kinds of caller:
//   * PRODUCERS  -- the owner (dashboard / curl), the Telegram code bot, and
//     Marvin's dispatch skill. They create tasks and read status.
//   * THE WORKER -- the Windows-side executor. It reports discovered sessions,
//     claims one task at a time, heartbeats while `claude.exe` runs, and posts
//     the result back.
//
// Every path here sits behind the normal dashboard auth gate (Authorization:
// Bearer <store/.dashboard-token>) -- no new public surface was opened for the
// worker. On top of that, the worker paths additionally require a LOOPBACK peer:
// the Windows host reaches WSL through localhost forwarding and shows up as
// 127.0.0.1 (measured), so a remote caller with a leaked token still cannot
// impersonate the executor or drain the queue.

import { json, readBody } from '../http-helpers.js'
import { logger } from '../../logger.js'
import {
  CODE_BRIDGE_ENABLED, CODE_PERMISSION_MODE, PROJECT_ROOT,
  CODE_BOT_TOKEN, CODE_BOT_ALLOWED_CHAT_IDS, CODE_BRIDGE_EXCLUDE,
} from '../../config.js'
import {
  listCodeSessions, getCodeSession, upsertCodeSession, deleteCodeSession,
  dismissCodeWorkspace, undismissCodeWorkspace, isDismissedWorkspace,
  enqueueCodeTask, getCodeTask, getCodeTaskByPrefix, listCodeTasks,
  claimNextCodeTask, heartbeatCodeTask, completeCodeTaskDetailed, cancelCodeTask,
  clearFinishedCodeTasks,
  pruneUnreportedCodeSessions,
  recordCodeCandidates,
  listCodeCandidates,
  aliasFromWorkspacePath, normalizeAlias, isExcludedProject,
  recordCodeWorkerSeen, codeBridgeHealth, WORKER_STALE_MS, listCodeTabs,
  type CodeTaskStatus, type CodeTaskOrigin,
} from '../code-bridge-store.js'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getEffectiveSettingValue, setOverride } from '../../settings-store.js'
import { notifyCodeTaskFinished } from '../code-bridge-notify.js'
import { resolveCodeBotIdentity } from '../code-bridge-telegram.js'
import { readBrokerConfig } from '../context-broker-store.js'
import { BROKER_ROLE_IDS } from '../../context-broker.js'
import type { RouteContext } from './types.js'

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/**
 * Which kind of host Marveen itself runs on -- 'wsl', 'windows' or 'unix'.
 *
 * This decides what the install card may print as the token's path, and there
 * is exactly one topology where a `\\wsl.localhost\...` path is right. A
 * fresh install can just as easily be Marveen native on Windows, or Marveen on
 * a Linux host with the worker on a separate PC -- and the page prints what it
 * is told, so guessing wrong hands the new owner a command that cannot work
 * and no hint as to why.
 *
 * `WSL_DISTRO_NAME` is NOT the detector: it is absent under a systemd user
 * service, which is how Marveen actually runs. /proc/version carries the
 * 'microsoft' marker in every WSL2 kernel and survives losing the env.
 */
export function detectHostKind(): 'wsl' | 'windows' | 'unix' {
  if (process.platform === 'win32') return 'windows'
  if (process.platform !== 'linux') return 'unix'
  if (process.env['WSL_DISTRO_NAME'] || process.env['WSL_INTEROP']) return 'wsl'
  try {
    if (/microsoft/i.test(readFileSync('/proc/version', 'utf8'))) return 'wsl'
  } catch {
    // No /proc (a container without it, a BSD): plain unix is the safe answer.
  }
  return 'unix'
}

function isLoopback(remote: string | undefined): boolean {
  return Boolean(remote && LOOPBACK.has(remote))
}

/** A malformed percent-escape ("%", "%zz") makes decodeURIComponent THROW, and
 *  an uncaught throw in a route turns a bad URL into a 500 "Szerver hiba". The
 *  raw segment is the honest fallback: it simply will not match any id. */
function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

async function parseJsonBody<T>(ctx: RouteContext): Promise<T | null> {
  try {
    const body = await readBody(ctx.req, { maxBytes: 2 * 1024 * 1024 })
    if (body.length === 0) return {} as T
    return JSON.parse(body.toString()) as T
  } catch {
    return null
  }
}

/** Ket utvonal ugyanarra a mappara mutat-e. A worker `C:\\Projects\\X`-et
 *  jelent, a begepelt szoveg viszont lehet `c:\\projects\\x\\` -- a Windows
 *  mindkettot ugyanannak latja, tehat mi sem kuldhetjuk a felhasznalot UUID-t
 *  vadaszni egyetlen zaro visszaper miatt. */
function sameWorkspace(a: string, b: string): boolean {
  const norm = (x: string) => x.trim().replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase()
  return norm(a) !== '' && norm(a) === norm(b)
}

export async function tryHandleCode(ctx: RouteContext): Promise<boolean> {
  const { res, path, method, url } = ctx
  if (!path.startsWith('/api/code/')) return false

  // The health/config/installer surface answers even when the bridge is OFF --
  // that is exactly when the owner needs to see WHY nothing happens and switch it
  // back on. Gating these too would mean the only way back from a switch flipped
  // in the UI is hand-editing a file, which is the failure this whole page exists
  // to remove. Everything that actually MOVES a task stays behind the gate.
  const alwaysOn = path === '/api/code/health' || path === '/api/code/config' || path === '/api/code/worker-script'
  if (!CODE_BRIDGE_ENABLED && !alwaysOn) {
    json(res, { error: 'code bridge disabled (CODE_BRIDGE_ENABLED=0)' }, 503)
    return true
  }

  // ---- projects / session map -------------------------------------------

  // ---- health / config / installer --------------------------------------
  //
  // Everything below exists so the bridge can be OPERATED from the dashboard
  // alone. Before these, a fresh install had no way to see whether the executor
  // was alive, no way to set the bot token without hand-editing .env, and no
  // way to get the worker onto Windows without a terminal.

  if (path === '/api/code/health' && method === 'GET') {
    const health = codeBridgeHealth()
    // Where the worker will read the dashboard token from, AS THE WORKER'S OWN
    // MACHINE SEES IT -- or `null` when no such path exists, which is the case
    // whenever the worker is on a DIFFERENT machine than Marveen. A null here
    // is not a failure: it tells the page to print the `-Token` form instead of
    // a path that would resolve to nothing on the executor's side.
    //
    // WSL_DISTRO_NAME is absent under a systemd user service, so 'Ubuntu' is the
    // fallback -- wrong only on a renamed distro, where the owner can still edit
    // the printed path by hand.
    const distro = (process.env['WSL_DISTRO_NAME'] ?? '').trim() || 'Ubuntu'
    const hostKind = detectHostKind()
    const winRoot = PROJECT_ROOT.replace(/\//g, '\\')
    const tokenPath =
      hostKind === 'wsl' ? `\\\\wsl.localhost\\${distro}${winRoot}\\store\\.dashboard-token`
      : hostKind === 'windows' ? `${winRoot}\\store\\.dashboard-token`
      : null
    // Hany mappat TALALT MAR a vegrehajto, amibol meg nem lett projekt. Enelkul
    // a nulla-projektes kartya csak azt tudja mondani, hogy "nyiss meg egy
    // projektet VS Code-ban" -- ami annak a tulajdonosnak, akinek az egyetlen
    // workspace-e kizarva var a listaban, pont a rossz iranyba mutat.
    const knownWorkspaces = listCodeSessions()
    let candFree = 0
    let candExcluded = 0
    // Boss, 2026-08-23: "a vscode os kartyarol eltunt minden miert ?" -- egy
    // levett mappa utan a kartya ugyanazt mondta, mint egy FRISS telepites
    // ("meg egyik sincs felveve"), holott a ket allapot nem ugyanaz. A nulla
    // ket dolgot jelent, ezert a levett mappakat KULON szamoljuk, es a felulet
    // ki is mondja, hogy nem hianyzik, hanem le van veve.
    let candDismissed = 0
    for (const c of listCodeCandidates()) {
      if (knownWorkspaces.some((k) => sameWorkspace(k.workspacePath, c.workspacePath))) continue
      if (isDismissedWorkspace(c.workspacePath)) candDismissed++
      else if (isExcludedProject(normalizeAlias(aliasFromWorkspacePath(c.workspacePath)))) candExcluded++
      else candFree++
    }
    json(res, {
      ...health,
      candidates: { free: candFree, excluded: candExcluded, dismissed: candDismissed },
      staleAfterMs: WORKER_STALE_MS,
      enabled: CODE_BRIDGE_ENABLED,
      permissionMode: CODE_PERMISSION_MODE,
      // The token itself is NEVER returned -- only whether one is configured.
      botConfigured: CODE_BOT_TOKEN.length > 0,
      // A kartya NEVE. `reason` valasztja szet a "nincs bot beallitva"-t a
      // "van, de nem tudtam lekerdezni"-tol; a masodikat a felulet kimondja.
      codeBot: await resolveCodeBotIdentity(),
      allowedChatIds: CODE_BOT_ALLOWED_CHAT_IDS,
      excluded: CODE_BRIDGE_EXCLUDE,
      // `tokenFile` is the path on THIS machine (always true, whatever the
      // topology) so a remote-worker install can be told which file to open.
      installHint: { tokenPath, distro, hostKind, tokenFile: `${PROJECT_ROOT}/store/.dashboard-token` },
    })
    return true
  }

  // The five settings the bridge runs on. A secret is reported as a boolean
  // ("is one set"), never echoed back -- a page that redisplays a bot token
  // puts it in the browser history, the DOM and every screenshot.
  if (path === '/api/code/config' && method === 'GET') {
    json(res, {
      CODE_BRIDGE_ENABLED: String(getEffectiveSettingValue('CODE_BRIDGE_ENABLED')),
      CODE_PERMISSION_MODE: String(getEffectiveSettingValue('CODE_PERMISSION_MODE')),
      CODE_BOT_ALLOWED_CHAT_IDS: String(getEffectiveSettingValue('CODE_BOT_ALLOWED_CHAT_IDS')),
      CODE_BRIDGE_EXCLUDE: String(getEffectiveSettingValue('CODE_BRIDGE_EXCLUDE')),
      botConfigured: String(getEffectiveSettingValue('CODE_BOT_TOKEN')).length > 0,
      // Stored values differ from LIVE ones until the dashboard restarts; the
      // page uses this to show the "restart needed" badge honestly instead of
      // pretending a saved setting already took effect.
      live: {
        enabled: CODE_BRIDGE_ENABLED,
        permissionMode: CODE_PERMISSION_MODE,
        botConfigured: CODE_BOT_TOKEN.length > 0,
        allowedChatIds: CODE_BOT_ALLOWED_CHAT_IDS,
        excluded: CODE_BRIDGE_EXCLUDE,
      },
    })
    return true
  }

  if (path === '/api/code/config' && method === 'POST') {
    const body = await parseJsonBody<Record<string, unknown>>(ctx)
    if (!body) { json(res, { error: 'invalid JSON' }, 400); return true }
    const ALLOWED = [
      'CODE_BRIDGE_ENABLED', 'CODE_PERMISSION_MODE', 'CODE_BOT_TOKEN',
      'CODE_BOT_ALLOWED_CHAT_IDS', 'CODE_BRIDGE_EXCLUDE',
    ]
    const saved = []
    for (const key of ALLOWED) {
      if (!(key in body)) continue
      const raw = body[key]
      // An untouched secret field posts back empty; that must not silently WIPE
      // a configured token. Clearing is deliberate: send null.
      if (key === 'CODE_BOT_TOKEN' && raw === '') continue
      const out = setOverride(key, raw === null ? '' : raw)
      if (!out.ok) { json(res, { error: key + ': ' + out.error }, 400); return true }
      saved.push(key)
    }
    if (saved.length === 0) { json(res, { error: 'no known settings in body' }, 400); return true }
    logger.info({ saved }, 'code-bridge: config updated from dashboard')
    // Every one of these is a boot-time const in config.ts, so the page has to
    // say so rather than let the owner believe it already took effect.
    json(res, { saved, restartRequired: true })
    return true
  }

  // Hands the worker's own source to the browser, so Windows can be set up by
  // downloading two files from this page -- no repo checkout, no UNC path to
  // type, no terminal. Served from PROJECT_ROOT and hard-restricted to the two
  // known basenames: a path parameter here would be an arbitrary file read
  // behind the dashboard token.
  if (path === '/api/code/worker-script' && method === 'GET') {
    const which = url.searchParams.get('file') === 'cmd' ? 'cmd' : 'ps1'
    const name = which === 'cmd' ? 'marvin-code-worker.cmd' : 'marvin-code-worker.ps1'
    try {
      const text = readFileSync(join(PROJECT_ROOT, 'scripts', 'windows', name), 'utf8')
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': 'attachment; filename="' + name + '"',
        'Cache-Control': 'no-store',
      })
      res.end(text)
    } catch (err) {
      logger.warn({ err, name }, 'code-bridge: worker script unreadable')
      json(res, { error: 'worker script not found in this install' }, 404)
    }
    return true
  }

  // Mit lat a worker EZEN a gepen. Harom allapot, mert harom kulon teendo:
  // a mar regisztralt sor nem kell megegyszer, a kizart csak a kizaras
  // feloldasa utan vehető fel, az uj pedig egy kattintassal.
  if (path === '/api/code/candidates' && method === 'GET') {
    const known = listCodeSessions()
    const all = listCodeCandidates()
    // Ez a lista MAPPAKROL szol ("tallozas"), nem beszelgetesekrol: mappankent
    // egy sor. A worker 2026-08-23 ota minden chat fulet jelent, ezert itt a
    // legfrissebbre (`primary`) kell szurni -- kulonben ugyanaz a mappa
    // haromszor allna a listaban, haromszor felajanlott "Felvetel" gombbal.
    // A tobbi ful a `/api/code/tabs`-on erheto el.
    const candidates = all.filter((c) => c.primary).map((c) => {
      const registered = known.find((k) => k.workspacePath.toLowerCase() === c.workspacePath.toLowerCase())
      const alias = normalizeAlias(aliasFromWorkspacePath(c.workspacePath))
      return {
        workspacePath: c.workspacePath,
        sessionId: c.sessionId,
        mtime: c.mtime,
        host: c.host,
        reportedAt: c.reportedAt,
        alias: registered ? registered.project : alias,
        state: registered ? 'registered' : isExcludedProject(alias) ? 'excluded' : 'new',
        // A mappa legfrissebb beszelgetesenek felirata (a VS Code fulcimke), es
        // hogy HANY beszelgetes tartozik a mappahoz -- a tobbi a `/tabs`-on.
        title: c.title,
        tabCount: all.filter((x) => x.workspacePath.toLowerCase() === c.workspacePath.toLowerCase()).length,
      }
    })
    json(res, { candidates })
    return true
  }

  // Egy VS Code ablakban tobb Claude Code chat ful lehet, es mindegyik KULON
  // beszelgetes ugyanabban a mappaban. Ez a vegpont mondja meg, mi van nyitva --
  // cimmel, nem UUID-vel --, hogy se a tulajnak, se Marvinnak ne kelljen nevet
  // kitalalnia es megjegyeznie: kilistazza a fuleket, es a valasztott ful
  // azonositoja megy a `POST /api/code/tasks` `sessionId` mezojebe.
  if (path === '/api/code/tabs' && method === 'GET') {
    // A csoportositas a store-ban lakik (`listCodeTabs`), hogy a Telegram `/tabs`
    // es ez a vegpont BIZTOSAN ugyanazt a listat mondja.
    json(res, listCodeTabs())
    return true
  }

  if (path === '/api/code/projects' && method === 'GET') {
    // A szerepek (tervezo / megvalosito / ellenorzo) ITT mennek ki, nem csak a
    // feluleten: enelkul Marvin nem tudna, mit szabad ennek a vegrehajtonak
    // kiosztani -- a jelolonegyzet magaban csak dekoracio lenne.
    //
    // Az ures tomb ket dolgot jelenthet, ezert nem csak `roles` megy: a
    // `rolesAssigned` mondja meg, hogy egyaltalan van-e barhol kiosztott szerep
    // a flottaban. Ha nincs, akkor a szerep-nelkuliseg nem korlatozas (a
    // kontextus-keszito donti el feladatonkent); ha van, de ezen a kartyan
    // nincs, akkor ez a vegrehajto SZANDEKOSAN nem kap olyan munkat.
    const roleCfg = readBrokerConfig().roles
    const anyAssigned = BROKER_ROLE_IDS.some((id) => Boolean(roleCfg[id]))
    // Kontextus-meret (Boss, 2026-08-23: "kiiratni hogy jelenleg mennyi a
    // token amit hasznlal"). A regisztralt beszelgetes SAJAT merese megy ki --
    // ha nem latunk ra (regi worker, meg nincs assistant-valasz), akkor `null`,
    // amit a felulet "nem tudom"-kent mond el, nem nullakent.
    const tabs = listCodeTabs()
    const tokensBySession = new Map<string, number>()
    const modelBySession = new Map<string, string>()
    for (const g of tabs.projects) {
      for (const tb of g.tabs) {
        if (tb.contextTokens !== null) tokensBySession.set(tb.sessionId, tb.contextTokens)
        if (tb.model !== null) modelBySession.set(tb.sessionId, tb.model)
      }
    }
    // Boss, 2026-08-23: "nem lenne celszeru oda kitenni a elo chateket? es egy
    // jelolonegyzetet eleje tenni? amelyik be van jelolve az az aktualis elo."
    // -- a kartyan is valaszthato legyen, melyik beszelgetesbe megy a munka.
    // Csak azok a fulek mennek ki, amiket a worker NYITOTTKENT mert; a lista
    // uressege ket dolgot jelenthet, ezert megy ki a `tabsReason` is.
    const tabsByWorkspace = new Map<string, typeof tabs.projects[number]>()
    for (const g of tabs.projects) tabsByWorkspace.set(g.workspacePath.toLowerCase(), g)
    const projects = listCodeSessions().map((p) => ({
      ...p,
      tabs: (tabsByWorkspace.get(p.workspacePath.toLowerCase())?.tabs ?? []).map((tb) => ({
        sessionId: tb.sessionId,
        shortId: tb.shortId,
        title: tb.title,
        live: tb.live,
        current: tb.sessionId === p.sessionId,
        contextTokens: tb.contextTokens,
        model: tb.model,
      })),
      roleHolder: `vscode:${p.project}`,
      roles: BROKER_ROLE_IDS.filter((id) => roleCfg[id] === `vscode:${p.project}`),
      contextTokens: tokensBySession.get(p.sessionId) ?? null,
      // A modell NEM fix: azt mutatjuk, amivel a beszelgetes eppen valaszolt
      // (Boss, 2026-08-23: "ne fix legyen hanem dinamikus attol fuggoen hogy
      // mi van kivalasztva a vscodban"). `null` = nem latunk oda -- kitalalt
      // modellnevet nem irunk ki.
      model: modelBySession.get(p.sessionId) ?? null,
    }))
    // `tabsReason`: a felulet enelkul nem tudna megkulonboztetni a "nincs
    // tobb nyitott beszelgetes"-t a "nem futott meg a Windows-munkas"-tol.
    json(res, { projects, permissionMode: CODE_PERMISSION_MODE, rolesAssigned: anyAssigned, tabsReason: tabs.reason })
    return true
  }

  if (path === '/api/code/projects' && method === 'POST') {
    const body = await parseJsonBody<{ project?: string; workspacePath?: string; sessionId?: string; title?: string; pinned?: boolean }>(ctx)
    if (!body) { json(res, { error: 'invalid JSON' }, 400); return true }
    // A session-azonositot a worker MAR ISMERI: ha erre a mappara jelentett
    // sessiont, akkor senkinek nem kell UUID-t begepelnie -- sem a feluleten,
    // sem a REST-en at. Ezt kerdezte a Boss: "es mit irjak a UUID hez?
    // kotelezo? nem?" -- a valasz: csak akkor, ha a vegrehajto nem latja a
    // mappat (masik gep, zart VS Code), mert olyankor tenyleg sehonnan nem
    // tudhato.
    const workspacePath = (body.workspacePath ?? '').trim()
    const sessionId =
      (body.sessionId ?? '').trim() ||
      listCodeCandidates().find((c) => sameWorkspace(c.workspacePath, workspacePath))?.sessionId ||
      ''
    if (!body.project || !workspacePath || !sessionId) {
      json(res, {
        error: !sessionId && body.project && workspacePath
          ? 'sessionId is required: the worker has not reported a session for this workspace'
          : 'project, workspacePath and sessionId are required',
      }, 400)
      return true
    }
    // Mapping an excluded alias would create a row that discovery deletes on its
    // next pass and that no task can use -- say so instead of accepting it.
    if (isExcludedProject(body.project)) {
      json(res, { error: `project "${body.project}" is excluded from the code bridge (CODE_BRIDGE_EXCLUDE)` }, 400)
      return true
    }
    try {
      // A kezi bekotes VISSZAVONJA a korabbi levetelt -- kulonben a tulaj a
      // sajat feluleterol nem tudna visszahozni, amit egyszer letorolt.
      undismissCodeWorkspace(workspacePath)
      // An explicit map from the owner is a pin by default: it exists precisely
      // to stop discovery from moving the alias somewhere else.
      const session = upsertCodeSession({
        project: body.project,
        workspacePath,
        sessionId,
        title: body.title ?? null,
        pinned: body.pinned ?? true,
      })
      json(res, session)
    } catch (err) {
      json(res, { error: err instanceof Error ? err.message : String(err) }, 400)
    }
    return true
  }

  const projectMatch = /^\/api\/code\/projects\/([^/]+)$/.exec(path)
  if (projectMatch && method === 'DELETE') {
    const alias = safeDecode(projectMatch[1]!)
    // A mappa utjat MEG A TORLES ELOTT kell kiolvasni: utana mar nincs honnan.
    const row = listCodeSessions().find((s) => s.project === alias)
    // Csak a torles keves lenne: a felderites egy percen belul ujra bekotne
    // ugyanazt a mappat, es a gomb ugy nezne ki, mintha nem tortent volna semmi.
    // A `forget=0` a regi viselkedes (csak a sor torlese).
    const forget = url.searchParams.get('forget') !== '0'
    if (forget && row) dismissCodeWorkspace(row.workspacePath, alias)
    const ok = deleteCodeSession(alias)
    json(res, { deleted: ok, forgotten: forget && row !== undefined, workspacePath: row?.workspacePath ?? null }, ok ? 200 : 404)
    return true
  }

  // Worker discovery report. Sessions are keyed by workspace; the alias is the
  // folder name unless the owner already mapped one for that workspace.
  if (path === '/api/code/sessions' && method === 'POST') {
    if (!isLoopback(ctx.req.socket.remoteAddress)) { json(res, { error: 'loopback only' }, 403); return true }
    type ReportedSession = {
      workspacePath?: string
      sessionId?: string
      title?: string
      mtime?: number
      project?: string
      /** A mappa legfrissebb beszelgetese. A tobbi ful is BEJON (hogy latszodjon
       *  es cimezheto legyen), de projektkent csak a primary regisztralodik --
       *  kulonben egy mappa 10 fule 10 alias ala akarna beulni ugyanazon a neven. */
      primary?: boolean
      /** Nyitva van-e a ful a VS Code-ban (elo PID a ~/.claude/sessions alapjan).
       *  Regi worker nem kuldi -> ott `undefined`, ami "nem latunk oda". */
      live?: boolean | null
      contextTokens?: number
      /** Melyik modell felel a beszelgetesben (a transcript utolso soraból). */
      model?: string
    }
    const body = await parseJsonBody<{ host?: string; sessions?: ReportedSession | ReportedSession[] }>(ctx)
    // A single session may arrive as a bare object rather than a one-element
    // array: PowerShell's ConvertTo-Json flattens `@(x)` to `x`. Rejecting that
    // would break exactly the machines with one project -- the smallest, most
    // likely install.
    const reported: ReportedSession[] | null = Array.isArray(body?.sessions)
      ? body.sessions
      : body?.sessions && typeof body.sessions === 'object'
        ? [body.sessions]
        : null
    if (!body || !reported) { json(res, { error: 'sessions[] required' }, 400); return true }

    // Stamped BEFORE the loop: a worker that reports zero sessions (every
    // workspace filtered out, or none open) is still a LIVE worker, and the
    // difference between "the executor is gone" and "it runs but finds nothing"
    // is the whole diagnosis. Stamping only on success would have reported the
    // running-but-empty worker of 2026-08-20 as dead.
    recordCodeWorkerSeen(body.host ?? 'windows', 'discovery', reported.length)
    // A NYERS lista is eltevodik, mielott a kizaras vagy a regisztracio szurne:
    // a felulet ebbol tud valaszthato listat kinalni ahelyett, hogy utvonalat
    // es UUID-t kellene begepelni.
    recordCodeCandidates(body.host ?? 'windows', reported)

    const known = listCodeSessions()
    const registered: string[] = []
    // Egy REGI worker egyetlen `primary` mezot sem kuld: olyankor MINDEN sor
    // projektnek szamit, ahogy 2026-08-23 elott. Ha viszont a worker jeloli az
    // elsodleges fulet, csak azt regisztraljuk -- a tobbi ful jeloltkent mar
    // benne van a listaban, cimezni pedig session-azonositoval lehet rajuk.
    const reportsPrimary = reported.some((s) => typeof s.primary === 'boolean')
    for (const s of reported) {
      if (!s.workspacePath || !s.sessionId) continue
      if (reportsPrimary && s.primary !== true) continue
      const explicit = known.find((k) => k.workspacePath.toLowerCase() === s.workspacePath!.toLowerCase())
      const alias = normalizeAlias(s.project ?? explicit?.project ?? aliasFromWorkspacePath(s.workspacePath))
      if (!alias) continue
      // Fenced off by the owner: don't register it, and clean up a row that was
      // registered before the exclusion was set -- otherwise the alias would
      // stay dispatchable until someone noticed.
      if (isExcludedProject(alias)) {
        deleteCodeSession(alias)
        continue
      }
      // A tulaj levette ezt a mappat a feluletrol. A fulek jeloltkent tovabbra
      // is latszanak (igy vissza tudja hozni), projektkent viszont nem kotjuk
      // be ujra.
      if (isDismissedWorkspace(s.workspacePath)) continue
      try {
        const row = upsertCodeSession(
          {
            project: alias,
            workspacePath: s.workspacePath,
            sessionId: s.sessionId,
            title: s.title ?? null,
            host: body.host ?? null,
            transcriptMtime: s.mtime ?? null,
          },
          { fromDiscovery: true },
        )
        registered.push(row.project)
      } catch (err) {
        logger.warn({ err, workspace: s.workspacePath }, 'code-bridge: session report rejected')
      }
    }
    // A jelentes a hitelesek listaja erre a gepre: ami kimaradt belole, annak
    // a workspace-e mar nincs meg (a worker eleve nem jelenti a nem letezot).
    const pruned = pruneUnreportedCodeSessions(body.host ?? 'windows', registered)
    if (pruned.length > 0) logger.info({ host: body.host, pruned }, 'code-bridge: dropped sessions no longer reported')
    json(res, { registered, pruned, projects: listCodeSessions() })
    return true
  }

  // ---- tasks -------------------------------------------------------------

  if (path === '/api/code/tasks' && method === 'POST') {
    const body = await parseJsonBody<{
      project?: string
      prompt?: string
      origin?: string
      requestedBy?: string
      chatId?: string
      /** Opcionalis: EGY konkret chat ful a projekt mappajabol (a `/api/code/tabs`
       *  listajabol). Elhagyva minden a regi marad: a projekt legfrissebb
       *  beszelgetese kapja a feladatot. */
      sessionId?: string
    }>(ctx)
    if (!body) { json(res, { error: 'invalid JSON' }, 400); return true }
    if (!body.project || !body.prompt) { json(res, { error: 'project and prompt are required' }, 400); return true }
    const origin = (['telegram', 'agent', 'dashboard', 'api'] as const).includes(body.origin as CodeTaskOrigin)
      ? (body.origin as CodeTaskOrigin)
      : 'api'
    const out = enqueueCodeTask({
      project: body.project,
      prompt: body.prompt,
      origin,
      requestedBy: body.requestedBy ?? null,
      chatId: body.chatId ?? null,
      sessionId: body.sessionId ?? null,
    })
    if ('error' in out) { json(res, out, 400); return true }
    logger.info({ task: out.task.id, project: out.task.project, origin }, 'code-bridge: task queued')
    json(res, out.task, 201)
    return true
  }

  if (path === '/api/code/tasks' && method === 'GET') {
    const project = url.searchParams.get('project') ?? undefined
    const status = (url.searchParams.get('status') ?? undefined) as CodeTaskStatus | undefined
    const limit = Number(url.searchParams.get('limit') ?? '20')
    json(res, { tasks: listCodeTasks({ project, status, limit: Number.isFinite(limit) ? limit : 20 }) })
    return true
  }

  // History housekeeping. Without this the only way to clear a page full of
  // throwaway test rounds is hand-editing SQLite -- which a fresh install has
  // no business needing.
  if (path === '/api/code/tasks' && method === 'DELETE') {
    json(res, { removed: clearFinishedCodeTasks() })
    return true
  }

  // Claim is a POST: it mutates (running + lease + attempt count).
  if (path === '/api/code/tasks/claim' && method === 'POST') {
    if (!isLoopback(ctx.req.socket.remoteAddress)) { json(res, { error: 'loopback only' }, 403); return true }
    const body = await parseJsonBody<{ host?: string }>(ctx)
    if (!body) { json(res, { error: 'invalid JSON' }, 400); return true }
    const host = (body.host ?? '').trim() || 'unknown-worker'
    recordCodeWorkerSeen(host, 'claim')
    const task = claimNextCodeTask(host)
    if (!task) { json(res, { task: null }); return true }
    logger.info({ task: task.id, project: task.project, session: task.sessionId, host }, 'code-bridge: task claimed')
    json(res, { task, permissionMode: CODE_PERMISSION_MODE })
    return true
  }

  const taskMatch = /^\/api\/code\/tasks\/([^/]+)(?:\/(heartbeat|result|cancel))?$/.exec(path)
  if (taskMatch) {
    const rawId = safeDecode(taskMatch[1]!)
    const action = taskMatch[2]
    const task = getCodeTask(rawId) ?? getCodeTaskByPrefix(rawId)
    if (!task) { json(res, { error: 'task not found' }, 404); return true }

    if (!action && method === 'GET') { json(res, task); return true }

    if (action === 'heartbeat' && method === 'POST') {
      if (!isLoopback(ctx.req.socket.remoteAddress)) { json(res, { error: 'loopback only' }, 403); return true }
      const body = await parseJsonBody<{ host?: string }>(ctx)
      const hbHost = (body?.host ?? '').trim() || 'unknown-worker'
      recordCodeWorkerSeen(hbHost, 'heartbeat')
      const ok = heartbeatCodeTask(task.id, hbHost)
      json(res, { ok }, ok ? 200 : 409)
      return true
    }

    if (action === 'result' && method === 'POST') {
      if (!isLoopback(ctx.req.socket.remoteAddress)) { json(res, { error: 'loopback only' }, 403); return true }
      const body = await parseJsonBody<{
        ok?: boolean; result?: string; error?: string; costUsd?: number; durationMs?: number; numTurns?: number; host?: string
      }>(ctx)
      if (!body) { json(res, { error: 'invalid JSON' }, 400); return true }
      // Reporting a result IS a sign of life -- and the one worker call that
      // proves the executor got all the way through a job. Stamped here so the
      // presence table matches what recordCodeWorkerSeen's own contract says.
      const resHost = (body.host ?? '').trim() || null
      if (resHost) recordCodeWorkerSeen(resHost, 'result')
      const { task: updated, outcome } = completeCodeTaskDetailed(task.id, {
        ok: body.ok !== false && !body.error,
        result: body.result ?? null,
        error: body.error ?? null,
        costUsd: typeof body.costUsd === 'number' ? body.costUsd : null,
        durationMs: typeof body.durationMs === 'number' ? body.durationMs : null,
        numTurns: typeof body.numTurns === 'number' ? body.numTurns : null,
      }, Date.now(), resHost)
      if (!updated) { json(res, { error: 'task not found' }, 404); return true }
      if (outcome !== 'accepted') {
        // A result for a task that was cancelled, already finished, or handed to
        // another host. It is stored where it can do no harm, but announcing it
        // would tell the owner a decision they made was undone.
        logger.warn({ task: updated.id, outcome, status: updated.status }, 'code-bridge: late result not applied')
        json(res, { ...updated, lateResult: outcome })
        return true
      }
      logger.info({ task: updated.id, status: updated.status }, 'code-bridge: task finished')
      // Not awaited: the worker must be free to pick up the next task even if
      // Telegram is slow or down, and the result is already durable.
      void notifyCodeTaskFinished(updated)
      json(res, updated)
      return true
    }

    if (action === 'cancel' && method === 'POST') {
      // The CLI has no remote stop: `claude.exe` is already mid-run on Windows
      // and nothing here can interrupt it. Flipping the row to 'cancelled'
      // would only make the dashboard lie -- and then the real result would
      // arrive for a task the owner believes was called off. The Telegram bot
      // has always answered this way; the REST surface now says the same thing.
      if (task.status === 'running') {
        json(res, { error: 'task is already running -- the CLI cannot be stopped remotely', task }, 409)
        return true
      }
      const updated = cancelCodeTask(task.id)
      json(res, updated)
      return true
    }
  }

  // Convenience for the dashboard/CLI: the latest task of a project.
  const latestMatch = /^\/api\/code\/latest\/([^/]+)$/.exec(path)
  if (latestMatch && method === 'GET') {
    const project = safeDecode(latestMatch[1]!)
    const session = getCodeSession(project)
    const tasks = listCodeTasks({ project, limit: 1 })
    json(res, { session, task: tasks[0] ?? null })
    return true
  }

  return false
}
