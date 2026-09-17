// Kartya #165 (31f3e26f): a bongeszo-kepesseg vegpontjai. Minden muvelet kulon
// nevu vegpont (/api/browser/navigate, /click, ...), a veszelyes pedig kulon
// nevet kap (/submit), hogy kulon lehessen engedelyezni.
import { readBody, json } from '../http-helpers.js'
import {
  getBrowserStatus, setBrowserEnabled, startChromiumInstall, stopBrowser,
  runBrowserAction, deleteBrowserSession, BrowserError, BROWSER_ACTIONS,
} from '../browser-service.js'
import type { RouteContext } from './types.js'

async function readJson(req: RouteContext['req']): Promise<any> {
  const raw = (await readBody(req, { maxBytes: 1024 * 1024 })).toString()
  if (!raw.trim()) return {}
  return JSON.parse(raw)
}

export async function tryHandleBrowser(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx
  if (!path.startsWith('/api/browser')) return false

  try {
    if (path === '/api/browser/status' && method === 'GET') {
      json(res, await getBrowserStatus())
      return true
    }
    if (path === '/api/browser/enabled' && method === 'POST') {
      const body = await readJson(req)
      await setBrowserEnabled(body.enabled === true)
      json(res, { ok: true, enabled: body.enabled === true })
      return true
    }
    if (path === '/api/browser/install' && method === 'POST') {
      json(res, { ok: true, install: startChromiumInstall() })
      return true
    }
    if (path === '/api/browser/stop' && method === 'POST') {
      await stopBrowser()
      json(res, { ok: true })
      return true
    }
    const sessionDel = path.match(/^\/api\/browser\/sessions\/([^/]+)$/)
    if (sessionDel && method === 'DELETE') {
      const ok = deleteBrowserSession(decodeURIComponent(sessionDel[1]))
      json(res, { ok }, ok ? 200 : 404)
      return true
    }
    const act = path.match(/^\/api\/browser\/([a-z_]+)$/)
    if (act && method === 'POST' && (BROWSER_ACTIONS as readonly string[]).includes(act[1])) {
      const body = await readJson(req)
      json(res, await runBrowserAction({ ...body, action: act[1] }))
      return true
    }
  } catch (err: any) {
    if (err instanceof BrowserError) {
      json(res, { ok: false, error: err.message, code: err.code }, err.status)
      return true
    }
    if (err instanceof SyntaxError) {
      json(res, { ok: false, error: 'invalid JSON body', code: 'bad_json' }, 400)
      return true
    }
    throw err
  }
  return false
}
