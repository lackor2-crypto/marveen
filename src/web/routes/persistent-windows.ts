// HTTP surface for the window-layout backup/restore feature (kanban 79).
//
// Boss drives this from one Settings section: save the current arrangement (and
// publish it to the private GitHub repo), restore it, or pull another machine's
// backup down onto a fresh install. The two modules behind it split cleanly --
// src/persistent-windows.ts talks to the Windows side, src/persistent-windows-sync.ts
// talks to git -- and this file is only the thin door between them and the page.
//
// Everything that touches the desktop is a POST and happens on an explicit click.
// GET is pure probing: it starts no process, so the panel can poll it freely.

import { json, readBody } from '../http-helpers.js'
import { logger } from '../../logger.js'
import { readPwStatus, runPwAction, isPwRunning } from '../../persistent-windows.js'
import {
  pushWindowLayout,
  restoreWindowLayout,
  windowLayoutSyncInfo,
} from '../../persistent-windows-sync.js'
import type { RouteContext } from './types.js'

/**
 * One place decides what a failed Windows action means for the HTTP layer.
 * A capture/restore that ran but left the tray app resident is NOT a silent
 * success: the panel has to be able to say so, so the flags stay in the body
 * instead of being flattened into a bare ok/not-ok.
 */
function actionResponse(result: Awaited<ReturnType<typeof runPwAction>>) {
  return {
    ok: result.ok,
    action: result.action,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    backups: result.backups.length,
    startedTool: result.startedTool,
    layoutChanged: result.layoutChanged ?? null,
    error: result.ok ? null : (result.stderr || 'PersistentWindows action failed'),
  }
}

export async function tryHandlePersistentWindows(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx

  if (path === '/api/persistent-windows' && method === 'GET') {
    try {
      const status = readPwStatus()
      // Whether the tray app is resident decides whether a click can do anything
      // at all (see isPwRunning), so the panel shows it rather than leaving Boss
      // to guess why a green tick changed nothing.
      const [sync, running] = await Promise.all([windowLayoutSyncInfo(), isPwRunning()])
      json(res, { ...status, running, sync })
    } catch (err) {
      logger.error({ err }, 'PersistentWindows status failed')
      json(res, { error: 'Status failed' }, 500)
    }
    return true
  }

  // Save: capture the desktop as it is now, then publish it. The push is the
  // second half of ONE user intent ("save my layout"), so it happens here rather
  // than being left as a second button nobody would remember to press. A capture
  // that worked is still reported as a success when the push fails -- the local
  // save is the part that protects the arrangement, and the panel shows which
  // half fell over.
  if (path === '/api/persistent-windows/capture' && method === 'POST') {
    try {
      await readBody(req)
      const captured = await runPwAction('capture')
      let pushed: { ok: boolean; error: string | null; capturedAt: number | null } = { ok: false, error: null, capturedAt: null }
      if (captured.ok) {
        try {
          const result = await pushWindowLayout()
          pushed = { ok: true, error: null, capturedAt: result.manifest.capturedAt }
        } catch (err) {
          pushed = { ok: false, error: String((err as Error).message ?? err), capturedAt: null }
          logger.warn({ err }, 'window-layout: capture succeeded but push failed')
        }
      }
      json(res, { ...actionResponse(captured), pushed })
    } catch (err) {
      logger.error({ err }, 'PersistentWindows capture failed')
      json(res, { error: 'Capture failed' }, 500)
    }
    return true
  }

  // Restore from what is already on THIS machine -- the everyday case (Boss
  // nudged a window, wants the arrangement back). No git involved, so it works
  // offline and cannot be affected by the state of the repo.
  if (path === '/api/persistent-windows/restore' && method === 'POST') {
    try {
      await readBody(req)
      json(res, actionResponse(await runPwAction('restore')))
    } catch (err) {
      logger.error({ err }, 'PersistentWindows restore failed')
      json(res, { error: 'Restore failed' }, 500)
    }
    return true
  }

  // Restore from GitHub -- the new-machine case: pull the backup, drop the DB in
  // place, then apply it.
  if (path === '/api/persistent-windows/restore-from-github' && method === 'POST') {
    try {
      await readBody(req)
      const result = await restoreWindowLayout()
      json(res, {
        ...actionResponse(result.action),
        copied: result.copied,
        manifest: result.manifest,
      })
    } catch (err) {
      const message = String((err as Error).message ?? err)
      logger.warn({ err }, 'window-layout: GitHub restore failed')
      json(res, { ok: false, error: message }, 400)
    }
    return true
  }

  // Publish whatever is already saved on disk, without capturing first. Used by
  // the daily schedule, where re-capturing would silently overwrite a deliberate
  // arrangement with whatever happened to be on screen at 03:30.
  if (path === '/api/persistent-windows/push' && method === 'POST') {
    try {
      await readBody(req)
      const result = await pushWindowLayout()
      json(res, { ok: true, pushed: result.pushed, manifest: result.manifest })
    } catch (err) {
      const message = String((err as Error).message ?? err)
      logger.warn({ err }, 'window-layout: push failed')
      json(res, { ok: false, error: message }, 400)
    }
    return true
  }

  return false
}
