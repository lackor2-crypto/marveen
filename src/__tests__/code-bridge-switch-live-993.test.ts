// #993 (Boss TG 7809): the stopped VS Code bridge was started from the card, the card looked alive, yet Telegram
// messages stayed undelivered until the dashboard happened to restart. The switch must act on the running process.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { Readable } from 'node:stream'
import type http from 'node:http'
import { rmSync } from 'node:fs'

// Own throw-away store: the switch is written to config-overrides.json, which must never be a real one.
const STORE = vi.hoisted(() => `${process.env['TMPDIR'] || '/tmp'}/bridge-switch-993-${process.pid}-${Date.now()}`)
vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()), STORE_DIR: STORE, CODE_BOT_TOKEN: 'test-token',
}))
vi.mock('../env.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../env.js')>()), readEnvFile: () => ({}) }))

import { initDatabase } from '../db.js'
import { resetCodeBridgeTablesForTests } from '../web/code-bridge-store.js'
import { tryHandleCode } from '../web/routes/code.js'
import { startCodeBridgeServices, stopCodeBridgeServices, CODE_BRIDGE_SYNC_MS } from '../web/code-bridge-services.js'
import { setOverride } from '../settings-store.js'

async function call(path: string, method: string, body?: unknown): Promise<{ status: number; body: any }> {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as unknown as http.IncomingMessage
  ;(req as any).socket = { remoteAddress: '127.0.0.1' }
  ;(req as any).headers = { 'content-type': 'application/json' }
  const out = { status: 0, body: null as any }
  const res = {
    writeHead(s: number) { out.status = s; return res },
    setHeader() { return res },
    end(b?: string) { out.body = b ? JSON.parse(b) : null },
  } as unknown as http.ServerResponse
  await tryHandleCode({ req, res, path, method, url: new URL(`http://127.0.0.1:3420${path}`) } as any)
  return out
}

const polls: string[] = []

beforeAll(() => {
  initDatabase(':memory:')
  resetCodeBridgeTablesForTests()
  vi.useFakeTimers()
  // A long poll that never answers: nothing leaves the machine.
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    if (String(url).includes('/getUpdates')) polls.push(String(url))
    return new Promise(() => {})
  }))
})

afterAll(() => {
  stopCodeBridgeServices()
  rmSync(STORE, { recursive: true, force: true })
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('the bridge switch acts without a dashboard restart (#993)', () => {
  it('started while off, switched on: the task routes answer and Telegram is polled', async () => {
    setOverride('CODE_BRIDGE_ENABLED', '0')
    startCodeBridgeServices()
    expect((await call('/api/code/tasks', 'GET')).status).toBe(503)
    expect(polls).toHaveLength(0)

    const saved = await call('/api/code/config', 'POST', { CODE_BRIDGE_ENABLED: '1' })
    expect(saved.body.restartRequired).toBe(false)
    expect((await call('/api/code/tasks', 'GET')).status).toBe(200)
    await vi.advanceTimersByTimeAsync(CODE_BRIDGE_SYNC_MS * 5)
    // one long poll, however often the watcher looks
    expect(polls).toHaveLength(1)
  })

  it('switched off again: the task routes close at once and the saved value equals the running one', async () => {
    await call('/api/code/config', 'POST', { CODE_BRIDGE_ENABLED: '0' })
    expect((await call('/api/code/tasks', 'GET')).status).toBe(503)
    // saving an unchanged form again asks for nothing either
    expect((await call('/api/code/config', 'POST', { CODE_BRIDGE_ENABLED: '0' })).body.restartRequired).toBe(false)
    const config = await call('/api/code/config', 'GET')
    expect(config.body.live.enabled).toBe(false)
    expect(config.body.CODE_BRIDGE_ENABLED).toBe('0')
  })
})
