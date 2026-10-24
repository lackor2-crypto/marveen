// #776: do not send the embedding server a request unless it is needed.
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest'
import { initDatabase, saveAgentMemory, saveMemory, hybridSearch, getDb, HYBRID_FTS_ENOUGH } from '../db.js'
import {
  guardStep, newGuardState,
  OLLAMA_GUARD_DEAD_MS, OLLAMA_GUARD_COOLDOWN_MS, OLLAMA_GUARD_MAX_RESTARTS,
} from '../ollama-guard.js'

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
