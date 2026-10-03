// #461: the snapshot endpoints are reachable through the REAL workbench route handler (the first deploy put them
// behind the items-only branch, so they answered "Not found").
import { describe, it, expect, beforeEach } from 'vitest'
import { Readable } from 'node:stream'
import { initDatabase } from '../db.js'
import { tryHandleWorkbench } from '../web/routes/workbench.js'
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
  const raw = body === undefined ? '' : JSON.stringify(body)
  const req: any = Readable.from([Buffer.from(raw, 'utf-8')])
  req.headers = { 'content-type': 'application/json' }
  const url = new URL(`http://localhost:3420${path}`)
  const ctx = { req, res, path: url.pathname, method, url, auth: { kind: 'session' as const, user: 'teszt' } } as unknown as RouteContext
  return tryHandleWorkbench(ctx).then((handled) => ({ handled, ...out }))
}

beforeEach(() => { initDatabase(':memory:') })

describe('snapshot routes', () => {
  it('GET status is handled and answers', async () => {
    const r = await call('/api/workbench/snapshot/status', 'GET')
    expect(r.handled).toBe(true)
    expect(r.status).toBe(200)
    expect(r.body).toHaveProperty('items')
  })
  it('POST restore on a fresh install is not an error: nothing to rebuild', async () => {
    const r = await call('/api/workbench/snapshot/restore', 'POST', {})
    expect(r.handled).toBe(true)
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ ok: true, restored: 0, failed: 0 })
  })
})
