// Kanban aa55180c (2026-08-10): Google Drive fajlbongeszo panel a dashboardon.
// A tenyleges Google-auth (OAuth, tobb-fiokos token-tarolas, auto-refresh) mar
// megvan a scripts/google-auth.py "token" parancsaban -- ez a route csak azt
// az access_token-t hasznalja fel a Drive REST API-hoz kozvetlenul (Node 22
// global fetch), kulon Python-szkript nelkul. A "drive" scope (olvasas+iras)
// mar bekotve google-auth.py SCOPES-ban, ujra-authentikacio nem kell.
//
// Torles = trash (Drive kosarba), SOHA nem permanens delete -- ez a vedelem a
// "mai tipusu veletlen torles" ellen amit a kartya leirasa emlit.
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../../config.js'
import { readBody, json } from '../http-helpers.js'
import { parseMultipart } from '../multipart.js'
import { logger } from '../../logger.js'
import { googleAccountNames } from './accounts.js'
import type { RouteContext } from './types.js'

const DRIVE_FILES_URL = 'https://www.googleapis.com/drive/v3/files'
const UPLOAD_MAX_BYTES = 15 * 1024 * 1024

function getAccessToken(account?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = [join(PROJECT_ROOT, 'scripts', 'google-auth.py'), 'token']
    if (account) args.push(account)
    execFile('python3', args, { timeout: 15_000 }, (err, stdout, stderr) => {
      if (err || !stdout.trim()) {
        reject(new Error((stderr || err?.message || 'nincs access_token').trim().slice(0, 200)))
        return
      }
      resolve(stdout.trim())
    })
  })
}

async function driveFetch(url: string, token: string, init: RequestInit = {}): Promise<Response> {
  const r = await fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.headers || {}) } })
  return r
}

async function driveJson(url: string, token: string, init: RequestInit = {}): Promise<any> {
  const r = await driveFetch(url, token, init)
  const text = await r.text()
  if (!r.ok) throw new Error(`Drive API ${r.status}: ${text.slice(0, 200)}`)
  return text ? JSON.parse(text) : {}
}

function accountFromQuery(url: URL): string | undefined {
  return url.searchParams.get('account') || undefined
}

export async function tryHandleDriveBrowser(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx

  if (path === '/api/drive/accounts' && method === 'GET') {
    json(res, googleAccountNames())
    return true
  }

  if (path === '/api/drive/list' && method === 'GET') {
    const folderId = url.searchParams.get('folderId') || 'root'
    try {
      const token = await getAccessToken(accountFromQuery(url))
      const q = encodeURIComponent(`'${folderId}' in parents and trashed = false`)
      const fields = encodeURIComponent('files(id,name,mimeType,size,modifiedTime,iconLink,webViewLink)')
      const data = await driveJson(`${DRIVE_FILES_URL}?q=${q}&fields=${fields}&orderBy=folder,name&pageSize=200`, token)
      const files = (data.files || []).map((f: any) => ({
        id: f.id,
        name: f.name,
        isFolder: f.mimeType === 'application/vnd.google-apps.folder',
        mimeType: f.mimeType,
        size: f.size ? Number(f.size) : null,
        modifiedTime: f.modifiedTime || null,
        webViewLink: f.webViewLink || null,
      }))
      json(res, { files })
    } catch (err: any) {
      logger.warn({ err: err.message, folderId }, '[drive-browser] list failed')
      json(res, { error: err.message }, 502)
    }
    return true
  }

  if (path === '/api/drive/mkdir' && method === 'POST') {
    const data = JSON.parse((await readBody(req)).toString('utf-8') || '{}')
    const name = String(data.name || '').trim()
    const parentId = String(data.parentId || 'root')
    if (!name) { json(res, { error: 'name kotelezo' }, 400); return true }
    try {
      const token = await getAccessToken(data.account)
      const created = await driveJson(DRIVE_FILES_URL, token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] }),
      })
      json(res, { id: created.id, name: created.name })
    } catch (err: any) {
      logger.warn({ err: err.message }, '[drive-browser] mkdir failed')
      json(res, { error: err.message }, 502)
    }
    return true
  }

  if (path === '/api/drive/rename' && method === 'POST') {
    const data = JSON.parse((await readBody(req)).toString('utf-8') || '{}')
    const fileId = String(data.fileId || '')
    const name = String(data.name || '').trim()
    if (!fileId || !name) { json(res, { error: 'fileId es name kotelezo' }, 400); return true }
    try {
      const token = await getAccessToken(data.account)
      const updated = await driveJson(`${DRIVE_FILES_URL}/${encodeURIComponent(fileId)}`, token, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      json(res, { id: updated.id, name: updated.name })
    } catch (err: any) {
      logger.warn({ err: err.message }, '[drive-browser] rename failed')
      json(res, { error: err.message }, 502)
    }
    return true
  }

  if (path === '/api/drive/move' && method === 'POST') {
    const data = JSON.parse((await readBody(req)).toString('utf-8') || '{}')
    const fileId = String(data.fileId || '')
    const newParentId = String(data.newParentId || '')
    if (!fileId || !newParentId) { json(res, { error: 'fileId es newParentId kotelezo' }, 400); return true }
    try {
      const token = await getAccessToken(data.account)
      const current = await driveJson(`${DRIVE_FILES_URL}/${encodeURIComponent(fileId)}?fields=parents`, token)
      const oldParents = (current.parents || []).join(',')
      const updated = await driveJson(
        `${DRIVE_FILES_URL}/${encodeURIComponent(fileId)}?addParents=${encodeURIComponent(newParentId)}&removeParents=${encodeURIComponent(oldParents)}&fields=id,name,parents`,
        token,
        { method: 'PATCH' },
      )
      json(res, { id: updated.id, name: updated.name })
    } catch (err: any) {
      logger.warn({ err: err.message }, '[drive-browser] move failed')
      json(res, { error: err.message }, 502)
    }
    return true
  }

  // Kosarba (trash), NEM vegleges torles -- Boss visszaallithatja a Drive
  // weben, ha veletlen volt.
  if (path === '/api/drive/trash' && method === 'POST') {
    const data = JSON.parse((await readBody(req)).toString('utf-8') || '{}')
    const fileId = String(data.fileId || '')
    if (!fileId) { json(res, { error: 'fileId kotelezo' }, 400); return true }
    try {
      const token = await getAccessToken(data.account)
      await driveJson(`${DRIVE_FILES_URL}/${encodeURIComponent(fileId)}`, token, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trashed: true }),
      })
      json(res, { ok: true })
    } catch (err: any) {
      logger.warn({ err: err.message }, '[drive-browser] trash failed')
      json(res, { error: err.message }, 502)
    }
    return true
  }

  if (path === '/api/drive/upload' && method === 'POST') {
    const body = await readBody(req, { maxBytes: UPLOAD_MAX_BYTES })
    const contentType = req.headers['content-type'] || ''
    if (!contentType.includes('multipart/form-data')) { json(res, { error: 'multipart/form-data kell' }, 400); return true }
    const { file, fields } = parseMultipart(body, contentType)
    if (!file) { json(res, { error: 'nincs fajl' }, 400); return true }
    const parentId = fields.parentId || 'root'
    try {
      const token = await getAccessToken(fields.account)
      const boundary = `marveen-${Date.now()}`
      const metadata = JSON.stringify({ name: file.name, parents: [parentId] })
      const multipartBody = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`),
        Buffer.from(`--${boundary}\r\nContent-Type: ${file.mime}\r\n\r\n`),
        file.data,
        Buffer.from(`\r\n--${boundary}--`),
      ])
      const uploaded = await driveJson('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name', token, {
        method: 'POST',
        headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
        body: multipartBody,
      })
      json(res, { id: uploaded.id, name: uploaded.name })
    } catch (err: any) {
      logger.warn({ err: err.message }, '[drive-browser] upload failed')
      json(res, { error: err.message }, 502)
    }
    return true
  }

  if (path === '/api/drive/download' && method === 'GET') {
    const fileId = url.searchParams.get('fileId') || ''
    const name = url.searchParams.get('name') || 'download'
    if (!fileId) { json(res, { error: 'fileId kotelezo' }, 400); return true }
    try {
      const token = await getAccessToken(accountFromQuery(url))
      const upstream = await driveFetch(`${DRIVE_FILES_URL}/${encodeURIComponent(fileId)}?alt=media`, token)
      if (!upstream.ok || !upstream.body) {
        const text = await upstream.text()
        json(res, { error: `Drive API ${upstream.status}: ${text.slice(0, 200)}` }, 502)
        return true
      }
      res.writeHead(200, {
        'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${name.replace(/"/g, '')}"`,
        'Cache-Control': 'private, no-store',
      })
      const reader = upstream.body.getReader()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        res.write(value)
      }
      res.end()
    } catch (err: any) {
      logger.warn({ err: err.message }, '[drive-browser] download failed')
      if (!res.headersSent) json(res, { error: err.message }, 502)
      else res.end()
    }
    return true
  }

  return false
}
