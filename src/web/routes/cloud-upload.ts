// "UPLOAD TO THE CLOUD" FROM THE EXPLORER: GOOGLE DRIVE AND MEGA (#525).
//
// Two steps, like the Photos upload: PLAN (what would go up, what is already
// there) and RUN, which sends exactly the plan the owner has just seen, and
// only while it is fresh. The cloud folder is the one the owner picked in the
// dialog (TG 8500, "525B") -- it is never derived here.
//
// Browsing the cloud folders is done by the pages' own endpoints
// (/api/drive/list, /api/mega/list); this file only plans and sends.

import { randomBytes } from 'node:crypto'
import { json, readBody } from '../http-helpers.js'
import { logger } from '../../logger.js'
import { googleAccountNames } from './accounts.js'
import { getAccessToken, isSafeFolderId } from './drive-browser.js'
import { normalizeMegaPath, rcloneStatus, readMegaAccounts } from '../../mega.js'
import {
  driveBackend, isCloudKind, megaBackend, planCloudUpload, runCloudUpload,
  type CloudBackend, type CloudKind, type CloudPlan, type CloudRunResult, type DriveHttp,
} from '../../life-cloud-upload.js'
import type { RouteContext } from './types.js'

const PLAN_TTL_MS = 10 * 60 * 1000
interface KeptPlan { at: number; kind: CloudKind; account: string; folder: string; folderLabel: string; plan: CloudPlan }
const plans = new Map<string, KeptPlan>()

interface Job {
  kind: CloudKind; account: string; folderLabel: string
  running: boolean; startedAt: string; finishedAt: string | null
  total: number; done: number; current: string
  result: CloudRunResult | null; error: string | null
}
let job: Job | null = null
let stopAsked = false

const driveHttp: DriveHttp = async (u, init) => {
  const r = await fetch(u, { method: init.method, headers: init.headers, body: init.body as any, ...(init.duplex ? { duplex: init.duplex } : {}) } as RequestInit)
  return { ok: r.ok, status: r.status, text: () => r.text(), header: (n) => r.headers.get(n) }
}

/** The backend for one picked target; an error CODE when the target itself is not usable. */
async function backendFor(kind: CloudKind, account: string, folder: string): Promise<{ ok: true; backend: CloudBackend } | { ok: false; code: string; detail?: string }> {
  if (kind === 'drive') {
    if (!googleAccountNames().accounts.includes(account)) return { ok: false, code: 'no_account' }
    if (!isSafeFolderId(folder)) return { ok: false, code: 'bad_folder' }
    try {
      return { ok: true, backend: driveBackend(await getAccessToken(account), folder, driveHttp) }
    } catch (err: any) {
      return { ok: false, code: 'no_token', detail: String(err?.message || err).slice(0, 300) }
    }
  }
  if (!readMegaAccounts().some((a) => a.name === account)) return { ok: false, code: 'no_account' }
  const path = normalizeMegaPath(folder)
  if (path === null) return { ok: false, code: 'bad_folder' }
  return { ok: true, backend: megaBackend(account, path) }
}

export async function tryHandleCloudUpload(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx
  if (!path.startsWith('/api/cloud-upload/')) return false

  // Where can things go at all? A fresh install has no account: the dialog
  // says so and shows the way, instead of an empty list.
  if (path === '/api/cloud-upload/targets' && method === 'GET') {
    const g = googleAccountNames()
    json(res, {
      drive: { accounts: g.accounts, default: g.default },
      mega: { accounts: readMegaAccounts().map((a) => a.name), rclone: (await rcloneStatus()).installed },
    })
    return true
  }

  if (path === '/api/cloud-upload/plan' && method === 'POST') {
    const data = JSON.parse((await readBody(req)).toString('utf-8') || '{}')
    const kind = data.kind
    const account = String(data.account || '')
    const folder = typeof data.folder === 'string' ? data.folder : ''
    const folderLabel = String(data.folderLabel || '').slice(0, 500)
    const paths = Array.isArray(data.paths) ? data.paths.filter((x: unknown) => typeof x === 'string').slice(0, 200) : []
    if (!isCloudKind(kind)) { json(res, { error: 'bad_kind', code: 'bad_kind' }, 400); return true }
    if (!account) { json(res, { error: 'no_account', code: 'no_account' }, 400); return true }
    if (!paths.length) { json(res, { error: 'nothing_picked', code: 'nothing_picked' }, 400); return true }
    const b = await backendFor(kind, account, kind === 'drive' ? (folder || 'root') : folder)
    if (!b.ok) { json(res, { error: b.code, code: b.code, detail: b.detail ?? null }, b.code === 'no_token' ? 502 : 400); return true }
    const plan = await planCloudUpload(paths, b.backend)
    // "Could not look into the target" is not a plan: nothing may be sent on it.
    if (plan.blocked) { json(res, { error: 'target_unreadable', code: 'target_unreadable', detail: plan.blocked }, 502); return true }
    const id = randomBytes(8).toString('hex')
    for (const [k, v] of plans) if (Date.now() - v.at > PLAN_TTL_MS) plans.delete(k)
    plans.set(id, { at: Date.now(), kind, account, folder: kind === 'drive' ? (folder || 'root') : folder, folderLabel, plan })
    json(res, {
      ok: true, planId: id, files: plan.upload.length, bytes: plan.uploadBytes, exists: plan.exists, clash: plan.clash, badName: plan.badName,
      unreadable: plan.unreadable.slice(0, 20), unreadableCount: plan.unreadable.length, truncated: plan.truncated,
      sample: plan.upload.slice(0, 8).map((f) => [...f.dir, f.name].join('/')),
    })
    return true
  }

  if (path === '/api/cloud-upload/run' && method === 'POST') {
    const data = JSON.parse((await readBody(req)).toString('utf-8') || '{}')
    if (job?.running) { json(res, { error: 'busy', code: 'busy', job }, 409); return true }
    const kept = plans.get(String(data.planId || ''))
    if (!kept || Date.now() - kept.at > PLAN_TTL_MS) { json(res, { error: 'no_plan', code: 'no_plan' }, 409); return true }
    plans.delete(String(data.planId))
    if (!kept.plan.upload.length) { json(res, { error: 'nothing_to_send', code: 'nothing_to_send' }, 409); return true }
    const mine: Job = {
      kind: kept.kind, account: kept.account, folderLabel: kept.folderLabel,
      running: true, startedAt: new Date().toISOString(), finishedAt: null,
      total: kept.plan.upload.length, done: 0, current: '', result: null, error: null,
    }
    job = mine
    stopAsked = false
    void (async () => {
      try {
        const b = await backendFor(kept.kind, kept.account, kept.folder)
        if (!b.ok) throw new Error(b.detail ? `${b.code}: ${b.detail}` : b.code)
        mine.result = await runCloudUpload(kept.plan, b.backend, {
          onProgress: (done, _total, current) => { mine.done = done; mine.current = current },
          shouldStop: () => stopAsked,
        })
      } catch (err: any) {
        mine.error = String(err?.message || err).slice(0, 400)
        logger.warn({ err: mine.error, kind: kept.kind, account: kept.account }, '[cloud-upload] the run failed')
      } finally {
        mine.running = false
        mine.finishedAt = new Date().toISOString()
        mine.current = ''
      }
    })()
    json(res, { ok: true, job: mine })
    return true
  }

  if (path === '/api/cloud-upload/status' && method === 'GET') {
    json(res, { job })
    return true
  }

  if (path === '/api/cloud-upload/stop' && method === 'POST') {
    if (job?.running) stopAsked = true
    json(res, { ok: true, job })
    return true
  }

  return false
}
