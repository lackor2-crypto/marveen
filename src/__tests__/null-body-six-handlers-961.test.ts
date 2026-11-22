// #961 follow-up: drives the six self-catching handlers through their REAL route functions (not a source grep) with
// well-formed JSON of the wrong shape. Before the fix each answered 500 (their own catch turned the destructuring of
// `null` into a server error); now each falls through to its own validation and answers a clear 4xx.
import { describe, it, expect, beforeEach } from 'vitest'
import { Readable } from 'node:stream'
import { initDatabase } from '../db.js'
import { tryHandleAutonomy } from '../web/routes/autonomy.js'
import { tryHandleConnectorsHu } from '../web/routes/connectors-hu.js'
import { tryHandleSettings } from '../web/routes/settings.js'
import { tryHandleVaultSsh } from '../web/routes/vault-ssh.js'
import { tryHandleDebateRun } from '../web/routes/debate-run.js'
import { tryHandleVaultSshKeys } from '../web/routes/vault-ssh-keys.js'
import type { RouteContext } from '../web/routes/types.js'

async function call(handler: (c: RouteContext) => Promise<boolean>, path: string, raw: string, method = 'POST') {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = {
    headersSent: false,
    writeHead(status: number) { out.status = status; return res },
    setHeader() { return res },
    end(chunk?: string) { if (chunk) { try { out.body = JSON.parse(chunk) } catch { out.body = chunk } } },
  }
  const req: any = Readable.from([Buffer.from(raw)])
  req.headers = { 'content-length': String(raw.length) }
  const url = new URL(`http://localhost:3420${path}`)
  await handler({ req, res, path: url.pathname, method, url } as RouteContext)
  return out
}

const targets: Array<[string, (c: RouteContext) => Promise<boolean>, string]> = [
  ['autonomy', tryHandleAutonomy, '/api/autonomy'],
  ['autonomy/agent', tryHandleAutonomy, '/api/autonomy/agent'],
  ['connectors-hu/configure', tryHandleConnectorsHu, '/api/connectors-hu/configure'],
  ['settings', tryHandleSettings, '/api/settings'],
  ['vault/ssh-servers', tryHandleVaultSsh, '/api/vault/ssh-servers'],
  ['debate/run', tryHandleDebateRun, '/api/debate/run'],
  ['debate/estimate', tryHandleDebateRun, '/api/debate/estimate'],
  ['vault/ssh-keys', tryHandleVaultSshKeys, '/api/vault/ssh-keys'],
  ['vault/ssh-keys/import', tryHandleVaultSshKeys, '/api/vault/ssh-keys/import'],
]

describe('#961 PUT on an EXISTING ssh server (the fuzz had none, so it only saw 404)', () => {
  beforeEach(() => { initDatabase(':memory:') })
  for (const raw of ['null', '5', '[]']) {
    it(`vault/ssh-servers/:id PUT <- ${raw}: 4xx, not 5xx`, async () => {
      const made = await call(tryHandleVaultSsh, '/api/vault/ssh-servers', JSON.stringify({ name: 'n', host: 'h.example', user: 'u' }))
      expect(made.status).toBe(201)
      const out = await call(tryHandleVaultSsh, `/api/vault/ssh-servers/${made.body.server.id}`, raw, 'PUT')
      expect(out.status).toBeLessThan(500)
    })
  }
})

describe('#961 a null / number / array body never reaches a 500 on the self-catching handlers', () => {
  beforeEach(() => { initDatabase(':memory:') })
  for (const [name, handler, path] of targets) {
    for (const raw of ['null', '5', '[]', '"text"']) {
      it(`${name} <- ${raw}: 4xx, not 5xx`, async () => {
        const out = await call(handler, path, raw)
        expect(out.status).toBeGreaterThanOrEqual(400)
        expect(out.status).toBeLessThan(500)
      })
    }
  }
})
