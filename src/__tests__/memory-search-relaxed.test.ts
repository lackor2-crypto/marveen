/**
 * #413 (rebuilt from upstream eb33ee35 + e9dba111): FTS5 reads a space between
 * terms as AND, so a naturally phrased question needed every word in one
 * memory -- "meddig tart a felmondasi ido" found nothing while "felmondasi ido"
 * found the right memory. Now an empty strict search retries with OR, and the
 * answer says it was relaxed (header + dashboard sentence).
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { initDatabase, getDb, clearMemoryCache, saveAgentMemory, searchAgentMemories, searchMemories, lastSearchRelaxed, buildFtsMatchExpression } from '../db.js'
import { tryHandleMemories } from '../web/routes/memories.js'
import type { RouteContext } from '../web/routes/types.js'

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return { ...actual, MAIN_AGENT_ID: 'agent-a', ALLOWED_CHAT_ID: 'test-chat', OLLAMA_URL: '' }
})
vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }))

async function get(params: Record<string, string>) {
  const url = new URL('http://localhost:3420/api/memories')
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  let body = ''
  const headers: Record<string, string> = {}
  const res = { writeHead: vi.fn(), setHeader: (k: string, v: string) => { headers[k.toLowerCase()] = v }, end: (b?: string) => { body = b || '' } }
  await tryHandleMemories({ req: { headers: {} } as any, res: res as any, path: '/api/memories', method: 'GET', url } as RouteContext)
  return { body: body ? JSON.parse(body) : null, headers }
}

beforeAll(() => { process.env.NODE_ENV = 'test'; initDatabase(':memory:') })
beforeEach(() => {
  clearMemoryCache()
  getDb().prepare('DELETE FROM memories').run()
  saveAgentMemory('agent-a', 'A felmondási idő a szerződés szerint 30 nap.', 'warm', 'felmondas')
})

describe('relaxed memory search (#413)', () => {
  it('the OR expression is only built on request; the default stays AND', () => {
    expect(buildFtsMatchExpression('alpha beta')).toBe('alpha* beta*')
    expect(buildFtsMatchExpression('alpha beta', 'or')).toBe('alpha* OR beta*')
  })

  it('a natural question with an extra word finds the memory, flagged as relaxed', () => {
    const r = searchAgentMemories('agent-a', 'meddig tart a felmondási idő')
    expect(r.map((m) => m.content)).toContain('A felmondási idő a szerződés szerint 30 nap.')
    expect(lastSearchRelaxed()).toBe(true)
  })

  it('a strict hit is NOT relaxed', () => {
    expect(searchAgentMemories('agent-a', 'felmondási idő').length).toBe(1)
    expect(lastSearchRelaxed()).toBe(false)
  })

  it('a single word never relaxes (nothing to loosen)', () => {
    expect(searchAgentMemories('agent-a', 'nincsilyenszo')).toEqual([])
    expect(lastSearchRelaxed()).toBe(false)
  })

  it('the chat-wide search relaxes too', () => {
    getDb().prepare("UPDATE memories SET chat_id = 'test-chat'").run()
    expect(searchMemories('meddig tart a felmondási idő', 'test-chat', 5).length).toBe(1)
    expect(lastSearchRelaxed()).toBe(true)
  })

  it('the API says it in a header; the body stays a bare array', async () => {
    const relaxed = await get({ agent: 'agent-a', q: 'meddig tart a felmondási idő', mode: 'fts' })
    expect(Array.isArray(relaxed.body)).toBe(true)
    expect(relaxed.body.length).toBe(1)
    expect(relaxed.headers['x-search-relaxed']).toBe('1')
    const strict = await get({ agent: 'agent-a', q: 'felmondási idő', mode: 'fts' })
    expect(strict.headers['x-search-relaxed']).toBeUndefined()
    const hybrid = await get({ agent: 'agent-a', q: 'meddig tart a felmondási idő', mode: 'hybrid' })
    expect(hybrid.headers['x-search-relaxed']).toBe('1')
  })

  it('the Memory page shows the sentence, in both languages', () => {
    const app = readFileSync(join(process.cwd(), 'web', 'app.js'), 'utf8')
    expect(app).toContain("res.headers.get('X-Search-Relaxed') === '1'")
    for (const f of ['hu.js', 'en.js']) expect(readFileSync(join(process.cwd(), 'web', 'lang', f), 'utf8')).toContain("'mem.search_relaxed'")
  })
})
