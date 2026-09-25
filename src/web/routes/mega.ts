// MEGA fiokok vegpontjai (kartya e67bf278).
//
//   GET  /api/mega           -- rclone allapot + fiokok + utolso tarhely-meres
//   POST /api/mega/accounts  -- uj fiok {email, password}; csak sikeres belepes utan marad meg
//   POST /api/mega/remove    -- fiok levetele {name}; a fajlokhoz NEM nyul
//   POST /api/mega/measure   -- tarhely-meres MOST {name}
//   POST /api/mega/rclone-install -- az rclone letoltese ~/.local/bin ala (friss telepitesen a feluletrol, #360)
//
// A jelszo sose megy vissza a bongeszonek, es a naploba sem kerul.
import { json, readBody } from '../http-helpers.js'
import { logger } from '../../logger.js'
import {
  rcloneStatus, readMegaAccounts, readMegaQuota, addMegaAccount, removeMegaAccount, measureMegaQuota,
} from '../../mega.js'
import { installRclone } from '../../rclone-install.js'
import type { RouteContext } from './types.js'

async function readJson(req: RouteContext['req']): Promise<any> {
  try {
    const text = (await readBody(req)).toString('utf-8').trim()
    return text ? JSON.parse(text) : null
  } catch {
    return null
  }
}

/** Ennyi utan a tarhely-meres elavult: a Fiokok oldal megnyitasa ujramer. */
const QUOTA_STALE_MS = 6 * 60 * 60 * 1000
const measuring = new Set<string>()
/** Egyszerre egy rclone-telepites: ket gyors kattintas ne toltson le ketszer. */
let installing = false

/**
 * Az elavult meresek frissitese a HATTERBEN -- az oldal nem var ra. Egy
 * fiokot egyszerre csak egyszer merunk (ket gyors frissites ne inditson ket
 * rclone-t ugyanarra).
 */
function refreshStale(now = Date.now()): void {
  const quota = readMegaQuota()
  for (const a of readMegaAccounts()) {
    const q = quota[a.name]
    if ((q && now - q.measuredAt < QUOTA_STALE_MS) || measuring.has(a.name)) continue
    measuring.add(a.name)
    measureMegaQuota(a.name)
      .catch((e) => logger.warn({ account: a.name, err: String(e) }, '[mega] tarhely-meres nem sikerult'))
      .finally(() => measuring.delete(a.name))
  }
}

async function state() {
  const quota = readMegaQuota()
  return {
    rclone: await rcloneStatus(),
    accounts: readMegaAccounts().map((a) => ({ name: a.name, email: a.email, addedAt: a.addedAt, quota: quota[a.name] ?? null })),
  }
}

export async function tryHandleMega(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx
  if (path !== '/api/mega' && !path.startsWith('/api/mega/')) return false

  if (path === '/api/mega' && method === 'GET') {
    refreshStale()
    json(res, await state())
    return true
  }

  if (path === '/api/mega/accounts' && method === 'POST') {
    const b = await readJson(req)
    const r = await addMegaAccount({ email: String(b?.email || ''), password: String(b?.password || '') })
    if (!r.ok) {
      logger.warn({ error: r.error, detail: r.detail }, '[mega] fiok felvetele nem sikerult')
      json(res, { error: r.error, detail: r.detail ?? null }, r.error === 'rclone_missing' ? 409 : 400)
      return true
    }
    logger.info({ account: r.account.name }, '[mega] fiok bekotve')
    json(res, { ok: true, ...(await state()) })
    return true
  }

  if (path === '/api/mega/remove' && method === 'POST') {
    const b = await readJson(req)
    const name = String(b?.name || '').trim()
    if (!name || !removeMegaAccount(name)) { json(res, { error: 'not_found' }, 404); return true }
    logger.info({ account: name }, '[mega] fiok levetelve (a fajlok maradtak)')
    json(res, { ok: true, ...(await state()) })
    return true
  }

  if (path === '/api/mega/rclone-install' && method === 'POST') {
    if (installing) { json(res, { error: 'busy' }, 409); return true }
    installing = true
    try {
      const r = await installRclone()
      if (!r.ok) {
        logger.warn({ code: r.code, detail: r.detail }, '[mega] rclone telepitese nem sikerult')
        json(res, { error: r.code, detail: r.detail }, 502)
        return true
      }
      logger.info({ version: r.version, path: r.path }, '[mega] rclone telepitve a feluletrol')
      json(res, { ok: true, version: r.version, ...(await state()) })
    } finally {
      installing = false
    }
    return true
  }

  if (path === '/api/mega/measure' && method === 'POST') {
    const b = await readJson(req)
    const name = String(b?.name || '').trim()
    const q = name ? await measureMegaQuota(name) : null
    if (!q) { json(res, { error: 'not_found' }, 404); return true }
    json(res, { ok: true, quota: q, ...(await state()) })
    return true
  }

  return false
}
