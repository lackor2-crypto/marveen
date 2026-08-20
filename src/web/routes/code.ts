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
import { CODE_BRIDGE_ENABLED, CODE_PERMISSION_MODE } from '../../config.js'
import {
  listCodeSessions, getCodeSession, upsertCodeSession, deleteCodeSession,
  enqueueCodeTask, getCodeTask, getCodeTaskByPrefix, listCodeTasks,
  claimNextCodeTask, heartbeatCodeTask, completeCodeTask, cancelCodeTask,
  aliasFromWorkspacePath, normalizeAlias, isExcludedProject,
  type CodeTaskStatus, type CodeTaskOrigin,
} from '../code-bridge-store.js'
import { notifyCodeTaskFinished } from '../code-bridge-notify.js'
import type { RouteContext } from './types.js'

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

function isLoopback(remote: string | undefined): boolean {
  return Boolean(remote && LOOPBACK.has(remote))
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

  if (!CODE_BRIDGE_ENABLED) {
    json(res, { error: 'code bridge disabled (CODE_BRIDGE_ENABLED=0)' }, 503)
    return true
  }

  // ---- projects / session map -------------------------------------------

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
    const ok = deleteCodeSession(decodeURIComponent(projectMatch[1]!))
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
    const task = claimNextCodeTask(host)
    if (!task) { json(res, { task: null }); return true }
    logger.info({ task: task.id, project: task.project, session: task.sessionId, host }, 'code-bridge: task claimed')
    json(res, { task, permissionMode: CODE_PERMISSION_MODE })
    return true
  }

  const taskMatch = /^\/api\/code\/tasks\/([^/]+)(?:\/(heartbeat|result|cancel))?$/.exec(path)
  if (taskMatch) {
    const rawId = decodeURIComponent(taskMatch[1]!)
    const action = taskMatch[2]
    const task = getCodeTask(rawId) ?? getCodeTaskByPrefix(rawId)
    if (!task) { json(res, { error: 'task not found' }, 404); return true }

    if (!action && method === 'GET') { json(res, task); return true }

    if (action === 'heartbeat' && method === 'POST') {
      if (!isLoopback(ctx.req.socket.remoteAddress)) { json(res, { error: 'loopback only' }, 403); return true }
      const body = await parseJsonBody<{ host?: string }>(ctx)
      const ok = heartbeatCodeTask(task.id, (body?.host ?? '').trim() || 'unknown-worker')
      json(res, { ok }, ok ? 200 : 409)
      return true
    }

    if (action === 'result' && method === 'POST') {
      if (!isLoopback(ctx.req.socket.remoteAddress)) { json(res, { error: 'loopback only' }, 403); return true }
      const body = await parseJsonBody<{
        ok?: boolean; result?: string; error?: string; costUsd?: number; durationMs?: number; numTurns?: number
      }>(ctx)
      if (!body) { json(res, { error: 'invalid JSON' }, 400); return true }
      const updated = completeCodeTask(task.id, {
        ok: body.ok !== false && !body.error,
        result: body.result ?? null,
        error: body.error ?? null,
        costUsd: typeof body.costUsd === 'number' ? body.costUsd : null,
        durationMs: typeof body.durationMs === 'number' ? body.durationMs : null,
        numTurns: typeof body.numTurns === 'number' ? body.numTurns : null,
      })
      if (!updated) { json(res, { error: 'task not found' }, 404); return true }
      logger.info({ task: updated.id, status: updated.status }, 'code-bridge: task finished')
      // Not awaited: the worker must be free to pick up the next task even if
      // Telegram is slow or down, and the result is already durable.
      void notifyCodeTaskFinished(updated)
      json(res, updated)
      return true
    }

    if (action === 'cancel' && method === 'POST') {
      const updated = cancelCodeTask(task.id)
      json(res, updated)
      return true
    }
  }

  // Convenience for the dashboard/CLI: the latest task of a project.
  const latestMatch = /^\/api\/code\/latest\/([^/]+)$/.exec(path)
  if (latestMatch && method === 'GET') {
    const project = decodeURIComponent(latestMatch[1]!)
    const session = getCodeSession(project)
    const tasks = listCodeTasks({ project, limit: 1 })
    json(res, { session, task: tasks[0] ?? null })
    return true
  }

  return false
}
