// #776: do not send the embedding server a request unless it is needed.
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest'
import { initDatabase, saveAgentMemory, saveMemory, hybridSearch, getDb, HYBRID_FTS_ENOUGH } from '../db.js'
import {
  guardStep, newGuardState, guardFalseAlarm, confirmOutOfProcess,
  OLLAMA_GUARD_DEAD_MS, OLLAMA_GUARD_COOLDOWN_MS, OLLAMA_GUARD_MAX_RESTARTS,
} from '../ollama-guard.js'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
})

afterEach(() => { vi.unstubAllGlobals() })

function stubFetch() {
  const calls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push(String(url))
    return new Response(JSON.stringify({ embedding: [0.1, 0.2] }), { status: 200 })
  }))
  return calls
}

describe('saving a memory does not call the embedding server', () => {
  it('saveAgentMemory and saveMemory leave embedding NULL and send no request', async () => {
    const calls = stubFetch()
    const { id } = saveAgentMemory('thrift-agent', 'quiet content', 'warm', 'quiet')
    saveMemory('chat', 'digest content', 'episodic')
    await new Promise((r) => setTimeout(r, 20))
    expect(calls).toEqual([])
    const row = getDb().prepare('SELECT embedding FROM memories WHERE id = ?').get(id) as { embedding: string | null }
    expect(row.embedding).toBeNull()
  })
})

describe('hybridSearch asks for a query vector only when keyword search is thin', () => {
  it('enough FTS hits: no embedding request', async () => {
    for (let i = 0; i < HYBRID_FTS_ENOUGH; i++) saveAgentMemory('thrift-fts', `zebrafinch note ${i}`, 'warm', 'zebrafinch')
    const calls = stubFetch()
    const res = await hybridSearch('thrift-fts', 'zebrafinch', 10, {})
    expect(res.length).toBeGreaterThanOrEqual(HYBRID_FTS_ENOUGH)
    expect(calls).toEqual([])
  })

  it('too few FTS hits: one embedding request', async () => {
    saveAgentMemory('thrift-thin', 'a lone quokka note', 'warm', 'quokka')
    const calls = stubFetch()
    await hybridSearch('thrift-thin', 'quokka', 10)
    expect(calls.filter((u) => u.endsWith('/api/embeddings'))).toHaveLength(1)
  })
})

describe('guardStep', () => {
  it('waits while the silence is shorter than the dead threshold', () => {
    const s = newGuardState(0)
    expect(guardStep(s, false, OLLAMA_GUARD_DEAD_MS - 1)).toBe('wait')
  })

  it('restarts once after the threshold, then cools down', () => {
    const s = newGuardState(0)
    expect(guardStep(s, false, OLLAMA_GUARD_DEAD_MS)).toBe('restart')
    expect(guardStep(s, false, OLLAMA_GUARD_DEAD_MS + 1000)).toBe('cooldown')
  })

  it('an answer resets the silence clock', () => {
    const s = newGuardState(0)
    expect(guardStep(s, true, 25_000)).toBe('ok')
    expect(guardStep(s, false, 25_000 + OLLAMA_GUARD_DEAD_MS - 1)).toBe('wait')
  })

  it('gives up after the hourly restart cap and recovers on an answer', () => {
    const s = newGuardState(0)
    let t = OLLAMA_GUARD_DEAD_MS
    for (let i = 0; i < OLLAMA_GUARD_MAX_RESTARTS; i++) {
      expect(guardStep(s, false, t)).toBe('restart')
      t += OLLAMA_GUARD_COOLDOWN_MS
    }
    expect(guardStep(s, false, t)).toBe('give-up')
    expect(s.gaveUp).toBe(true)
    expect(guardStep(s, true, t + 1)).toBe('ok')
    expect(s.gaveUp).toBe(false)
  })
})

describe('guardStep: give-up is reported once', () => {
  it('a second silent poll after giving up is a quiet cooldown, not another give-up', () => {
    const s = newGuardState(0)
    let t = OLLAMA_GUARD_DEAD_MS
    for (let i = 0; i < OLLAMA_GUARD_MAX_RESTARTS; i++) {
      guardStep(s, false, t)
      t += OLLAMA_GUARD_COOLDOWN_MS
    }
    expect(guardStep(s, false, t)).toBe('give-up')
    expect(guardStep(s, false, t + 10_000)).toBe('cooldown')
    expect(guardStep(s, false, t + 20_000)).toBe('cooldown')
  })
})

describe('guardFalseAlarm', () => {
  it('takes the restart back: no cooldown, not counted, silence clock restarted', () => {
    const s = newGuardState(0)
    expect(guardStep(s, false, OLLAMA_GUARD_DEAD_MS)).toBe('restart')
    guardFalseAlarm(s, OLLAMA_GUARD_DEAD_MS)
    expect(s.restarts).toEqual([])
    expect(s.quietUntil).toBe(0)
    expect(guardStep(s, false, OLLAMA_GUARD_DEAD_MS + 1000)).toBe('wait')
    expect(guardStep(s, false, 2 * OLLAMA_GUARD_DEAD_MS)).toBe('restart')
  })
})

// 2026-10-25: the dashboard's own stalled event loop made a healthy Ollama look
// silent. The confirmation probe runs in its own process and must see it answer.
describe('confirmOutOfProcess', () => {
  let server: ChildProcess | null = null
  afterEach(() => { server?.kill(); server = null })

  function startServer(code: string): Promise<string> {
    return new Promise((resolve, reject) => {
      server = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'inherit'] })
      server.stdout!.once('data', (b) => resolve(`http://127.0.0.1:${String(b).trim()}`))
      server.once('error', reject)
    })
  }
  const answering = 'const s=require("http").createServer((q,r)=>r.end("{}"));s.listen(0,"127.0.0.1",()=>console.log(s.address().port))'
  const hanging = 'const s=require("http").createServer(()=>{});s.listen(0,"127.0.0.1",()=>console.log(s.address().port))'

  it('answered, even while this process\'s event loop is blocked longer than the probe timeout', async () => {
    const url = await startServer(answering)
    const p = confirmOutOfProcess(url, 1000)
    const until = Date.now() + 2500
    while (Date.now() < until) { /* block the event loop, as the stalled dashboard did */ }
    expect(await p).toBe('answered')
  }, 15_000)

  it('silent when the server accepts but never answers', async () => {
    const url = await startServer(hanging)
    expect(await confirmOutOfProcess(url, 500)).toBe('silent')
  }, 15_000)

  it('silent when nothing listens on the port', async () => {
    const port = await new Promise<number>((resolve) => {
      const s = createServer().listen(0, '127.0.0.1', () => {
        const p = (s.address() as { port: number }).port
        s.close(() => resolve(p))
      })
    })
    expect(await confirmOutOfProcess(`http://127.0.0.1:${port}`, 500)).toBe('silent')
  }, 15_000)
})
