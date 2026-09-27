/** Local route-level companion of the upstream memory-offset-paging test (kept byte-identical).
 * #413 (upstream 09a4712e, rebuilt here): GET /api/memories capped limit at 200
 * and never read `offset`, so every page past the first returned the same rows,
 * and the dashboard's Memory page showed the 50 most recent of 1249 with no way
 * to see the rest. Now the plain listing pages; a search does not (it ranks by
 * relevance, an SQL OFFSET would page over a different order) and says so.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { initDatabase, getDb, clearMemoryCache, getAgentMemories } from '../db.js'
import { tryHandleMemories } from '../web/routes/memories.js'
import type { RouteContext } from '../web/routes/types.js'

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return { ...actual, MAIN_AGENT_ID: 'agent-a', ALLOWED_CHAT_ID: 'test-chat', OLLAMA_URL: '' }
})
vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }))

async function get(params: Record<string, string>): Promise<{ status: number; body: any }> {
  const url = new URL('http://localhost:3420/api/memories')
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  let body = ''
  let status = 200
  const res = { writeHead: (s: number) => { status = s }, setHeader: vi.fn(), end: (b?: string) => { body = b || '' } }
  await tryHandleMemories({ req: { headers: {} } as any, res: res as any, path: '/api/memories', method: 'GET', url } as RouteContext)
  return { status, body: body ? JSON.parse(body) : null }
}

/** N rows on ONE accessed_at second: the tie that made LIMIT/OFFSET unstable. */
function seed(n: number, agent = 'agent-a', category = 'warm') {
  const t = 1_700_000_000
  const ins = getDb().prepare("INSERT INTO memories (chat_id, agent_id, content, category, sector, keywords, created_at, accessed_at, salience) VALUES (?, ?, ?, ?, 'semantic', ?, ?, ?, 1)")
  for (let i = 0; i < n; i++) ins.run('test-chat', agent, `m${i}`, category, '', t, t)
}

beforeAll(() => { process.env.NODE_ENV = 'test'; initDatabase(':memory:') })
beforeEach(() => { clearMemoryCache(); getDb().prepare('DELETE FROM memories').run() })

async function pageAll(params: Record<string, string>, limit = 50): Promise<number[]> {
  const ids: number[] = []
  for (let offset = 0; offset < 10_000; offset += limit) {
    const r = await get({ ...params, limit: String(limit), offset: String(offset) })
    expect(r.status).toBe(200)
    ids.push(...r.body.map((m: any) => m.id))
    if (r.body.length < limit) break
  }
  return ids
}

describe('memory listing pages (#413)', () => {
  it('an agent listing pages through every memory exactly once, even on one shared second', async () => {
    seed(237)
    const ids = await pageAll({ agent: 'agent-a' })
    expect(ids.length).toBe(237)
    expect(new Set(ids).size).toBe(237)
  })

  it('the listing without an agent pages too (the dashboard default)', async () => {
    seed(120)
    const ids = await pageAll({})
    expect(new Set(ids).size).toBe(120)
  })

  it('a tier listing pages over that tier only', async () => {
    seed(70, 'agent-a', 'warm')
    seed(30, 'agent-a', 'cold')
    expect(new Set(await pageAll({ agent: 'agent-a', tier: 'cold' }, 20)).size).toBe(30)
    expect(new Set(await pageAll({ tier: 'warm' }, 20)).size).toBe(70)
  })

  it('the cache key carries the offset: page 2 is not page 1 from the cache', () => {
    seed(30)
    const p1 = getAgentMemories('agent-a', 10, undefined, 0).map((m) => m.id)
    const p2 = getAgentMemories('agent-a', 10, undefined, 10).map((m) => m.id)
    expect(p2.some((id) => p1.includes(id))).toBe(false)
  })

  it('offset with a search is refused out loud (400 + sentence), not ignored', async () => {
    seed(5)
    const r = await get({ agent: 'agent-a', q: 'm1', offset: '10' })
    expect(r.status).toBe(400)
    expect(r.body.error).toBe('offset_with_search')
    expect(r.body.message).toBeTruthy()
    expect((await get({ offset: '-3' })).status).toBe(400)
  })

  it('the Memory page offers "load more" on the plain list and both languages have it', () => {
    const app = readFileSync(join(process.cwd(), 'web', 'app.js'), 'utf8')
    expect(app).toMatch(/async function loadMoreMemories\(\)/)
    expect(app).toMatch(/params\.set\('offset', String\(_memNextOffset\)\)/)
    for (const f of ['hu.js', 'en.js']) expect(readFileSync(join(process.cwd(), 'web', 'lang', f), 'utf8')).toContain("'mem.load_more'")
  })
})
