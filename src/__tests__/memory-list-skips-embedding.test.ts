import { describe, it, expect, beforeAll } from 'vitest'
import { initDatabase, getDb, saveAgentMemory, getAgentMemories, clearMemoryCache } from '../db.js'

// Regression: the listing used SELECT *, so every row's embedding vector (~15 KB of JSON) went through the ORDER BY
// sorter on the event loop (a 2.2 s dashboard stall sample under load). The listing must not read the vector.
beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
})

describe('getAgentMemories leaves the embedding vector out', () => {
  it('returns embedding null even when the row has a vector, keeping every other column', () => {
    const { id } = saveAgentMemory('stall-agent', 'hello stall', 'hot', 'k1, k2')
    getDb().prepare('UPDATE memories SET embedding = ? WHERE id = ?').run(JSON.stringify(new Array(512).fill(0.5)), id)
    clearMemoryCache()
    const rows = getAgentMemories('stall-agent', 20, 'hot')
    expect(rows).toHaveLength(1)
    expect(rows[0].embedding).toBeNull()
    expect(rows[0].content).toBe('hello stall')
    expect(rows[0].keywords).toBe('k1, k2')
    expect(rows[0].category).toBe('hot')
    expect(rows[0].agent_id).toBe('stall-agent')
    expect(typeof rows[0].accessed_at).toBe('number')
    clearMemoryCache()
    expect(getAgentMemories('stall-agent', 20)[0].embedding).toBeNull()
  })
})
