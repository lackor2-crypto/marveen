// #923 (found in the browser walk-through): with the WHOLE bridge switched off the project cards stay on the Team
// page, each with its Pause / Resume button -- so the button must work then too. Before the fix the pause route sat
// behind the "code bridge disabled" 503 gate: the card showed the button and every press ended in an error toast.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Readable } from 'node:stream'
import type http from 'node:http'

vi.mock('../config.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../config.js')>()), CODE_BRIDGE_ENABLED: false }))

import { initDatabase } from '../db.js'
import { resetCodeBridgeTablesForTests, upsertCodeSession, getCodeSession } from '../web/code-bridge-store.js'
import { tryHandleCode } from '../web/routes/code.js'

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

beforeEach(() => {
  initDatabase(':memory:')
  resetCodeBridgeTablesForTests()
  upsertCodeSession({ project: 'marvin', workspacePath: 'C:\\ws\\marvin', sessionId: 'aaaaaaaa-0000-4000-8000-000000000001' })
})

describe('Pause / Resume while the whole bridge is off (#923)', () => {
  it('the pause route answers 200 and stores the flag, the resume route clears it', async () => {
    const paused = await call('/api/code/projects/marvin/pause', 'POST', { paused: true })
    expect(paused).toEqual({ status: 200, body: { project: 'marvin', paused: true } })
    expect(getCodeSession('marvin')?.paused).toBe(true)
    const resumed = await call('/api/code/projects/marvin/pause', 'POST', { paused: false })
    expect(resumed.status).toBe(200)
    expect(getCodeSession('marvin')?.paused).toBe(false)
  })

  it('the gate itself stays: moving a task is still refused while the bridge is off', async () => {
    const out = await call('/api/code/tasks', 'POST', { project: 'marvin', prompt: 'x' })
    expect(out.status).toBe(503)
  })
})
