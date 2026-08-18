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
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
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

// A Google sajat formatumainak (Docs/Sheets/Slides) NINCS letoltheto bajtjuk:
// az alt=media 403-mal valaszol ("Only files with binary content can be
// downloaded"). Ezek csak /export-tal jonnek le, egy celformatumot megadva --
// es ez a Drive-ok tobbsegeben a tartalom java resze.
const GOOGLE_EXPORT: Record<string, { mime: string; ext: string }> = {
  'application/vnd.google-apps.document': { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ext: 'docx' },
  'application/vnd.google-apps.spreadsheet': { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: 'xlsx' },
  'application/vnd.google-apps.presentation': { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', ext: 'pptx' },
  'application/vnd.google-apps.drawing': { mime: 'image/png', ext: 'png' },
  'application/vnd.google-apps.script': { mime: 'application/vnd.google-apps.script+json', ext: 'json' },
}

/**
 * A Fotok-nezet ugyanezt a listat kéri, csak keprem: mappak (hogy tovabb lehessen
 * lepni) + kep/video fajlok. A szures a Drive-nal tortenik, nem nalunk: egy
 * 5000 fajlos mappabol nem akarunk 4900 dokumentumot athozni azert, hogy aztan
 * eldobjuk.
 */
export function driveListQuery(folderId: string, mediaOnly: boolean): string {
  // MASODIK ZAR. A vegpont mar ellenorzi az azonositot, de a lekerdezes-szoveg
  // itt all ossze, es aki ide beir egy uj hivast, az konnyen kifelejti a kaput.
  // Ezert a kifejezes epitese SAJAT MAGA utasitja vissza a gyanus azonositot:
  // igy nem letezik olyan ut a kodban, ahol ellenorizetlen szoveg kerul a
  // `'<id>' in parents` kifejezesbe. Lasd isSafeFolderId().
  if (!isSafeFolderId(folderId)) throw new Error('ervenytelen folderId')
  const base = `'${folderId}' in parents and trashed = false`
  if (!mediaOnly) return base
  return `${base} and (mimeType contains 'image/' or mimeType contains 'video/' or mimeType = 'application/vnd.google-apps.folder')`
}

/**
 * A thumbnailLink egy MAR ALAIRT Google-URL, `=s220` meretjelolessel a vegen.
 * Nagyobb bélyegkephez (lightbox) csak ezt a szamot kell atirni -- ujra kerni a
 * fajlt teljes meretben egy racs 60 kepenel tobb tiz megabajt lenne.
 */
export function thumbnailUrlWithSize(link: string, size: number): string {
  const clean = String(link || '')
  if (/=[swh]\d+(-[^/]*)?$/i.test(clean)) return clean.replace(/=[swh]\d+(-[^/]*)?$/i, `=s${size}`)
  return `${clean}=s${size}`
}

/**
 * A thumbnailLink-et a Drive API adja, de akkor is ELLENORIZZUK, mielott a
 * szerver lekeri: egy proxy, ami barmilyen URL-t elhoz, az SSRF (a szerver a
 * belso halon van). Csak Google-tarhelyrol toltunk le, csak https-en.
 */
export function isAllowedThumbnailUrl(u: string): boolean {
  try {
    const parsed = new URL(u)
    if (parsed.protocol !== 'https:') return false
    return /(^|\.)(googleusercontent\.com|googleapis\.com)$/.test(parsed.hostname)
  } catch {
    return false
  }
}

/**
 * 64..2048 pixel: a racs 400-at ker, a lightbox 1600-at.
 *
 * A hianyzo parametert KULON kell elkapni: `Number(null)` es `Number('')`
 * egyarant 0 -- veges szam --, tehat a savra vagas 64-et adna, es egy regi
 * kliens (vagy egy kezzel hivott URL) 64 pixeles, hasznalhatatlanul elmosodott
 * kepet kapna hibauzenet nelkul.
 */
export function clampThumbSize(raw: string | null): number {
  const s = String(raw ?? '').trim()
  if (!s) return 400
  const n = Number(s)
  if (!Number.isFinite(n)) return 400
  return Math.min(2048, Math.max(64, Math.round(n)))
}

export interface DriveDownloadPlan {
  url: string
  filename: string
  /** Nem letoltheto Google-tipus (mappa, urlap, site) -- a hivo 400-zal all meg. */
  unsupported?: string
}

/**
 * Vissza tud-e menni a lehozott export ugyanabba a Google-fajlba? Ha igen,
 * EZZEL a content-type-pal kell felkuldeni -- a Drive ilyenkor visszakonvertalja,
 * es a fajl marad Google Doc/Sheet/Slide (nem lesz belole Word-fajl).
 *
 * MERVE az eles Drive-on (2026-08-15), nem a dokumentaciobol:
 *   - Doc <- .docx  PATCH uploadType=media, Content-Type: ...wordprocessingml:
 *     a valasz mimeType-ja tovabbra is `...google-apps.document`, a tartalom
 *     lecserelodott. Ugyanez all a Sheets/Slides parjara.
 *   - Rajz <- .png ugyanezzel a hivassal `400 Bad Request` -- a Google nem
 *     konvertal kepet vissza rajzza. Az Apps Script projekt sem: az a Script
 *     API-hoz tartozik, nem a Drive-hoz.
 * Ezert a rajz es a script `null`: azoknal a helyi szerkesztes NEM mehet fel.
 */
export function driveUploadMime(mimeType: string | null | undefined): string | null {
  if (!mimeType || !mimeType.startsWith('application/vnd.google-apps.')) return null
  const target = GOOGLE_EXPORT[mimeType]
  if (!target) return null
  return target.ext === 'docx' || target.ext === 'xlsx' || target.ext === 'pptx' ? target.mime : null
}

/**
 * Melyik Drive-vegpont adja vissza EZT a fajlt, es milyen nevvel mentjuk.
 *
 * Tiszta fuggveny, hogy a "Docs != bajtok" szabaly kulon tesztelheto legyen:
 * mimeType nelkul (regi kliens, kozvetlen API-hivas) a viselkedes valtozatlan
 * marad -- alt=media --, tehat ez a bovites nem tud regressziot okozni.
 */
export function driveDownloadPlan(fileId: string, mimeType: string | null | undefined, name: string): DriveDownloadPlan {
  const base = `${DRIVE_FILES_URL}/${encodeURIComponent(fileId)}`
  if (mimeType && mimeType.startsWith('application/vnd.google-apps.')) {
    const target = GOOGLE_EXPORT[mimeType]
    if (!target) return { url: '', filename: name, unsupported: mimeType }
    // A Docs-fajlneveken nincs kiterjesztes ("Szerzodes"), a lemezen viszont
    // kiterjesztes nelkul senki nem tudja megnyitni.
    const hasExt = name.toLowerCase().endsWith(`.${target.ext}`)
    return {
      url: `${base}/export?mimeType=${encodeURIComponent(target.mime)}`,
      filename: hasExt ? name : `${name}.${target.ext}`,
    }
  }
  return { url: `${base}?alt=media`, filename: name }
}

/**
 * Content-Disposition ekezetes fajlnevekhez.
 *
 * A HTTP-fejlec latin-1: a "Szerzodes-2026-marcius.pdf" ekezetei a sima
 * filename="..." mezoben elromlanak (vagy a Node dobja el a fejlecet), ezert
 * kell melle az RFC 5987-es filename*=UTF-8''... valtozat. A vezerlokarakterek
 * es idezojelek kiszurese egyben fejlec-injekcio elleni vedelem is: egy Drive-
 * fajlnev tetszoleges szoveg, nem a mi adatunk.
 */
export function contentDispositionHeader(name: string, disposition: string = 'attachment'): string {
  const clean = (name || '').replace(/[\u0000-\u001f\u007f"\\]/g, '').trim() || 'download'
  const ascii = clean.replace(/[^\x20-\x7e]/g, '_')
  // encodeURIComponent meghagyja a !'()* karaktereket, azok viszont nem
  // attr-char-ok az RFC 5987 szerint.
  const utf8 = encodeURIComponent(clean).replace(/['()!*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${utf8}`
}

/**
 * Beilleszthető-e a mappa-azonosito a Drive lekerdezo-kifejezesebe?
 *
 * A `folderId` a query stringbol jon, es a `'<id>' in parents` kifejezesbe
 * SZOVEGKENT kerul bele. Az encodeURIComponent csak az URL-t vedi, a kifejezest
 * nem: egy aposztrof ("x' in parents or 'y") atirja magat a lekerdezest. A
 * Drive-azonosito valojaban betu/szam/_/- (es a 'root'), ezert ami ezen kivul
 * esik, azt vissza is utasitjuk -- nem szurjuk ki, hanem elutasitjuk, mert egy
 * megcsonkitott azonosito amugy is rossz mappat nyitna.
 */
export function isSafeFolderId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,256}$/.test(String(id || ''))
}

export async function tryHandleDriveBrowser(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx

  if (path === '/api/drive/accounts' && method === 'GET') {
    json(res, googleAccountNames())
    return true
  }

  if (path === '/api/drive/list' && method === 'GET') {
    const folderId = url.searchParams.get('folderId') || 'root'
    if (!isSafeFolderId(folderId)) { json(res, { error: 'ervenytelen folderId' }, 400); return true }
    // A Fotok oldal ugyanezt a vegpontot hasznalja, csak keprem -- egy lista, egy
    // jogosultsag, egy hibakezeles.
    const mediaOnly = url.searchParams.get('media') === '1'
    try {
      const token = await getAccessToken(accountFromQuery(url))
      const q = encodeURIComponent(driveListQuery(folderId, mediaOnly))
      const fields = encodeURIComponent('files(id,name,mimeType,size,modifiedTime,iconLink,webViewLink,thumbnailLink,imageMediaMetadata(width,height))')
      const data = await driveJson(`${DRIVE_FILES_URL}?q=${q}&fields=${fields}&orderBy=folder,name&pageSize=200`, token)
      const files = (data.files || []).map((f: any) => ({
        id: f.id,
        name: f.name,
        isFolder: f.mimeType === 'application/vnd.google-apps.folder',
        mimeType: f.mimeType,
        size: f.size ? Number(f.size) : null,
        modifiedTime: f.modifiedTime || null,
        webViewLink: f.webViewLink || null,
        // Csak azt mondjuk meg, VAN-E belyegkep. Magat a linket nem adjuk ki: az
        // egy alairt Google-URL, ami a bongeszo elozmenyeibe es a naplokba is
        // bekerulne -- a kepet a /api/drive/thumbnail hozza el helyettunk.
        hasThumb: !!f.thumbnailLink,
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

  // Belyegkep-proxy a Fotok racshoz. Miert proxy, es nem a thumbnailLink megy ki
  // a kliensnek: (1) a link alairt Google-URL, ami a bongeszo elozmenyeibe es a
  // megosztott kepernyore is kikerulne, (2) a dashboard `Authorization: Bearer`
  // fejleccel hitelesit, egy <img src> viszont fejlecet nem visz -- a kepet igy
  // is, ugy is a kliens fetch-e hozza el, es akkor mar mi is ellenorizhetjuk,
  // honnan.
  if (path === '/api/drive/thumbnail' && method === 'GET') {
    const fileId = url.searchParams.get('fileId') || ''
    if (!isSafeFolderId(fileId)) { json(res, { error: 'ervenytelen fileId' }, 400); return true }
    const size = clampThumbSize(url.searchParams.get('size'))
    try {
      const token = await getAccessToken(accountFromQuery(url))
      const meta = await driveJson(`${DRIVE_FILES_URL}/${encodeURIComponent(fileId)}?fields=thumbnailLink`, token)
      const link = meta.thumbnailLink || ''
      if (!link) { json(res, { error: 'nincs belyegkep', code: 'no_thumbnail' }, 404); return true }
      const sized = thumbnailUrlWithSize(link, size)
      if (!isAllowedThumbnailUrl(sized)) { json(res, { error: 'nem Google-cimrol jonne', code: 'bad_thumbnail_host' }, 502); return true }
      // A link maga alairt -- a Bearer tokenunket NEM kuldjuk el vele.
      const upstream = await fetch(sized)
      const ctype = upstream.headers.get('content-type') || ''
      if (!upstream.ok || !upstream.body || !ctype.startsWith('image/')) {
        json(res, { error: `belyegkep ${upstream.status}`, code: 'thumbnail_failed' }, 502)
        return true
      }
      res.writeHead(200, {
        'Content-Type': ctype,
        // Privat kep: csak a bongeszo tarolhatja, kozbeeso gyorsitotar nem.
        'Cache-Control': 'private, max-age=3600',
      })
      // A darabok VISSZANYOMASSAL mennek at: a `pipeline` megvarja, amig a
      // bongeszo fele indulo darab tenyleg elment, mielott a kovetkezot kerne.
      // Kezi `res.write()`-tal a visszateresi erteket kellene figyelni -- ha
      // nem tesszuk, egy lassu halozaton a Google gyorsabban ontja be a fajlt,
      // mint ahogy elmegy, es a kulonbseg a szolgaltatas memoriajaban gyulik.
      // Egy nagy fajl igy megismetelte volna a fotos memoria-tuskét.
      await pipeline(Readable.fromWeb(upstream.body as any), res)
    } catch (err: any) {
      logger.warn({ err: err.message, fileId }, '[drive-browser] thumbnail failed')
      if (!res.headersSent) json(res, { error: err.message }, 502)
      else res.end()
    }
    return true
  }

  // Belyegkep-proxy a Fotok racshoz. Miert proxy, es nem a thumbnailLink megy ki
  // a kliensnek: (1) a link alairt Google-URL, ami a bongeszo elozmenyeibe es a
  // megosztott kepernyore is kikerulne, (2) a dashboard `Authorization: Bearer`
  // fejleccel hitelesit, egy <img src> viszont fejlecet nem visz -- a kepet igy
  // is, ugy is a kliens fetch-e hozza el, es akkor mar mi is ellenorizhetjuk,
  // honnan.
  if (path === '/api/drive/thumbnail' && method === 'GET') {
    const fileId = url.searchParams.get('fileId') || ''
    if (!isSafeFolderId(fileId)) { json(res, { error: 'ervenytelen fileId' }, 400); return true }
    const size = clampThumbSize(url.searchParams.get('size'))
    try {
      const token = await getAccessToken(accountFromQuery(url))
      const meta = await driveJson(`${DRIVE_FILES_URL}/${encodeURIComponent(fileId)}?fields=thumbnailLink`, token)
      const link = meta.thumbnailLink || ''
      if (!link) { json(res, { error: 'nincs belyegkep', code: 'no_thumbnail' }, 404); return true }
      const sized = thumbnailUrlWithSize(link, size)
      if (!isAllowedThumbnailUrl(sized)) { json(res, { error: 'nem Google-cimrol jonne', code: 'bad_thumbnail_host' }, 502); return true }
      // A link maga alairt -- a Bearer tokenunket NEM kuldjuk el vele.
      const upstream = await fetch(sized)
      const ctype = upstream.headers.get('content-type') || ''
      if (!upstream.ok || !upstream.body || !ctype.startsWith('image/')) {
        json(res, { error: `belyegkep ${upstream.status}`, code: 'thumbnail_failed' }, 502)
        return true
      }
      res.writeHead(200, {
        'Content-Type': ctype,
        // Privat kep: csak a bongeszo tarolhatja, kozbeeso gyorsitotar nem.
        'Cache-Control': 'private, max-age=3600',
      })
      // A darabok VISSZANYOMASSAL mennek at: a `pipeline` megvarja, amig a
      // bongeszo fele indulo darab tenyleg elment, mielott a kovetkezot kerne.
      // Kezi `res.write()`-tal a visszateresi erteket kellene figyelni -- ha
      // nem tesszuk, egy lassu halozaton a Google gyorsabban ontja be a fajlt,
      // mint ahogy elmegy, es a kulonbseg a szolgaltatas memoriajaban gyulik.
      // Egy nagy fajl igy megismetelte volna a fotos memoria-tuskét.
      await pipeline(Readable.fromWeb(upstream.body as any), res)
    } catch (err: any) {
      logger.warn({ err: err.message, fileId }, '[drive-browser] thumbnail failed')
      if (!res.headersSent) json(res, { error: err.message }, 502)
      else res.end()
    }
    return true
  }

  if (path === '/api/drive/download' && method === 'GET') {
    const fileId = url.searchParams.get('fileId') || ''
    const name = url.searchParams.get('name') || 'download'
    if (!fileId) { json(res, { error: 'fileId kotelezo' }, 400); return true }
    const plan = driveDownloadPlan(fileId, url.searchParams.get('mimeType'), name)
    if (plan.unsupported) {
      // Gepi kod is megy vissza, hogy a dashboard a sajat nyelven tudjon szolni.
      json(res, { error: `Ez a Google-fajltipus nem tolthetó le: ${plan.unsupported}`, code: 'unsupported_google_type' }, 400)
      return true
    }
    try {
      const token = await getAccessToken(accountFromQuery(url))
      const upstream = await driveFetch(plan.url, token)
      if (!upstream.ok || !upstream.body) {
        const text = await upstream.text()
        json(res, { error: `Drive API ${upstream.status}: ${text.slice(0, 200)}` }, 502)
        return true
      }
      res.writeHead(200, {
        'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream',
        'Content-Disposition': contentDispositionHeader(plan.filename),
        'Cache-Control': 'private, no-store',
      })
      // A darabok VISSZANYOMASSAL mennek at: a `pipeline` megvarja, amig a
      // bongeszo fele indulo darab tenyleg elment, mielott a kovetkezot kerne.
      // Kezi `res.write()`-tal a visszateresi erteket kellene figyelni -- ha
      // nem tesszuk, egy lassu halozaton a Google gyorsabban ontja be a fajlt,
      // mint ahogy elmegy, es a kulonbseg a szolgaltatas memoriajaban gyulik.
      // Egy nagy fajl igy megismetelte volna a fotos memoria-tuskét.
      await pipeline(Readable.fromWeb(upstream.body as any), res)
    } catch (err: any) {
      logger.warn({ err: err.message }, '[drive-browser] download failed')
      if (!res.headersSent) json(res, { error: err.message }, 502)
      else res.end()
    }
    return true
  }

  return false
}
