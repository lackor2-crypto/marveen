// MEGA fiokok vegpontjai (kartya e67bf278).
//
//   GET  /api/mega           -- rclone allapot + fiokok + utolso tarhely-meres
//   POST /api/mega/accounts  -- uj fiok {email, password}; csak sikeres belepes utan marad meg
//   POST /api/mega/remove    -- fiok levetele {name}; a fajlokhoz NEM nyul
//   POST /api/mega/measure   -- tarhely-meres MOST {name}
//   POST /api/mega/rclone-install -- az rclone letoltese ~/.local/bin ala (friss telepitesen a feluletrol, #360)
//   GET  /api/mega/list?name=&path= -- egy mappa tartalma a fiokon (#398), csak olvas
//   POST /api/mega/mkdir   {name, parent, folder}  -- uj mappa (#424)
//   POST /api/mega/rename  {name, path, newName}   -- atnevezes, sose ir felul (#424)
//   POST /api/mega/move    {name, path, target}    -- athelyezes a fiokon belul (#424)
//   POST /api/mega/trash   {name, path}            -- a MEGA KUKAJABA, visszaallithato (#424)
//   POST /api/mega/upload  multipart: name, dir, file (max 15 MB) (#424)
//   GET  /api/mega/download?name=&path= -- egy fajl letoltese folyamkent (#424)
//
// A jelszo sose megy vissza a bongeszonek, es a naploba sem kerul.
import { spawn } from 'node:child_process'
import { json, readBody } from '../http-helpers.js'
import { logger } from '../../logger.js'
import {
  rcloneStatus, readMegaAccounts, readMegaQuota, addMegaAccount, removeMegaAccount, measureMegaQuota, listMegaDir,
  megaMkdir, megaRename, megaMove, megaTrash, megaUpload, megaDownloadCommand, type MegaOpResult,
} from '../../mega.js'
import { parseMultipart } from '../multipart.js'
import { contentDispositionHeader } from './drive-browser.js'
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

/** Feltoltes felso merete -- ugyanannyi, mint a Drive oldalon. */
const MEGA_UPLOAD_MAX_BYTES = 15 * 1024 * 1024

/**
 * Hibakod -> HTTP statusz. A bongeszo a KODBOL mond mondatot (HU/EN), a
 * statusz csak azt jelzi, a mi oldalunkon vagy a MEGA-n mult-e.
 */
export function megaErrorStatus(error: string): number {
  if (error === 'not_found' || error === 'dir_not_found') return 404
  if (error === 'exists' || error === 'rclone_missing') return 409
  if (['bad_path', 'bad_name', 'root_protected', 'move_into_self', 'target_not_dir', 'is_dir', 'no_file', 'not_multipart'].includes(error)) return 400
  if (error === 'too_large') return 413
  if (error === 'timeout') return 504
  return 502
}

function sendOp(res: RouteContext['res'], op: string, account: string, r: MegaOpResult): void {
  if (r.ok) {
    logger.info({ account, op, path: r.path }, '[mega] muvelet kesz')
    json(res, { ok: true, path: r.path })
    return
  }
  const status = megaErrorStatus(r.error)
  if (status >= 500) logger.warn({ account, op, error: r.error, detail: r.detail }, '[mega] muvelet nem sikerult')
  json(res, { error: r.error, detail: r.detail ?? null }, status)
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

  if (path === '/api/mega/list' && method === 'GET') {
    const name = String(ctx.url.searchParams.get('name') || '').trim()
    const r = await listMegaDir(name, ctx.url.searchParams.get('path') ?? '')
    if (!r.ok) {
      // Minden hiba KULON kodot kap -- a bongeszo ebbol mondja ki, hogy "nem
      // lattam oda", es nem mutat ures mappat helyette.
      const status = r.error === 'not_found' || r.error === 'dir_not_found' ? 404
        : r.error === 'bad_path' ? 400
        : r.error === 'rclone_missing' ? 409
        : r.error === 'timeout' ? 504
        : 502
      if (status >= 500) logger.warn({ account: name, error: r.error, detail: r.detail }, '[mega] listazas nem sikerult')
      json(res, { error: r.error, detail: r.detail ?? null }, status)
      return true
    }
    json(res, { ok: true, path: r.path, items: r.items })
    return true
  }

  if (method === 'POST' && ['/api/mega/mkdir', '/api/mega/rename', '/api/mega/move', '/api/mega/trash'].includes(path)) {
    const b = await readJson(req)
    const name = String(b?.name || '').trim()
    const op = path.slice('/api/mega/'.length)
    const r = op === 'mkdir' ? await megaMkdir(name, b?.parent ?? '', b?.folder)
      : op === 'rename' ? await megaRename(name, b?.path, b?.newName)
      : op === 'move' ? await megaMove(name, b?.path, b?.target ?? '')
      : await megaTrash(name, b?.path)
    sendOp(res, op, name, r)
    return true
  }

  if (path === '/api/mega/upload' && method === 'POST') {
    const contentType = String(req.headers['content-type'] || '')
    if (!contentType.includes('multipart/form-data')) { json(res, { error: 'not_multipart' }, 400); return true }
    let body: Buffer
    try {
      body = await readBody(req, { maxBytes: MEGA_UPLOAD_MAX_BYTES })
    } catch {
      json(res, { error: 'too_large', maxBytes: MEGA_UPLOAD_MAX_BYTES }, 413)
      return true
    }
    const { file, fields } = parseMultipart(body, contentType)
    if (!file) { json(res, { error: 'no_file' }, 400); return true }
    const name = String(fields.name || '').trim()
    sendOp(res, 'upload', name, await megaUpload(name, fields.dir ?? '', file.name, file.data))
    return true
  }

  if (path === '/api/mega/download' && method === 'GET') {
    const name = String(ctx.url.searchParams.get('name') || '').trim()
    const cmd = await megaDownloadCommand(name, ctx.url.searchParams.get('path') ?? '')
    if (!cmd.ok) { json(res, { error: cmd.error, detail: cmd.detail ?? null }, megaErrorStatus(cmd.error)); return true }
    const child = spawn(cmd.bin, cmd.args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (c: Buffer) => { if (stderr.length < 2000) stderr += c.toString('utf-8') })
    // Az elso darab elott meg kimondhatjuk a hibat JSON-ban; utana mar
    // csak a kapcsolat megszakitasa marad.
    let started = false
    child.stdout.on('data', (c: Buffer) => {
      if (!started) {
        started = true
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': contentDispositionHeader(cmd.fileName),
          'Cache-Control': 'private, no-store',
        })
      }
      // Visszanyomas: a lassu bongeszo miatt ne gyuljon a fajl a memoriaban.
      if (!res.write(c)) { child.stdout.pause(); res.once('drain', () => child.stdout.resume()) }
    })
    res.on('close', () => { if (child.exitCode === null) child.kill('SIGTERM') })
    child.on('error', (e) => { if (!started) json(res, { error: 'rclone_missing', detail: String(e) }, 409); else res.end() })
    child.on('close', (code) => {
      if (code === 0) {
        if (!started) {
          // Ures fajl: nem jott darab, de a letoltes attol meg sikeres.
          res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': contentDispositionHeader(cmd.fileName), 'Cache-Control': 'private, no-store' })
        }
        res.end()
        return
      }
      logger.warn({ account: name, code, stderr: stderr.slice(0, 300) }, '[mega] letoltes nem sikerult')
      if (!started) json(res, { error: 'rclone_error', detail: stderr.slice(0, 300) }, 502)
      else res.destroy()
    })
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
