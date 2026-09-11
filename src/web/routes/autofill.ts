// Browser autofill: the wire between the Chrome extension and the vault.
//
// Card 21311fdb (#96), the second half of 85eafd56 (#46). Boss wanted the
// login page filled by MARVEEN, not by Chrome's own password manager -- which
// means the vault has to answer questions asked by a browser extension, the
// most exposed client there is. The whole design is about keeping that answer
// narrow:
//
//   - The extension has its OWN token (autofill-clients.ts), accepted only on
//     the three wire endpoints below (auth-gate.ts). It is not a dashboard
//     credential: it cannot read the kanban, the agents, or the rest of the
//     vault.
//   - It can never ask "give me everything". It asks "what do you have for
//     THIS url", and the server decides -- the domain check is here, on the
//     server, not in the extension where a compromised page could lean on it.
//   - Widening never happens: an entry saved for accounts.google.com does not
//     cover mail.google.com (see autofill-match.ts).
//   - Every credential handed out is written to a log the owner can read on
//     the dashboard, together with every refusal.
//
// The dashboard-side endpoints (pairing code, client list, revoke, the
// extension download) use the normal dashboard auth, like every other page.

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { readBody, json } from '../http-helpers.js'
import { logger } from '../../logger.js'
import { PROJECT_ROOT } from '../../config.js'
import { listSecrets, getSecretFields } from '../vault.js'
import { buildZip } from '../zip-writer.js'
import { urlCoversPage, hostFromUrlLike, credentialsFromFields } from '../autofill-match.js'
import {
  createPairingCode, pendingPairingExpiry, redeemPairingCode,
  listAutofillClients, revokeAutofillClient,
  recordAutofillEvent, listAutofillEvents,
  PAIRING_TTL_SEC,
} from '../autofill-clients.js'
import type { RouteContext } from './types.js'

/** Where the shipped extension lives in the repo. It is part of the project,
 *  so a fresh install has it without downloading anything. */
const EXTENSION_DIR = join(PROJECT_ROOT, 'browser-extension', 'marveen-autofill')
const EXTENSION_ZIP_NAME = 'marveen-autofill.zip'

/**
 * CORS for the extension's own calls.
 *
 * A Chrome service worker sends `Origin: chrome-extension://<id>`, which is
 * cross-origin by definition. Only extension origins are echoed back -- a web
 * page's origin never is, so a hostile site cannot use these endpoints from a
 * victim's browser even if it somehow learned the token.
 */
function isExtensionOrigin(origin: string | undefined): boolean {
  return typeof origin === 'string' && /^(chrome-extension|moz-extension|safari-web-extension):\/\/[a-z0-9-]+\/?$/i.test(origin)
}

function applyCors(ctx: RouteContext): void {
  const origin = ctx.req.headers.origin
  if (!isExtensionOrigin(origin)) return
  ctx.res.setHeader('Access-Control-Allow-Origin', origin!)
  ctx.res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type')
  ctx.res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  ctx.res.setHeader('Vary', 'Origin')
}

async function body(ctx: RouteContext): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse((await readBody(ctx.req)).toString() || '{}')
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/** Every file of the extension, as zip entries under one folder -- Chrome's
 *  "Load unpacked" wants a folder, so the archive must unpack into one. */
function extensionEntries(): Array<{ name: string; data: Buffer }> {
  const out: Array<{ name: string; data: Buffer }> = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) { walk(full); continue }
      const rel = relative(EXTENSION_DIR, full).split(sep).join('/')
      out.push({ name: `marveen-autofill/${rel}`, data: readFileSync(full) })
    }
  }
  walk(EXTENSION_DIR)
  return out
}

export async function tryHandleAutofill(ctx: RouteContext): Promise<boolean> {
  const { res, path, method } = ctx
  if (!path.startsWith('/api/autofill')) return false

  // --- CORS preflight -------------------------------------------------------
  if (method === 'OPTIONS') {
    applyCors(ctx)
    res.writeHead(204)
    res.end()
    return true
  }

  // --- Dashboard side -------------------------------------------------------

  // A pairing code to read off the screen. Short-lived and one-shot; asking
  // again replaces the previous one so two codes are never live at once.
  if (path === '/api/autofill/pairing' && method === 'POST') {
    const pairing = createPairingCode()
    json(res, { code: pairing.code, expires_at: pairing.expiresAt, ttl_seconds: PAIRING_TTL_SEC })
    return true
  }

  // Everything the panel shows. The extension_dir flag is what keeps the page
  // honest on an install where the folder is missing: "nincs meg" is a
  // different sentence from "nincs parositva".
  if (path === '/api/autofill/clients' && method === 'GET') {
    json(res, {
      clients: listAutofillClients().map(c => ({
        id: c.id, name: c.name, unnamed: !c.name,
        created_at: c.createdAt, last_used_at: c.lastUsedAt,
      })),
      events: listAutofillEvents(30).map(e => ({
        id: e.id, client_name: e.clientName, unnamed: !e.clientName,
        host: e.host, entry_label: e.entryLabel, outcome: e.outcome, created_at: e.createdAt,
      })),
      pending_pairing_expires_at: pendingPairingExpiry(),
      extension_available: existsSync(join(EXTENSION_DIR, 'manifest.json')),
      extension_download: `/api/autofill/extension.zip`,
    })
    return true
  }

  const revokeMatch = /^\/api\/autofill\/clients\/(\d+)$/.exec(path)
  if (revokeMatch && method === 'DELETE') {
    const ok = revokeAutofillClient(Number(revokeMatch[1]))
    json(res, ok ? { ok: true } : { error: 'not_found' }, ok ? 200 : 404)
    return true
  }

  if (path === '/api/autofill/extension.zip' && method === 'GET') {
    if (!existsSync(join(EXTENSION_DIR, 'manifest.json'))) {
      json(res, {
        error: 'extension_missing',
        message: 'A bongeszo-kiegeszites mappaja hianyzik ebbol a telepitesbol (browser-extension/marveen-autofill).',
        message_en: 'This installation has no browser-extension/marveen-autofill folder.',
      }, 404)
      return true
    }
    try {
      const zip = buildZip(extensionEntries())
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${EXTENSION_ZIP_NAME}"`,
        'Content-Length': String(zip.length),
        'Cache-Control': 'private, no-store',
      })
      res.end(zip)
    } catch (err) {
      logger.error({ err }, 'autofill: building the extension zip failed')
      json(res, { error: 'zip_failed', detail: err instanceof Error ? err.message : String(err) }, 500)
    }
    return true
  }

  // --- Extension side -------------------------------------------------------

  // Pairing. Authenticated by the code itself (the gate leaves this path
  // public for exactly that reason), and each failure is named so the popup
  // can tell the user which of the three mistakes it was.
  if (path === '/api/autofill/pair' && method === 'POST') {
    applyCors(ctx)
    const b = await body(ctx)
    const result = redeemPairingCode(str(b.code), str(b.name))
    if (!result.ok) {
      logger.warn({ reason: result.reason }, 'autofill: pairing refused')
      json(res, { error: 'pairing_refused', reason: result.reason }, 401)
      return true
    }
    logger.info({ client: result.client.name || '(unnamed)', id: result.client.id }, 'autofill: browser paired')
    json(res, { token: result.client.token, name: result.client.name, client_id: result.client.id })
    return true
  }

  const client = ctx.auth?.kind === 'autofill'
    ? { id: ctx.auth.clientId ?? 0, name: ctx.auth.client ?? '' }
    : null

  // What the vault has for this page. Usernames yes, passwords never: the
  // extension needs enough to let a person choose between two accounts, and
  // nothing more until one is chosen.
  if (path === '/api/autofill/lookup' && method === 'POST') {
    applyCors(ctx)
    if (!client) { json(res, { error: 'Unauthorized' }, 401); return true }
    const b = await body(ctx)
    const pageUrl = str(b.url)
    const host = hostFromUrlLike(pageUrl)
    if (!host) { json(res, { candidates: [], reason: 'bad_url' }); return true }
    const candidates: unknown[] = []
    for (const entry of listSecrets()) {
      if (!urlCoversPage(entry.url, pageUrl)) continue
      const creds = credentialsFromFields(getSecretFields(entry.id))
      if (creds.length === 0) {
        // Matched the site but holds no password: say so instead of staying
        // silent, or the user is left wondering why nothing happened.
        candidates.push({ entry_id: entry.id, label: entry.label, section: '', username: '', username_label: '', problem: 'no_password' })
        continue
      }
      for (const c of creds) {
        candidates.push({
          entry_id: entry.id, label: entry.label, section: c.section,
          username: c.username, username_label: c.usernameLabel,
        })
      }
    }
    json(res, { candidates })
    return true
  }

  // One credential, for one card, for one page. The domain is checked again
  // here -- the lookup above is a convenience, this is the gate.
  if (path === '/api/autofill/credential' && method === 'POST') {
    applyCors(ctx)
    if (!client) { json(res, { error: 'Unauthorized' }, 401); return true }
    const b = await body(ctx)
    const pageUrl = str(b.url)
    const entryId = str(b.entry_id)
    const section = str(b.section)
    const host = hostFromUrlLike(pageUrl) ?? ''
    const entry = listSecrets().find(e => e.id === entryId)
    if (!entry) {
      recordAutofillEvent({ clientId: client.id, clientName: client.name, host, outcome: 'no_match' })
      json(res, { error: 'not_found', reason: 'no_match' }, 404)
      return true
    }
    if (!urlCoversPage(entry.url, pageUrl)) {
      // The interesting refusal: a paired browser asking for a card that does
      // not belong to the page it is standing on.
      logger.warn({ client: client.name, host, entry: entry.label }, 'autofill: refused, card does not cover this page')
      recordAutofillEvent({ clientId: client.id, clientName: client.name, host, entryId: entry.id, entryLabel: entry.label, outcome: 'refused_domain' })
      json(res, { error: 'refused', reason: 'refused_domain' }, 403)
      return true
    }
    const creds = credentialsFromFields(getSecretFields(entry.id))
    const chosen = section ? creds.find(c => c.section === section) : creds[0]
    if (!chosen) {
      recordAutofillEvent({ clientId: client.id, clientName: client.name, host, entryId: entry.id, entryLabel: entry.label, outcome: 'no_password' })
      json(res, { error: 'no_password', reason: 'no_password' }, 404)
      return true
    }
    recordAutofillEvent({ clientId: client.id, clientName: client.name, host, entryId: entry.id, entryLabel: entry.label, outcome: 'served' })
    json(res, { username: chosen.username, password: chosen.password, label: entry.label, section: chosen.section })
    return true
  }

  return false
}

/** Exported for the gate's CSRF exception and for tests. */
export { isExtensionOrigin }
