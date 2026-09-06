/**
 * Kanban #134 -- the "Generate vectors" button must say WHY nothing happened.
 *
 * Before this, `backfillEmbeddings()` returned a bare number, and the dashboard
 * turned every zero into "Ollama is not reachable". Measured 2026-09-06 on the
 * live install: Ollama answered in 3 ms and 0 of 590 memories were missing a
 * vector -- the healthiest possible outcome, reported as an outage.
 *
 * These tests pin the two things that made that possible:
 *   (a) the reason comes from ASKING the server (status + body), never from the
 *       number of results, and
 *   (b) the model name lives in ONE place (EMBED_MODEL), so a fork that changes
 *       it does not end up advising the wrong `ollama pull`.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  initDatabase,
  getDb,
  clearMemoryCache,
  generateEmbeddingDetailed,
  runEmbeddingBackfill,
  probeEmbeddingTarget,
  backfillEmbeddings,
  embeddingTargetIsRemote,
  EMBED_MODEL,
} from '../db.js'
import { OLLAMA_EMBED_FAILFAST, TOOL_TIMEOUTS } from '../tool-timeouts.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const read = (rel: string) => readFileSync(join(__dirname, '../../', rel), 'utf-8')
const APP = read('web/app.js')
const HU = read('web/lang/hu.js')
const EN = read('web/lang/en.js')
const MEMROUTE = read('src/web/routes/memories.ts')

const realFetch = globalThis.fetch

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
})

beforeEach(() => {
  clearMemoryCache()
  getDb().prepare('DELETE FROM memories').run()
})

afterEach(() => {
  globalThis.fetch = realFetch
  vi.restoreAllMocks()
})

/** Insert straight into the table: saveAgentMemory() fires its own embedding
 *  request, which would race the stubbed fetch these tests count calls on. */
function addMemory(content: string, withVector = false): number {
  const now = Math.floor(Date.now() / 1000)
  const info = getDb().prepare(
    'INSERT INTO memories (chat_id, content, sector, salience, created_at, accessed_at, agent_id, category, auto_generated, keywords, embedding) VALUES (?, ?, ?, 1.0, ?, ?, ?, ?, 0, NULL, ?)'
  ).run('test-chat', content, 'semantic', now, now, 'agent-a', 'warm', withVector ? JSON.stringify([0.1, 0.2]) : null)
  return Number(info.lastInsertRowid)
}

function stubFetch(impl: (input?: unknown) => Promise<Response> | Response) {
  const spy = vi.fn(impl)
  globalThis.fetch = spy as unknown as typeof fetch
  return spy
}

const okEmbedding = () => new Response(JSON.stringify({ embedding: [0.1, 0.2, 0.3] }), { status: 200 })
const isProbe = (input: unknown) => String(input).includes('/api/tags')
/** A server that is up and HAS the model: the probe passes, the embedding
 *  requests behave as the test wants. */
const healthyProbe = (embed: () => Promise<Response> | Response) => (input?: unknown) =>
  isProbe(input) ? new Response(JSON.stringify({ models: [{ name: `${EMBED_MODEL}:latest` }] }), { status: 200 }) : embed()

// ---------------------------------------------------------------------------
// 1. The reason is READ from the answer, not guessed from the outcome
// ---------------------------------------------------------------------------
describe('generateEmbeddingDetailed reads the reason from the response', () => {
  it('a thrown fetch is "unreachable", and keeps the original message', async () => {
    stubFetch(() => { throw new Error('connect ECONNREFUSED 127.0.0.1:11434') })
    const attempt = await generateEmbeddingDetailed('hello')
    expect(attempt.embedding).toBeNull()
    expect(attempt.reason).toBe('unreachable')
    expect(attempt.detail).toContain('ECONNREFUSED')
  })

  it('a 404 "try pulling it first" is "model_missing", NOT unreachable', async () => {
    stubFetch(() => new Response(`model '${EMBED_MODEL}' not found, try pulling it first`, { status: 404 }))
    const attempt = await generateEmbeddingDetailed('hello')
    expect(attempt.reason).toBe('model_missing')
  })

  it('a 500 with an unrelated body is "error" -- not blamed on the model', async () => {
    stubFetch(() => new Response('internal server explosion', { status: 500 }))
    const attempt = await generateEmbeddingDetailed('hello')
    expect(attempt.reason).toBe('error')
    expect(attempt.detail).toContain('explosion')
  })

  it('a 200 with an EMPTY embedding is an error, not a success', async () => {
    stubFetch(() => new Response(JSON.stringify({ embedding: [] }), { status: 200 }))
    const attempt = await generateEmbeddingDetailed('hello')
    expect(attempt.embedding).toBeNull()
    expect(attempt.reason).toBe('error')
  })

  it('asks for EMBED_MODEL by name -- the constant is the only source', async () => {
    const spy = stubFetch(okEmbedding)
    await generateEmbeddingDetailed('hello')
    const body = JSON.parse((spy.mock.calls[0][1] as RequestInit).body as string)
    expect(body.model).toBe(EMBED_MODEL)
  })
})

// ---------------------------------------------------------------------------
// 2. The two meanings of zero
// ---------------------------------------------------------------------------
describe('runEmbeddingBackfill tells the two zeros apart', () => {
  it('no memories at all -> no_memories (fresh install, healthy)', async () => {
    const spy = stubFetch(okEmbedding)
    const r = await runEmbeddingBackfill()
    expect(r).toMatchObject({ total: 0, candidates: 0, done: 0, failed: 0, reason: 'no_memories' })
    // Nothing to embed means nothing was asked -- the reason came from the DB.
    expect(spy).not.toHaveBeenCalled()
  })

  it('every memory already has a vector -> nothing_to_do (healthy), never unreachable', async () => {
    addMemory('already vectorised', true)
    addMemory('also done', true)
    const spy = stubFetch(() => { throw new Error('server is down') })
    const r = await runEmbeddingBackfill()
    expect(r).toMatchObject({ total: 2, candidates: 0, done: 0, failed: 0, reason: 'nothing_to_do' })
    // The live 2026-09-06 bug: a healthy zero reported as an outage.
    expect(r.reason).not.toBe('unreachable')
    expect(spy).not.toHaveBeenCalled()
  })

  it('candidates + a working server -> ok, and the vectors land in the rows', async () => {
    addMemory('needs a vector')
    addMemory('this one too')
    stubFetch(healthyProbe(okEmbedding))
    const r = await runEmbeddingBackfill()
    expect(r).toMatchObject({ candidates: 2, done: 2, failed: 0, reason: 'ok' })
    const left = getDb().prepare('SELECT COUNT(*) AS n FROM memories WHERE embedding IS NULL').get() as { n: number }
    expect(left.n).toBe(0)
  })

  it('a server that dies MID-RUN gives up after the fail-fast streak', async () => {
    // The probe cannot catch this one: the server was there when asked.
    for (let i = 0; i < 20; i++) addMemory(`memory ${i}`)
    const spy = stubFetch(healthyProbe(() => { throw new Error('connect ECONNREFUSED') }))
    const r = await runEmbeddingBackfill()
    expect(r.reason).toBe('unreachable')
    expect(r.candidates).toBe(20)
    expect(r.done).toBe(0)
    expect(r.failed).toBe(OLLAMA_EMBED_FAILFAST)
    // Without the fail-fast this loop would ask 20 times for an answer it
    // already has -- hours of waiting on a server that is no longer there.
    expect(spy).toHaveBeenCalledTimes(OLLAMA_EMBED_FAILFAST + 1) // + the probe
  })

  it('a model deleted MID-RUN is still model_missing (a one-command fix)', async () => {
    for (let i = 0; i < 5; i++) addMemory(`memory ${i}`)
    stubFetch(healthyProbe(() => new Response('model not found, try pulling it first', { status: 404 })))
    const r = await runEmbeddingBackfill()
    expect(r.reason).toBe('model_missing')
    expect(r.detail).toContain('pulling')
  })

  it('reports partial progress: what succeeded stays, and the reason is still told', async () => {
    for (let i = 0; i < 6; i++) addMemory(`memory ${i}`)
    let n = 0
    stubFetch(healthyProbe(() => {
      n++
      if (n <= 2) return okEmbedding()
      throw new Error('connect ECONNREFUSED')
    }))
    const seen: Array<[number, number]> = []
    const r = await runEmbeddingBackfill((done, candidates) => { seen.push([done, candidates]) })
    expect(r.done).toBe(2)
    expect(r.failed).toBe(OLLAMA_EMBED_FAILFAST)
    expect(r.reason).toBe('unreachable')
    expect(seen).toEqual([[1, 6], [2, 6]])
    const left = getDb().prepare('SELECT COUNT(*) AS n FROM memories WHERE embedding IS NULL').get() as { n: number }
    expect(left.n).toBe(4)
  })

  it('names the target and the model it asked, so the message never re-types them', async () => {
    addMemory('needs a vector')
    stubFetch(healthyProbe(okEmbedding))
    const r = await runEmbeddingBackfill()
    expect(r.model).toBe(EMBED_MODEL)
    expect(typeof r.target).toBe('string')
    expect(r.remote).toBe(embeddingTargetIsRemote(r.target))
  })
})

// ---------------------------------------------------------------------------
// 3. Fork-friendliness: the old signature survives
// ---------------------------------------------------------------------------
describe('backfillEmbeddings keeps its pre-#134 shape', () => {
  it('still resolves to a plain number of embedded memories', async () => {
    addMemory('one')
    addMemory('two')
    stubFetch(healthyProbe(okEmbedding))
    const n = await backfillEmbeddings()
    expect(typeof n).toBe('number')
    expect(n).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// 4. The model name has exactly ONE source
// ---------------------------------------------------------------------------
describe('the model name is never re-typed outside EMBED_MODEL', () => {
  it('neither translation file hardcodes it in the backfill messages', () => {
    // Scope: the messages this button produces. `wizard.item.ollama_step2`
    // still spells the model out in both locales -- it is a static wizard
    // step with no parameters, so fixing it needs EMBED_MODEL exposed to the
    // browser. Named here so it stays visible instead of being forgotten.
    for (const [name, src] of [['hu.js', HU], ['en.js', EN]] as const) {
      const lines = src.split('\n').filter(l => l.includes('memories.toast.vector_'))
      expect(lines.length, `${name} has no vector_* messages`).toBeGreaterThan(5)
      for (const line of lines) {
        expect(line, `${name} re-types the model name`).not.toContain(EMBED_MODEL)
      }
      expect(lines.join('\n')).toContain('{model}')
    }
  })

  it('app.js feeds the placeholder from the status, not from a literal', () => {
    expect(APP).not.toContain(EMBED_MODEL)
    expect(APP).toMatch(/model:\s*\(st && st\.model\)/)
  })
})

// ---------------------------------------------------------------------------
// 5. The long run cannot die of a request timeout any more
// ---------------------------------------------------------------------------
describe('the backfill request only starts the job', () => {
  it('POST returns the job status immediately; a separate GET polls it', () => {
    expect(MEMROUTE).toContain("'/api/memories/backfill'")
    expect(MEMROUTE).toContain("'/api/memories/backfill/status'")
    expect(MEMROUTE).toContain('startEmbeddingBackfill()')
    expect(MEMROUTE).toContain('getEmbeddingBackfillStatus()')
    // The whole point: the handler must not await the run (2m29s browser cut-off).
    expect(MEMROUTE).not.toMatch(/await\s+(runEmbeddingBackfill|backfillEmbeddings)\s*\(/)
  })

  it('the browser polls the status endpoint instead of holding one request open', () => {
    expect(APP).toContain('/api/memories/backfill/status')
    expect(APP).toContain('_memBackfillPoll')
  })
})

// ---------------------------------------------------------------------------
// 6. The cheap question comes first (kanban 11da9dcb)
// ---------------------------------------------------------------------------
const tags = (names: string[]) =>
  new Response(JSON.stringify({ models: names.map(name => ({ name })) }), { status: 200 })

describe('probeEmbeddingTarget asks before the expensive loop', () => {
  it('a thrown request is unreachable, with the failing side own message', async () => {
    stubFetch(() => { throw new Error('connect ECONNREFUSED 127.0.0.1:11434') })
    const p = await probeEmbeddingTarget()
    expect(p).toMatchObject({ ok: false, reason: 'unreachable' })
    expect((p as { detail: string }).detail).toContain('ECONNREFUSED')
  })

  it('the model is found even when the server spells it with a tag', async () => {
    stubFetch(() => tags(['llama3:8b', `${EMBED_MODEL}:latest`]))
    expect(await probeEmbeddingTarget()).toEqual({ ok: true })
  })

  it('a server without the model is model_missing, and says how many it has', async () => {
    stubFetch(() => tags(['llama3:8b']))
    const p = await probeEmbeddingTarget()
    expect(p).toMatchObject({ ok: false, reason: 'model_missing' })
    expect((p as { detail: string }).detail).toContain(EMBED_MODEL)
  })

  it('an answer it cannot read is "unknown" -- NOT a missing model', async () => {
    // A proxy, a different server, a future Ollama: this code has no business
    // claiming the model is absent when it cannot see the list at all.
    stubFetch(() => new Response(JSON.stringify({ something: 'else' }), { status: 200 }))
    expect(await probeEmbeddingTarget()).toMatchObject({ ok: 'unknown' })
    stubFetch(() => new Response('not json at all', { status: 200 }))
    expect(await probeEmbeddingTarget()).toMatchObject({ ok: 'unknown' })
  })

  it('asks on the CHEAP deadline, not the 90s embedding one', async () => {
    const spy = stubFetch(() => tags([EMBED_MODEL]))
    await probeEmbeddingTarget()
    const init = spy.mock.calls[0][1] as RequestInit
    expect(String(spy.mock.calls[0][0])).toContain('/api/tags')
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(TOOL_TIMEOUTS['ollama-probe']).toBeLessThan(TOOL_TIMEOUTS['ollama-embedding'])
  })
})

describe('the backfill run uses the probe as its first question', () => {
  it('a dead server is reported WITHOUT spending a single embedding request', async () => {
    for (let i = 0; i < 20; i++) addMemory(`memory ${i}`)
    const spy = stubFetch(() => { throw new Error('connect ECONNREFUSED') })
    const r = await runEmbeddingBackfill()
    expect(r.reason).toBe('unreachable')
    expect(r.candidates).toBe(20)
    expect(r.failed).toBe(0)
    // One probe, and nothing else: before this, the same verdict cost
    // OLLAMA_EMBED_FAILFAST embedding attempts on the 90s deadline.
    expect(spy).toHaveBeenCalledTimes(1)
    expect(String(spy.mock.calls[0][0])).toContain('/api/tags')
  })

  it('a missing model is reported from the probe, before any embedding request', async () => {
    addMemory('needs a vector')
    const spy = stubFetch(() => tags(['llama3:8b']))
    const r = await runEmbeddingBackfill()
    expect(r.reason).toBe('model_missing')
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('a healthy probe lets the run through', async () => {
    addMemory('needs a vector')
    stubFetch(req => (String(req).includes('/api/tags') ? tags([EMBED_MODEL]) : okEmbedding()))
    const r = await runEmbeddingBackfill()
    expect(r).toMatchObject({ done: 1, failed: 0, reason: 'ok' })
  })

  it('an unreadable probe does NOT decide -- the embedding request does', async () => {
    addMemory('needs a vector')
    const spy = stubFetch(req =>
      String(req).includes('/api/tags')
        ? new Response(JSON.stringify({ something: 'else' }), { status: 200 })
        : new Response('model not found, try pulling it first', { status: 404 }))
    const r = await runEmbeddingBackfill()
    // The verdict comes from the side that actually refused the work.
    expect(r.reason).toBe('model_missing')
    expect(r.detail).toContain('pulling')
    expect(spy.mock.calls.length).toBeGreaterThan(1)
  })

  it('nothing to do means nothing is asked -- not even the probe', async () => {
    addMemory('already vectorised', true)
    const spy = stubFetch(() => { throw new Error('server is down') })
    const r = await runEmbeddingBackfill()
    expect(r.reason).toBe('nothing_to_do')
    // A stopped Ollama must not turn a healthy install into a warning.
    expect(spy).not.toHaveBeenCalled()
  })
})
