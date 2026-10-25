// #796: every AI text call goes through src/ai-call.ts, so a fix (the #772 402 retry, an error sentence, a timeout) reaches
// every caller. This test keeps new direct calls out, and pins the shared road's own behaviour.
import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { openRouterChat, ollamaGenerate, setAiFetch, affordableTokens, parseEngineOrder, type FetchFn } from '../ai-call.js'

const ROOT = join(__dirname, '..', '..')

function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (name === 'node_modules' || name === '__tests__' || name === 'vendor') continue
    const st = statSync(p)
    if (st.isDirectory()) files(p, out)
    else if (/\.(ts|mjs|js)$/.test(name)) out.push(p)
  }
  return out
}

describe('#796 one road for AI text calls', () => {
  // A plain Node script that cannot import TypeScript; it is the command-line twin of src/debate-run.ts (which is on the road).
  const EXCEPTIONS = new Set(['scripts/debate.mjs'])

  it('no source file outside src/ai-call.ts calls the OpenRouter chat endpoint or the local model directly', () => {
    const offenders: string[] = []
    for (const f of [...files(join(ROOT, 'src')), ...files(join(ROOT, 'scripts'))]) {
      const rel = relative(ROOT, f).replace(/\\/g, '/')
      if (rel === 'src/ai-call.ts' || EXCEPTIONS.has(rel)) continue
      const src = readFileSync(f, 'utf8')
      if (/openrouter\.ai\/api\/v1\/chat\/completions/.test(src) || /\/api\/generate[`'"]/.test(src)) offenders.push(rel)
    }
    expect(offenders).toEqual([])
  })
})

describe('#796 the shared road itself', () => {
  afterEach(() => setAiFetch(null))
  const reply = (status: number, body: unknown) => ({ ok: status < 400, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) })

  it('a 402 "can only afford N" is retried ONCE with that ceiling, and the answer comes back', async () => {
    const sent: unknown[] = []
    const f: FetchFn = async (_u, init) => {
      const body = JSON.parse(init.body) as { max_tokens?: number }
      sent.push(body.max_tokens)
      return sent.length === 1 ? reply(402, { error: { message: 'You requested up to 4000 tokens, but can only afford 1368' } }) : reply(200, { choices: [{ message: { content: ' kész ' } }], usage: { prompt_tokens: 3, completion_tokens: 1 } })
    }
    const r = await openRouterChat({ apiKey: 'k', model: 'm', prompt: 'p', maxTokens: 4000, title: 't', fetch: f })
    expect(r).toMatchObject({ ok: true, text: 'kész', tokensIn: 3, tokensOut: 1 })
    expect(sent).toEqual([4000, 1352])
  })

  it('without a ceiling (the debate) a 402 still gets the affordable one', async () => {
    const sent: unknown[] = []
    setAiFetch(async (_u, init) => { sent.push((JSON.parse(init.body) as { max_tokens?: number }).max_tokens); return sent.length === 1 ? reply(402, 'can only afford 900') : reply(200, { choices: [{ message: { content: 'ok' } }] }) })
    const r = await openRouterChat({ apiKey: 'k', model: 'm', prompt: 'p', title: 't' })
    expect(r.ok).toBe(true)
    expect(sent).toEqual([undefined, 884])
  })

  it('too little credit, a bad key, a busy service and no key: a sentence a person can act on', async () => {
    setAiFetch(async () => reply(402, 'can only afford 100'))
    expect(await openRouterChat({ apiKey: 'k', model: 'm', prompt: 'p', maxTokens: 4000, title: 't', lang: 'hu' })).toMatchObject({ ok: false, code: 'credit', message: expect.stringMatching(/kredit/) })
    setAiFetch(async () => reply(401, { error: { message: 'No auth' } }))
    expect(await openRouterChat({ apiKey: 'k', model: 'm', prompt: 'p', title: 't', lang: 'en' })).toMatchObject({ ok: false, code: 'key', detail: 'No auth' })
    setAiFetch(async () => reply(429, 'slow down'))
    expect(await openRouterChat({ apiKey: 'k', model: 'm', prompt: 'p', title: 't' })).toMatchObject({ ok: false, code: 'busy' })
    expect(await openRouterChat({ apiKey: '', model: 'm', prompt: 'p', title: 't' })).toMatchObject({ ok: false, code: 'nokey' })
  })

  it('the system message and the extra fields go into the request', async () => {
    let body: Record<string, unknown> = {}
    setAiFetch(async (_u, init) => { body = JSON.parse(init.body); return reply(200, { choices: [{ message: { content: 'x' } }] }) })
    await openRouterChat({ apiKey: 'k', model: 'm', system: 'S', prompt: 'P', title: 't', extra: { plugins: [{ id: 'web' }] } })
    expect(body['messages']).toEqual([{ role: 'system', content: 'S' }, { role: 'user', content: 'P' }])
    expect(body['plugins']).toEqual([{ id: 'web' }])
  })

  it('the local model: the answer, or null when it does not answer', async () => {
    setAiFetch(async () => reply(200, { response: '{"tier":"hot"}' }))
    expect(await ollamaGenerate({ model: 'qwen', prompt: 'p' })).toEqual({ text: '{"tier":"hot"}', model: 'qwen' })
    setAiFetch(async () => { throw new Error('ECONNREFUSED') })
    expect(await ollamaGenerate({ model: 'qwen', prompt: 'p' })).toBeNull()
  })

  it('the helpers the translation used are the shared ones', () => {
    expect(affordableTokens('but can only afford 1368')).toBe(1368)
    expect(parseEngineOrder('ollama, nope, claude')).toEqual(['ollama', 'claude', 'openrouter'])
  })
})
