// The MEGA download endpoints are reachable through the REAL backup-rules route handler.
import { describe, it, expect, beforeEach } from 'vitest'
import { Readable } from 'node:stream'
import { initDatabase } from '../db.js'
import { tryHandleBackupRules } from '../web/routes/backup-rules.js'
import type { RouteContext } from '../web/routes/types.js'

function call(path: string, method: string, body?: unknown) {
  const out: { status: number; body: any } = { status: 200, body: null }
  const res: any = {
    writeHead(s: number) { out.status = s; return res },
    setHeader() { return res },
    write() { return true },
    end(chunk?: string) { if (chunk) { try { out.body = JSON.parse(chunk) } catch { /* ignore */ } } },
    on() { return res },
  }
  const req: any = Readable.from([Buffer.from(body === undefined ? '' : JSON.stringify(body), 'utf-8')])
  req.headers = { 'content-type': 'application/json' }
  const url = new URL(`http://localhost:3420${path}`)
  const ctx = { req, res, path: url.pathname, method, url, auth: { kind: 'session' as const, user: 'teszt' } } as unknown as RouteContext
  return tryHandleBackupRules(ctx).then((handled) => ({ handled, ...out }))
}

beforeEach(() => { initDatabase(':memory:') })

describe('MEGA download routes', () => {
  it('status is handled and has no job on a fresh install', async () => {
    const r = await call('/api/backup-rules/mega/download/status', 'GET')
    expect(r.handled).toBe(true)
    expect(r.body).toHaveProperty('job')
  })
  it('preview and run for an unknown account answer with a human sentence, not a crash', async () => {
    for (const p of ['preview', 'run']) {
      const r = await call(`/api/backup-rules/mega/download/${p}`, 'POST', { account: 'nincs-ilyen' })
      expect(r.handled).toBe(true)
      expect(r.status).toBe(400)
      expect(r.body.code).toBe('no_account')
      expect(String(r.body.error).length).toBeGreaterThan(10)
    }
  })
})
