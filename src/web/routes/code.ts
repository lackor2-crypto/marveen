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
  enqueueCodeTask, getCodeTask, getCodeTaskByPrefix, listCodeTasks,
  claimNextCodeTask, heartbeatCodeTask, completeCodeTaskDetailed, cancelCodeTask,
  aliasFromWorkspacePath, normalizeAlias, isExcludedProject,
  recordCodeWorkerSeen, codeBridgeHealth, WORKER_STALE_MS,
  type CodeTaskStatus, type CodeTaskOrigin,
} from '../code-bridge-store.js'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getEffectiveSettingValue, setOverride } from '../../settings-store.js'
import { notifyCodeTaskFinished } from '../code-bridge-notify.js'
import type { RouteContext } from './types.js'

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

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
    // Where the worker will read the dashboard token from, as WINDOWS sees it.
    // WSL_DISTRO_NAME is absent under a systemd user service, so 'Ubuntu' is the
    // fallback -- wrong only on a renamed distro, where the owner can still edit
    // the printed path by hand.
    const distro = (process.env['WSL_DISTRO_NAME'] ?? '').trim() || 'Ubuntu'
    const tokenPath = `\\\\wsl.localhost\\${distro}${PROJECT_ROOT.replace(/\//g, '\\')}\\store\\.dashboard-token`
    json(res, {
      ...health,
      staleAfterMs: WORKER_STALE_MS,
      enabled: CODE_BRIDGE_ENABLED,
      permissionMode: CODE_PERMISSION_MODE,
      // The token itself is NEVER returned -- only whether one is configured.
      botConfigured: CODE_BOT_TOKEN.length > 0,
      allowedChatIds: CODE_BOT_ALLOWED_CHAT_IDS,
      excluded: CODE_BRIDGE_EXCLUDE,
      installHint: { tokenPath, distro },
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

  if (path === '/api/code/projects' && method === 'GET') {
    json(res, { projects: listCodeSessions(), permissionMode: CODE_PERMISSION_MODE })
    return true
  }

  if (path === '/api/code/projects' && method === 'POST') {
    const body = await parseJsonBody<{ project?: string; workspacePath?: string; sessionId?: string; title?: string; pinned?: boolean }>(ctx)
    if (!body) { json(res, { error: 'invalid JSON' }, 400); return true }
    if (!body.project || !body.workspacePath || !body.sessionId) {
      json(res, { error: 'project, workspacePath and sessionId are required' }, 400)
      return true
    }
    // Mapping an excluded alias would create a row that discovery deletes on its
    // next pass and that no task can use -- say so instead of accepting it.
    if (isExcludedProject(body.project)) {
      json(res, { error: `project "${body.project}" is excluded from the code bridge (CODE_BRIDGE_EXCLUDE)` }, 400)
      return true
    }
    try {
      // An explicit map from the owner is a pin by default: it exists precisely
      // to stop discovery from moving the alias somewhere else.
      const session = upsertCodeSession({
        project: body.project,
        workspacePath: body.workspacePath,
        sessionId: body.sessionId,
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
    const ok = deleteCodeSession(safeDecode(projectMatch[1]!))
    json(res, { deleted: ok }, ok ? 200 : 404)
    return true
  }

  // Worker discovery report. Sessions are keyed by workspace; the alias is the
  // folder name unless the owner already mapped one for that workspace.
  if (path === '/api/code/sessions' && method === 'POST') {
    if (!isLoopback(ctx.req.socket.remoteAddress)) { json(res, { error: 'loopback only' }, 403); return true }
    type ReportedSession = { workspacePath?: string; sessionId?: string; title?: string; mtime?: number; project?: string }
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

    const known = listCodeSessions()
    const registered: string[] = []
    for (const s of reported) {
      if (!s.workspacePath || !s.sessionId) continue
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
    json(res, { registered, projects: listCodeSessions() })
    return true
  }

  // ---- tasks -------------------------------------------------------------

  if (path === '/api/code/tasks' && method === 'POST') {
    const body = await parseJsonBody<{ project?: string; prompt?: string; origin?: string; requestedBy?: string; chatId?: string }>(ctx)
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
