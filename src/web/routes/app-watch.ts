// APP-OLDAL FIGYELO vegpontjai (#764). A logika az `app-page-watch.ts`-ben van.
//
//   GET  /api/app-watch        -- a figyelt oldalak + az utolso meres oldalankent
//   POST /api/app-watch/add    -- uj oldal ({ url, label })
//   POST /api/app-watch/remove -- oldal levetele ({ id })
//   POST /api/app-watch/check  -- meres MOST (a felulet gombja); a "nott" ertesites ilyenkor is megy
import { randomUUID } from 'crypto'
import { json, readBody, reqLang, L } from '../http-helpers.js'
import {
  readWatchFile, writeWatchFile, validateWatchUrl, runWatch, describeReading, hostKind,
  type WatchKind,
} from '../../app-page-watch.js'
import { sendMarveenAlert } from '../telegram.js'
import type { RouteContext } from './types.js'

async function readJson(req: RouteContext['req']): Promise<any> {
  try {
    const text = (await readBody(req)).toString('utf-8').trim()
    return text ? JSON.parse(text) : null
  } catch {
    return null
  }
}

function view(lang: 'hu' | 'en') {
  const f = readWatchFile()
  return f.pages.map((p) => {
    const st = f.state[p.id]
    let kind: WatchKind = 'play'
    try { kind = hostKind(new URL(p.url).hostname) || 'play' } catch { /* a regi/serult cim */ }
    return {
      id: p.id, label: p.label, url: p.url, kind,
      value: st?.value ?? null,
      band: st?.band || '',
      checkedAt: st?.checkedAt || '',
      changedAt: st?.changedAt || '',
      error: st?.error || '',
      text: describeReading(kind, st?.value ?? null, st?.band || '', lang),
    }
  })
}

export async function tryHandleAppWatch(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx
  if (!path.startsWith('/api/app-watch')) return false
  const lang = reqLang(req, ctx.url)

  if (path === '/api/app-watch' && method === 'GET') {
    json(res, { pages: view(lang) })
    return true
  }

  if (path === '/api/app-watch/add' && method === 'POST') {
    const b = await readJson(req)
    const v = validateWatchUrl(String(b?.url || ''))
    if (!v.ok) { json(res, { error: L(lang, v.hu, v.en) }, 400); return true }
    const f = readWatchFile()
    if (f.pages.some((p) => p.url === v.url)) {
      json(res, { error: L(lang, 'Ez az oldal már a listán van.', 'This page is already on the list.') }, 409)
      return true
    }
    const label = String(b?.label || '').trim().slice(0, 80)
    f.pages.push({ id: randomUUID().slice(0, 8), label: label || new URL(v.url).hostname, url: v.url })
    writeWatchFile(f)
    json(res, { ok: true, pages: view(lang) })
    return true
  }

  if (path === '/api/app-watch/remove' && method === 'POST') {
    const b = await readJson(req)
    const id = String(b?.id || '')
    const f = readWatchFile()
    if (!f.pages.some((p) => p.id === id)) { json(res, { error: L(lang, 'Ilyen figyelt oldal nincs.', 'There is no such watched page.') }, 404); return true }
    f.pages = f.pages.filter((p) => p.id !== id)
    delete f.state[id]
    writeWatchFile(f)
    json(res, { ok: true, pages: view(lang) })
    return true
  }

  if (path === '/api/app-watch/check' && method === 'POST') {
    if (!readWatchFile().pages.length) {
      json(res, { error: L(lang, 'Még nincs figyelt oldal. Add meg az első oldal címét.', 'There is no watched page yet. Add the first page address.') }, 400)
      return true
    }
    const results = await runWatch({ notify: sendMarveenAlert, lang })
    json(res, { ok: true, results, pages: view(lang) })
    return true
  }

  return false
}
