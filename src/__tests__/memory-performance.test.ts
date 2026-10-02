import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import {
  initDatabase,
  getDb,
  saveAgentMemory,
  getAgentMemories,
  updateMemory,
  clearMemoryCache,
  getMemoryCacheSize,
  backfillEmbeddings,
} from '../db.js'

// All tests use an in-memory SQLite database so they never touch the real store.
beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
})

beforeEach(() => {
  clearMemoryCache()
})

// ---------------------------------------------------------------------------
// 1. SQLite pragmas
// ---------------------------------------------------------------------------
describe('SQLite performance pragmas', () => {
  it('cache_size is set to -65536 (64 MB)', () => {
    const row = getDb().pragma('cache_size', { simple: true })
    expect(row).toBe(-65536)
  })

  it('synchronous is NORMAL (1)', () => {
    // SQLite reports NORMAL as integer 1.
    const row = getDb().pragma('synchronous', { simple: true })
    expect(row).toBe(1)
  })

  // journal_mode and mmap_size cannot be verified on :memory: databases:
  // - WAL is silently downgraded to 'memory' journal for in-memory DBs.
  // - mmap_size is a no-op without a backing file.
  // Both are applied on the real on-disk DB; here we only test the pragmas
  // that behave identically regardless of the storage path.
})

// ---------------------------------------------------------------------------
// 2. In-process TTL cache
// ---------------------------------------------------------------------------
describe('getAgentMemories in-process cache', () => {
  const AGENT = 'cache-test-agent'

  it('cold miss: returns data from DB, cache is populated', () => {
    saveAgentMemory(AGENT, 'First memory', 'warm', 'keyword1')
    const before = getMemoryCacheSize()
    getAgentMemories(AGENT, 5)
    expect(getMemoryCacheSize()).toBe(before + 1)
  })

  it('warm hit: second call returns same object from cache (no DB round-trip)', () => {
    saveAgentMemory(AGENT, 'Cache hit check', 'warm', 'keyword2')
    const first = getAgentMemories(AGENT, 5)
    const second = getAgentMemories(AGENT, 5)
    // Same array reference means the cache was hit.
    expect(second).toBe(first)
  })

  it('cache key is per agentId+limit: different limit = separate entry', () => {
    getAgentMemories(AGENT, 5)
    getAgentMemories(AGENT, 10)
    // Both limit variants should be cached as separate entries.
    expect(getMemoryCacheSize()).toBeGreaterThanOrEqual(2)
  })

  it('saveAgentMemory invalidates the cache for that agent', () => {
    const before = getAgentMemories(AGENT, 5)
    saveAgentMemory(AGENT, 'Invalidation trigger', 'hot', 'new')
    // After write the cache for this agent should be gone.
    expect(getMemoryCacheSize()).toBe(0)
    const after = getAgentMemories(AGENT, 5)
    // Different reference: fresh DB read.
    expect(after).not.toBe(before)
    // New memory must appear.
    expect(after.some(m => m.content === 'Invalidation trigger')).toBe(true)
  })

  it('updateMemory with agentId invalidates the cache', () => {
    const { id } = saveAgentMemory(AGENT, 'Update me', 'warm', 'upd')
    getAgentMemories(AGENT, 5) // warm the cache
    const sizeBefore = getMemoryCacheSize()
    updateMemory(id, 'Updated content', 'warm', AGENT, 'upd')
    expect(getMemoryCacheSize()).toBeLessThan(sizeBefore)
  })

  it('cache is isolated between agents', () => {
    const OTHER = 'other-agent'
    saveAgentMemory(AGENT, 'Agent A memory', 'cold', 'a')
    saveAgentMemory(OTHER, 'Agent B memory', 'cold', 'b')
    getAgentMemories(AGENT, 5)
    getAgentMemories(OTHER, 5)
    const sizeBefore = getMemoryCacheSize()
    // Write to AGENT should not evict OTHER's cache entry.
    saveAgentMemory(AGENT, 'New for agent A', 'hot')
    const sizeAfter = getMemoryCacheSize()
    // At least one entry (OTHER's) should survive.
    expect(sizeAfter).toBeGreaterThan(0)
    expect(sizeAfter).toBeLessThan(sizeBefore)
  })

  it('clearMemoryCache wipes all entries', () => {
    getAgentMemories(AGENT, 5)
    expect(getMemoryCacheSize()).toBeGreaterThan(0)
    clearMemoryCache()
    expect(getMemoryCacheSize()).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 3. Embedding backfill
// ---------------------------------------------------------------------------
describe('backfillEmbeddings', () => {
  // Both cases answer for the embedding server themselves. They used to call
  // whatever was listening on OLLAMA_URL: with no server (CI) that was instant,
  // but on a machine where Ollama is live every memory row saved earlier in
  // this file became a real embedding request, and under the full parallel
  // suite that ran past the timeout -- first at 5s, then, after the limit was
  // raised, at 30s (2026-10-02, twice in a row). A unit test that passes or
  // fails with the load on the host says nothing about the code under test.
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns 0 when Ollama is unreachable, and leaves the rows alone', async () => {
    const fetchMock = vi.fn(async () => { throw new TypeError('fetch failed') })
    vi.stubGlobal('fetch', fetchMock)
    const pending = () => (getDb().prepare('SELECT COUNT(*) AS n FROM memories WHERE embedding IS NULL').get() as { n: number }).n
    const before = pending()
    expect(before).toBeGreaterThan(0)

    expect(await backfillEmbeddings()).toBe(0)
    expect(pending()).toBe(before)
    // The cheap probe answered the question; no row was asked about one by one.
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('processes rows without embeddings and updates them when Ollama responds', async () => {
    const BACKFILL_AGENT = 'backfill-test-agent'
    const db = getDb()
    // Rows left without a vector by the cases above are not this case's
    // subject: give them one, so exactly one candidate remains.
    db.prepare("UPDATE memories SET embedding = '[0]' WHERE embedding IS NULL").run()

    // Insert a memory bypassing saveAgentMemory so embedding stays NULL.
    const now = Math.floor(Date.now() / 1000)
    const result = db.prepare(
      `INSERT INTO memories (chat_id, topic_key, content, sector, salience,
       created_at, accessed_at, agent_id, category, auto_generated, keywords)
       VALUES (?, NULL, ?, 'semantic', 1.0, ?, ?, ?, 'cold', 0, NULL)`
    ).run('test-chat', 'Backfill target content', now, now, BACKFILL_AGENT)
    const id = Number(result.lastInsertRowid)

    const rowBefore = db.prepare('SELECT embedding FROM memories WHERE id = ?').get(id) as { embedding: string | null }
    expect(rowBefore.embedding).toBeNull()

    const VECTOR = [0.25, -0.5, 0.75]
    const prompts: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { body?: string }) => {
      if (String(url).endsWith('/api/tags')) {
        return new Response(JSON.stringify({ models: [{ name: 'nomic-embed-text:latest' }] }), { status: 200 })
      }
      prompts.push(JSON.parse(init?.body ?? '{}').prompt)
      return new Response(JSON.stringify({ embedding: VECTOR }), { status: 200 })
    }))

    expect(await backfillEmbeddings()).toBe(1)
    expect(prompts).toEqual(['Backfill target content'])
    const rowAfter = db.prepare('SELECT embedding FROM memories WHERE id = ?').get(id) as { embedding: string | null }
    expect(JSON.parse(rowAfter.embedding!)).toEqual(VECTOR)
  })
})
