import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import type http from 'node:http'
import { Readable } from 'node:stream'
import { crc32 as zlibCrc32 } from 'node:zlib'
import { readFileSync } from 'node:fs'

// The vault is mocked: these tests must never read or write the real
// store/vault.json, and the route's contract is "what it does with what the
// vault hands it", not the crypto underneath (vault-fields.test.ts owns that).
const ENTRIES = [
  { id: 'yt', label: 'YouTube', url: 'https://youtube.com', createdAt: '', updatedAt: '' },
  { id: 'gmail', label: 'Gmail', url: 'https://accounts.google.com', createdAt: '', updatedAt: '' },
  { id: 'note', label: 'Wifi jelszó', url: 'https://router.example.com', createdAt: '', updatedAt: '' },
]
const FIELDS: Record<string, Array<{ label: string; kind: string; value: string; section?: string }>> = {
  yt: [
    { label: 'Felhasználónév', kind: 'text', value: 'boss@example.com' },
    { label: 'Jelszó', kind: 'secret', value: 'yt-titok' },
  ],
  gmail: [
    { label: 'E-mail', kind: 'text', value: 'boss@gmail.com' },
    { label: 'Jelszó', kind: 'secret', value: 'gmail-titok' },
  ],
  note: [{ label: 'Megjegyzés', kind: 'text', value: 'a routeren a matrica' }],
}

vi.mock('../web/vault.js', () => ({
  listSecrets: () => ENTRIES,
  getSecretFields: (id: string) => FIELDS[id] ?? [],
}))

const { initDatabase, getDb } = await import('../db.js')
const { tryHandleAutofill, isExtensionOrigin } = await import('../web/routes/autofill.js')
const { resolveAuth, requiresAuth, isAutofillWireEndpoint } = await import('../web/auth-gate.js')
const { createPairingCode, listAutofillClients, revokeAutofillClient, _resetAutofillTablesForTest } = await import('../web/autofill-clients.js')
const { buildZip, crc32 } = await import('../web/zip-writer.js')
type RouteContext = import('../web/routes/types.js').RouteContext

const TOKEN = 'a'.repeat(64)

interface MockRes {
  statusCode: number
  headers: Record<string, string | string[]>
  body: string
  chunks: Buffer[]
  writeHead(status: number, headers?: Record<string, string | string[]>): MockRes
  setHeader(k: string, v: string): void
  end(data?: string | Buffer): void
}

function mkRes(): MockRes {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    chunks: [],
    writeHead(status, headers) { this.statusCode = status; if (headers) Object.assign(this.headers, headers); return this },
    setHeader(k, v) { this.headers[k] = v },
    end(data) {
      if (data === undefined) return
      if (Buffer.isBuffer(data)) this.chunks.push(data)
      else this.body += data
    },
  }
}

async function call(
  method: string,
  path: string,
  opts: { body?: unknown; auth?: RouteContext['auth']; headers?: Record<string, string> } = {},
): Promise<{ res: MockRes; handled: boolean; json: () => any }> {
  const payload = opts.body === undefined ? [] : [Buffer.from(JSON.stringify(opts.body))]
  const req = Readable.from(payload) as unknown as http.IncomingMessage & Record<string, unknown>
  req.headers = opts.headers ?? {}
  const res = mkRes()
  const handled = await tryHandleAutofill({
    req: req as http.IncomingMessage,
    res: res as unknown as http.ServerResponse,
    path, method,
    url: new URL(`http://127.0.0.1:3420${path}`),
    auth: opts.auth,
  })
  return { res, handled, json: () => JSON.parse(res.body || '{}') }
}

const DASHBOARD: RouteContext['auth'] = { kind: 'token' }

/** Pair a browser the way the extension does, and hand back its token. */
async function pairBrowser(name = 'Chrome (Linux)'): Promise<string> {
  const minted = await call('POST', '/api/autofill/pairing', { auth: DASHBOARD })
  const code = minted.json().code as string
  const paired = await call('POST', '/api/autofill/pair', { body: { code, name } })
  expect(paired.res.statusCode).toBe(200)
  return paired.json().token as string
}

function clientAuth(id: number, name = 'Chrome (Linux)'): RouteContext['auth'] {
  return { kind: 'autofill', client: name, clientId: id }
}

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
})

beforeEach(() => {
  _resetAutofillTablesForTest()
  for (const t of ['autofill_clients', 'autofill_pairings', 'autofill_events']) {
    try { getDb().prepare(`DELETE FROM ${t}`).run() } catch { /* created on first use */ }
  }
})

describe('pairing', () => {
  it('a code from the dashboard mints exactly one browser token', async () => {
    const token = await pairBrowser()
    expect(token.startsWith('mvaf_')).toBe(true)
    expect(listAutofillClients()).toHaveLength(1)
  })

  it('the same code cannot pair a second browser', async () => {
    const minted = await call('POST', '/api/autofill/pairing', { auth: DASHBOARD })
    const code = minted.json().code as string
    await call('POST', '/api/autofill/pair', { body: { code, name: 'first' } })
    const second = await call('POST', '/api/autofill/pair', { body: { code, name: 'second' } })
    expect(second.res.statusCode).toBe(401)
    expect(second.json().reason).toBe('already_used')
    expect(listAutofillClients()).toHaveLength(1)
  })

  it('names every refusal, so the popup can say what to do next', async () => {
    const wrong = await call('POST', '/api/autofill/pair', { body: { code: 'ZZZZ-ZZZZ', name: 'x' } })
    expect(wrong.res.statusCode).toBe(401)
    expect(wrong.json().reason).toBe('unknown_code')

    const minted = await call('POST', '/api/autofill/pairing', { auth: DASHBOARD })
    const code = minted.json().code as string
    // Age the code past its window without sleeping.
    getDb().prepare('UPDATE autofill_pairings SET expires_at = ?').run(Math.floor(Date.now() / 1000) - 1)
    const late = await call('POST', '/api/autofill/pair', { body: { code, name: 'x' } })
    expect(late.json().reason).toBe('expired')
  })

  it('the code is accepted however the user retypes it', async () => {
    const minted = await call('POST', '/api/autofill/pairing', { auth: DASHBOARD })
    const code = (minted.json().code as string).replace('-', ' ').toLowerCase()
    const paired = await call('POST', '/api/autofill/pair', { body: { code, name: 'x' } })
    expect(paired.res.statusCode).toBe(200)
  })

  it('asking again replaces the outstanding code instead of leaving two live', async () => {
    const first = await call('POST', '/api/autofill/pairing', { auth: DASHBOARD })
    const second = await call('POST', '/api/autofill/pairing', { auth: DASHBOARD })
    const stale = await call('POST', '/api/autofill/pair', { body: { code: first.json().code, name: 'x' } })
    expect(stale.res.statusCode).toBe(401)
    const fresh = await call('POST', '/api/autofill/pair', { body: { code: second.json().code, name: 'x' } })
    expect(fresh.res.statusCode).toBe(200)
  })
})

describe('the token is scoped to the autofill endpoints', () => {
  it('resolves on a wire endpoint and NOWHERE else', async () => {
    const token = await pairBrowser()
    const req = { headers: { authorization: `Bearer ${token}` } } as unknown as http.IncomingMessage

    const onWire = resolveAuth(req, new URL('http://127.0.0.1:3420/api/autofill/lookup'), '/api/autofill/lookup', 'POST', TOKEN)
    expect(onWire.kind).toBe('autofill')

    for (const path of ['/api/memories', '/api/kanban', '/api/vault', '/api/agents']) {
      const elsewhere = resolveAuth(req, new URL(`http://127.0.0.1:3420${path}`), path, 'GET', TOKEN)
      expect(elsewhere).toEqual({ kind: 'none' })
    }
  })

  it('pairing is public (the code IS the credential), the rest is not', () => {
    expect(requiresAuth('/api/autofill/pair', 'POST')).toBe(false)
    expect(requiresAuth('/api/autofill/lookup', 'POST')).toBe(true)
    expect(requiresAuth('/api/autofill/clients', 'GET')).toBe(true)
    expect(isAutofillWireEndpoint('/api/autofill/clients', 'GET')).toBe(false)
  })

  it('a revoked browser stops resolving immediately', async () => {
    const token = await pairBrowser()
    const req = { headers: { authorization: `Bearer ${token}` } } as unknown as http.IncomingMessage
    expect(resolveAuth(req, new URL('http://x/api/autofill/lookup'), '/api/autofill/lookup', 'POST', TOKEN).kind).toBe('autofill')
    revokeAutofillClient(listAutofillClients()[0]!.id)
    expect(resolveAuth(req, new URL('http://x/api/autofill/lookup'), '/api/autofill/lookup', 'POST', TOKEN)).toEqual({ kind: 'none' })
  })
})

describe('lookup', () => {
  it('offers the card saved for the site, with the username but no password', async () => {
    await pairBrowser()
    const r = await call('POST', '/api/autofill/lookup', { auth: clientAuth(1), body: { url: 'https://www.youtube.com/login' } })
    expect(r.json().candidates).toEqual([
      { entry_id: 'yt', label: 'YouTube', section: '', username: 'boss@example.com', username_label: 'Felhasználónév' },
    ])
    expect(r.res.body).not.toContain('yt-titok')
  })

  it('does not widen a stored subdomain to a sibling', async () => {
    await pairBrowser()
    const r = await call('POST', '/api/autofill/lookup', { auth: clientAuth(1), body: { url: 'https://mail.google.com/' } })
    expect(r.json().candidates).toEqual([])
  })

  it('says WHY a matching card cannot fill, instead of answering blank', async () => {
    await pairBrowser()
    const r = await call('POST', '/api/autofill/lookup', { auth: clientAuth(1), body: { url: 'https://router.example.com/admin' } })
    expect(r.json().candidates[0].problem).toBe('no_password')
  })

  it('is refused without a browser token', async () => {
    const r = await call('POST', '/api/autofill/lookup', { body: { url: 'https://youtube.com' } })
    expect(r.res.statusCode).toBe(401)
  })
})

describe('credential', () => {
  it('hands out the login for the page the browser is standing on, and logs it', async () => {
    await pairBrowser()
    const id = listAutofillClients()[0]!.id
    const r = await call('POST', '/api/autofill/credential', { auth: clientAuth(id), body: { url: 'https://www.youtube.com/login', entry_id: 'yt' } })
    expect(r.res.statusCode).toBe(200)
    expect(r.json()).toMatchObject({ username: 'boss@example.com', password: 'yt-titok' })

    const log = await call('GET', '/api/autofill/clients', { auth: DASHBOARD })
    expect(log.json().events[0]).toMatchObject({ host: 'www.youtube.com', entry_label: 'YouTube', outcome: 'served' })
  })

  it('REFUSES a card that does not cover the page, and logs the refusal', async () => {
    await pairBrowser()
    const id = listAutofillClients()[0]!.id
    const r = await call('POST', '/api/autofill/credential', { auth: clientAuth(id), body: { url: 'https://evil.example/login', entry_id: 'yt' } })
    expect(r.res.statusCode).toBe(403)
    expect(r.json().reason).toBe('refused_domain')
    expect(r.res.body).not.toContain('yt-titok')

    const log = await call('GET', '/api/autofill/clients', { auth: DASHBOARD })
    expect(log.json().events[0]).toMatchObject({ host: 'evil.example', outcome: 'refused_domain' })
  })

  it('refuses an unknown card', async () => {
    await pairBrowser()
    const r = await call('POST', '/api/autofill/credential', { auth: clientAuth(1), body: { url: 'https://youtube.com/login', entry_id: 'nincs-ilyen' } })
    expect(r.res.statusCode).toBe(404)
    expect(r.json().reason).toBe('no_match')
  })

  it('says no_password rather than filling something else', async () => {
    await pairBrowser()
    const r = await call('POST', '/api/autofill/credential', { auth: clientAuth(1), body: { url: 'https://router.example.com/admin', entry_id: 'note' } })
    expect(r.res.statusCode).toBe(404)
    expect(r.json().reason).toBe('no_password')
  })
})

describe('the dashboard panel', () => {
  it('reports an empty install as empty, not as broken', async () => {
    const r = await call('GET', '/api/autofill/clients', { auth: DASHBOARD })
    const b = r.json()
    expect(b.clients).toEqual([])
    expect(b.events).toEqual([])
    expect(b.pending_pairing_expires_at).toBeNull()
    // The folder ships with the repo; the flag is what tells a missing one
    // apart from an unpaired one.
    expect(typeof b.extension_available).toBe('boolean')
  })

  it('lists the paired browser and revokes it on request', async () => {
    await pairBrowser('Edge (Windows)')
    const listed = await call('GET', '/api/autofill/clients', { auth: DASHBOARD })
    expect(listed.json().clients[0]).toMatchObject({ name: 'Edge (Windows)', unnamed: false })

    const id = listed.json().clients[0].id
    const del = await call('DELETE', `/api/autofill/clients/${id}`, { auth: DASHBOARD })
    expect(del.res.statusCode).toBe(200)
    expect(listAutofillClients()).toEqual([])

    const gone = await call('DELETE', `/api/autofill/clients/${id}`, { auth: DASHBOARD })
    expect(gone.res.statusCode).toBe(404)
  })

  it('marks an unnamed browser so the page can label it in its own language', async () => {
    const minted = await call('POST', '/api/autofill/pairing', { auth: DASHBOARD })
    await call('POST', '/api/autofill/pair', { body: { code: minted.json().code, name: '' } })
    const listed = await call('GET', '/api/autofill/clients', { auth: DASHBOARD })
    expect(listed.json().clients[0]).toMatchObject({ name: '', unnamed: true })
  })

  it('shows that a pairing code is outstanding after a page reload', async () => {
    await call('POST', '/api/autofill/pairing', { auth: DASHBOARD })
    const r = await call('GET', '/api/autofill/clients', { auth: DASHBOARD })
    expect(typeof r.json().pending_pairing_expires_at).toBe('number')
  })
})

describe('CORS for the extension', () => {
  it('answers the preflight for an extension origin only', async () => {
    const ok = await call('OPTIONS', '/api/autofill/lookup', { headers: { origin: 'chrome-extension://abcdefghijklmnop' } })
    expect(ok.res.statusCode).toBe(204)
    expect(ok.res.headers['Access-Control-Allow-Origin']).toBe('chrome-extension://abcdefghijklmnop')

    const page = await call('OPTIONS', '/api/autofill/lookup', { headers: { origin: 'https://evil.example' } })
    expect(page.res.headers['Access-Control-Allow-Origin']).toBeUndefined()
  })

  it('recognises extension origins and nothing else', () => {
    expect(isExtensionOrigin('chrome-extension://aaaa')).toBe(true)
    expect(isExtensionOrigin('moz-extension://bbbb')).toBe(true)
    expect(isExtensionOrigin('https://youtube.com')).toBe(false)
    expect(isExtensionOrigin(undefined)).toBe(false)
  })
})

describe('the downloadable extension', () => {
  it('builds a zip whose checksums an independent implementation agrees with', () => {
    const zip = buildZip([
      { name: 'marveen-autofill/manifest.json', data: '{"manifest_version":3}' },
      { name: 'marveen-autofill/background.js', data: 'console.log(1)' },
    ], new Date('2026-09-11T10:00:00Z'))
    // Local file header, central directory and end-of-central-directory magic.
    expect(zip.readUInt32LE(0)).toBe(0x04034b50)
    expect(zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))).toBeGreaterThan(0)
    expect(zip.readUInt32LE(zip.length - 22)).toBe(0x06054b50)
    expect(zip.readUInt16LE(zip.length - 14)).toBe(2)
    // zlib's CRC is the independent check on ours.
    const payload = Buffer.from('{"manifest_version":3}', 'utf-8')
    expect(crc32(payload)).toBe(zlibCrc32(payload))
  })

  it('serves the shipped extension as one folder', async () => {
    const r = await call('GET', '/api/autofill/extension.zip', { auth: DASHBOARD })
    expect(r.res.statusCode).toBe(200)
    expect(r.res.headers['Content-Type']).toBe('application/zip')
    const data = Buffer.concat(r.res.chunks)
    expect(data.readUInt32LE(0)).toBe(0x04034b50)
    expect(data.includes(Buffer.from('marveen-autofill/manifest.json'))).toBe(true)
  })
})

// The route handler above is tested in full, but the handler is only reachable
// if src/web.ts hands the request to it -- and two lines there can kill this
// feature without a single test going red: the blanket `OPTIONS -> 204` that
// runs before routing, and the CSRF gate that rejects every foreign Origin.
// A Chrome service worker is a foreign origin BY CONSTRUCTION, so both of them
// apply to it. This is a source contract, not a running server: it cannot prove
// the pipeline works, only that the two orderings it depends on are still there.
describe('the request pipeline still reaches the handler', () => {
  const web = readFileSync(new URL('../web.ts', import.meta.url), 'utf8')

  it('answers the extension preflight BEFORE the blanket OPTIONS 204', () => {
    const branch = web.indexOf('isExtensionOrigin(origin) && isAutofillWireEndpoint(path, method)')
    const blanket = web.indexOf("if (method === 'OPTIONS')")
    expect(branch).toBeGreaterThan(-1)
    expect(blanket).toBeGreaterThan(-1)
    expect(branch).toBeLessThan(blanket)
  })

  it('exempts the extension wire from the CSRF gate, and nothing else', () => {
    expect(web).toContain('const extensionWire = isAutofillWireEndpoint(path, method) && isExtensionOrigin(origin)')
    expect(web).toMatch(/if \(!extensionWire && isBlockedCrossOriginWrite\(/)
  })

  it('routes /api/autofill to this handler', () => {
    expect(web).toContain('tryHandleAutofill')
    expect(web).toMatch(/await tryHandleAutofill\(routeCtx\)/)
  })
})
