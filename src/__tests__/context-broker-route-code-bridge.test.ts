// A VS Code kartya "tervezo/megvalosito/ellenorzo" checkbox-ja mindig 400-at
// adott (Boss hangüzenete, 2026-08-28): a frontend a szerep-gazdanak
// "vscode:<projekt>" alnevet gyart (web/app.js cbRoleHolder), de a szerver
// /api/context-broker vegpontja csak a valodi flotta-ugynokok nevet fogadta
// el -- a "vscode:*" alak sosem szerepelt a listBrokerCandidates()-ben, tehat
// minden checkbox-kattintas "Unknown or missing agent" 400-zal bukott.
//
// Ezek a tesztek a JAVITAST orzik: egy letezo VS Code projekt szerepet
// kaphat, egy nem-letezo nem, es a "generator" (designated) mezot tovabbra
// sem foglalhatja el egy VS Code projekt -- csak SZEREPET (planner/
// implementer/checker), mert az nem valodi flotta-ugynok, nem tud kontextust
// osszeallitani masoknak.

import { describe, it, expect, beforeEach } from 'vitest'
import { Readable } from 'node:stream'
import type http from 'node:http'
import { initDatabase } from '../db.js'
import { resetCodeBridgeTablesForTests, upsertCodeSession } from '../web/code-bridge-store.js'
import { tryHandleSettings } from '../web/routes/settings.js'

const WS = 'C:\\ws\\tozsde'

beforeEach(() => {
  initDatabase(':memory:')
  resetCodeBridgeTablesForTests()
})

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

describe('POST /api/context-broker -- code-bridge role holders', () => {
  it('rejects a role for a VS Code project the code bridge has never heard of', async () => {
    const out = await call('POST', '/api/context-broker', {
      role: 'implementer', agent: 'vscode:sosevoltilyenprojekt', enabled: true,
    })
    expect(out.status).toBe(400)
    expect(out.body.error).toMatch(/Unknown or missing/)
  })

  it('accepts a role for a VS Code project that is actually registered', async () => {
    upsertCodeSession({ project: 'tozsde', workspacePath: WS, sessionId: 'sess-1', title: null, host: 'WINPC' })
    const out = await call('POST', '/api/context-broker', {
      role: 'implementer', agent: 'vscode:tozsde', enabled: true,
    })
    expect(out.status).toBe(200)
    expect(out.body.ok).toBe(true)
    expect(out.body.config.roles.implementer).toBe('vscode:tozsde')
  })

  it('still refuses a made-up fleet agent name with no role attached', async () => {
    const out = await call('POST', '/api/context-broker', { agent: 'nincs-ilyen-ugynok' })
    expect(out.status).toBe(400)
  })

  it('refuses to make a VS Code project the fleet-wide generator (designation, not a role)', async () => {
    upsertCodeSession({ project: 'tozsde', workspacePath: WS, sessionId: 'sess-1', title: null, host: 'WINPC' })
    // No `role` field: this is a designation change, not a role assignment.
    const out = await call('POST', '/api/context-broker', { agent: 'vscode:tozsde' })
    expect(out.status).toBe(400)
  })
})
