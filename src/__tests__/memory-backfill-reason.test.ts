import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { initDatabase, getDb, clearMemoryCache, runEmbeddingBackfill, EMBED_MODEL } from '../db.js'

// Kanban #134: the "Generate vectors" button used to collapse "nothing to
// vectorize" and "Ollama unreachable" into the same "0 generated" message.
// These tests mock the /api/tags PROBE that now runs before the button ever
// looks at a candidate count, so each reason is reached deterministically --
// none of this depends on a real Ollama instance.
//
// All tests use an in-memory SQLite database so they never touch the real store.
beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
})

beforeEach(() => {
  clearMemoryCache()
  getDb().exec('DELETE FROM memories')
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function insertMemoryWithoutEmbedding(content: string): number {
  const db = getDb()
  const now = Math.floor(Date.now() / 1000)
  const result = db.prepare(
    `INSERT INTO memories (chat_id, topic_key, content, sector, salience,
     created_at, accessed_at, agent_id, category, auto_generated, keywords)
     VALUES (?, NULL, ?, 'semantic', 1.0, ?, ?, ?, 'cold', 0, NULL)`
  ).run('test-chat', content, now, now, 'backfill-reason-test-agent')
  return Number(result.lastInsertRowid)
}

describe('runEmbeddingBackfill reasons', () => {
  it('reason=unreachable when the probe request throws', async () => {
    insertMemoryWithoutEmbedding('needs a vector')
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED') }))

    const result = await runEmbeddingBackfill()

    expect(result.reason).toBe('unreachable')
    expect(result.detail).toContain('ECONNREFUSED')
    expect(result.done).toBe(0)
  })

  it('reason=unreachable when the probe answers a non-200 status', async () => {
    insertMemoryWithoutEmbedding('needs a vector')
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })))

    const result = await runEmbeddingBackfill()

    expect(result.reason).toBe('unreachable')
  })

  it('reason=model_missing when the server answers but lacks the embed model', async () => {
    insertMemoryWithoutEmbedding('needs a vector')
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/api/tags')) {
        return { ok: true, json: async () => ({ models: [{ name: 'llama3:latest' }] }) }
      }
      throw new Error('should not reach /api/embeddings without the model')
    }))

    const result = await runEmbeddingBackfill()

    expect(result.reason).toBe('model_missing')
    expect(result.done).toBe(0)
  })

  it('reason=nothing_to_do when the probe is healthy and no memory needs a vector', async () => {
    // No rows inserted -- every memory (zero of them) already has a vector.
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/api/tags')) {
        return { ok: true, json: async () => ({ models: [{ name: `${EMBED_MODEL}:latest` }] }) }
      }
      throw new Error('should not reach /api/embeddings with zero candidates')
    }))

    const result = await runEmbeddingBackfill()

    expect(result.reason).toBe('nothing_to_do')
    expect(result.candidates).toBe(0)
    expect(result.done).toBe(0)
  })

  it('reason=partial when some embeddings succeed and some fail', async () => {
    insertMemoryWithoutEmbedding('memory one')
    insertMemoryWithoutEmbedding('memory two')
    let embedCalls = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/api/tags')) {
        return { ok: true, json: async () => ({ models: [{ name: `${EMBED_MODEL}:latest` }] }) }
      }
      embedCalls++
      if (embedCalls === 1) return { ok: true, json: async () => ({ embedding: [0.1, 0.2, 0.3] }) }
      return { ok: true, json: async () => ({}) } // no embedding field -> failure
    }))

    const result = await runEmbeddingBackfill()

    expect(result.reason).toBe('partial')
    expect(result.done).toBe(1)
    expect(result.failed).toBe(1)
  }, 15_000)

  it('reason=all_failed when the probe is healthy but every embedding call fails', async () => {
    insertMemoryWithoutEmbedding('memory one')
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/api/tags')) {
        return { ok: true, json: async () => ({ models: [{ name: `${EMBED_MODEL}:latest` }] }) }
      }
      return { ok: true, json: async () => ({}) } // no embedding field -> failure
    }))

    const result = await runEmbeddingBackfill()

    expect(result.reason).toBe('all_failed')
    expect(result.done).toBe(0)
    expect(result.candidates).toBe(1)
  }, 15_000)

  it('reason=ok when every embedding call succeeds', async () => {
    insertMemoryWithoutEmbedding('memory one')
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/api/tags')) {
        return { ok: true, json: async () => ({ models: [{ name: `${EMBED_MODEL}:latest` }] }) }
      }
      return { ok: true, json: async () => ({ embedding: [0.1, 0.2, 0.3] }) }
    }))

    const result = await runEmbeddingBackfill()

    expect(result.reason).toBe('ok')
    expect(result.done).toBe(1)
    expect(result.failed).toBe(0)
  }, 15_000)
})
