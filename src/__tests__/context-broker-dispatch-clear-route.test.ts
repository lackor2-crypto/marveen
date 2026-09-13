// Wiring for POST /api/context-broker/dispatch-clear (kartya #275). The clearing
// logic itself is tested in context-clear.test.ts; here we only prove the route
// is reachable under its subpath, threads dispatcher/force through to
// clearRoleParticipants, and returns the report as JSON. clearRoleParticipants
// is mocked so the endpoint test never touches tmux or the fleet.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Readable } from 'node:stream'
import type http from 'node:http'

const captured = vi.hoisted(() => ({ calls: [] as Array<{ dispatcher?: string | null; force?: boolean }> }))

vi.mock('../web/context-clear.js', () => ({
  clearRoleParticipants: async (opts: { dispatcher?: string | null; force?: boolean } = {}) => {
    captured.calls.push(opts)
    return {
      dispatcher: opts.dispatcher ?? null,
      assignedCount: 3,
      results: [
        { agent: 'usalackor', roles: ['implementer'], outcome: 'cleared' },
        { agent: 'gypsy', roles: ['checker'], outcome: 'busy' },
      ],
      clearedCount: 1,
    }
  },
}))

import { tryHandleSettings } from '../web/routes/settings.js'

interface Captured { status: number; body: any }
async function call(method: string, path: string, body?: unknown): Promise<Captured> {
  const payload = body === undefined ? '' : JSON.stringify(body)
  const req = Readable.from([Buffer.from(payload)]) as unknown as http.IncomingMessage
  ;(req as any).socket = { remoteAddress: '127.0.0.1' }
  ;(req as any).headers = { 'content-type': 'application/json' }
  const out: Captured = { status: 0, body: null }
  const res = {
    writeHead(status: number) { out.status = status; return res },
    setHeader() { return res },
    end(chunk?: any) { if (chunk) { try { out.body = JSON.parse(String(chunk)) } catch { out.body = String(chunk) } } },
  } as unknown as http.ServerResponse
  const handled = await tryHandleSettings({
    req, res, path, method, url: new URL('http://127.0.0.1:3420' + path),
  } as any)
  expect(handled).toBe(true)
  return out
}

describe('POST /api/context-broker/dispatch-clear (kartya #275)', () => {
  beforeEach(() => { captured.calls = [] })

  it('is reachable under its subpath and returns the report', async () => {
    const out = await call('POST', '/api/context-broker/dispatch-clear', { dispatcher: 'lackor2' })
    expect(out.status).toBe(200)
    expect(out.body.ok).toBe(true)
    expect(out.body.dispatcher).toBe('lackor2')
    expect(out.body.assignedCount).toBe(3)
    expect(out.body.clearedCount).toBe(1)
    expect(out.body.results).toHaveLength(2)
  })

  it('threads dispatcher and force through to clearRoleParticipants', async () => {
    await call('POST', '/api/context-broker/dispatch-clear', { dispatcher: '  lackor2  ', force: true })
    expect(captured.calls).toEqual([{ dispatcher: 'lackor2', force: true }])
  })

  it('defaults force to false and a missing dispatcher to null', async () => {
    await call('POST', '/api/context-broker/dispatch-clear', {})
    expect(captured.calls).toEqual([{ dispatcher: null, force: false }])
  })
})
