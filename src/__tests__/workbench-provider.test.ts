// AI Munkapad (kanban #336, 2. fazis): a PROVIDER-reteg es a FRISS TELEPITES aga.
//
// Amit oriz:
//   1. a nyilvantartas: uj szolgaltato hozzaadasa nem nyul az orchestratorhoz;
//   2. "nincs beallitva szolgaltato" KIMONDOTT allapot (null), nem kivetel;
//   3. a modell a CONFIGBOL jon, nincs beegetve;
//   4. API-KULCS: a kulcs SEM a valaszba, SEM a hibauzenetbe nem szivarog ki;
//   5. a CLI stream-json sorainak ertelmezese (ez viszi a valodi valaszt).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  clearAIProvidersForTest, listAIProviders, pickAIProvider, registerAIProvider,
  type AIChunk, type AIProvider,
} from '../workbench-agent/provider.js'
import { textFromStreamLine, renderConversation } from '../workbench-agent/provider-anthropic.js'

function stub(id: string, available: boolean): AIProvider {
  return {
    id,
    model: () => `${id}-modell`,
    availability: () => (available ? { available: true } : { available: false, reason: 'not_configured' }),
    async *stream() { yield { kind: 'done', model: `${id}-modell` } as AIChunk },
  }
}

beforeEach(() => { clearAIProvidersForTest() })
afterEach(() => { clearAIProvidersForTest(); vi.unstubAllEnvs() })

describe('nyilvantartas', () => {
  it('az elso ELERHETO szolgaltato nyer, a bejegyzes sorrendjeben', () => {
    registerAIProvider(stub('elso', false))
    registerAIProvider(stub('masodik', true))
    registerAIProvider(stub('harmadik', true))
    expect(pickAIProvider()?.id).toBe('masodik')
    expect(listAIProviders().map((p) => p.id)).toEqual(['elso', 'masodik', 'harmadik'])
  })

  it('EGYIK sem erheto el: null -- kimondott allapot, nem kivetel', () => {
    registerAIProvider(stub('elso', false))
    expect(pickAIProvider()).toBeNull()
  })

  it('egyaltalan nincs bejegyezve semmi (friss telepites): szinten null', () => {
    expect(pickAIProvider()).toBeNull()
  })

  it('egy hibat dobo szolgaltato nem viszi magaval a tobbit', () => {
    registerAIProvider({
      id: 'rossz',
      model: () => 'x',
      availability: () => { throw new Error('elromlott') },
      async *stream() { yield { kind: 'done', model: 'x' } as AIChunk },
    })
    registerAIProvider(stub('jo', true))
    expect(pickAIProvider()?.id).toBe('jo')
  })
})

describe('a CLI stream-json sorainak ertelmezese', () => {
  it('reszleges darab (partial message)', () => {
    expect(textFromStreamLine(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { text: 'Szia' } } })))
      .toEqual({ text: 'Szia' })
  })

  it('egesz asszisztens-uzenet', () => {
    expect(textFromStreamLine(JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Első' }, { type: 'text', text: ' rész' }] },
    }))).toEqual({ text: 'Első rész' })
  })

  it('a zaro sor: siker', () => {
    expect(textFromStreamLine(JSON.stringify({ type: 'result', is_error: false, result: 'kész' }))).toEqual({ done: true })
  })

  it('a zaro sor: a szolgaltato SAJAT keret-hibaja', () => {
    expect(textFromStreamLine(JSON.stringify({ type: 'result', is_error: true, result: '5-hour limit reached' })))
      .toEqual({ limit: true })
  })

  it('a zaro sor: mas hiba -- a TENYLEGES szoveggel, nem talalgatva', () => {
    expect(textFromStreamLine(JSON.stringify({ type: 'result', is_error: true, result: 'Not logged in' })))
      .toEqual({ error: 'Not logged in' })
  })

  it('ertelmezhetetlen vagy ures sor: nincs esemeny (nem dob)', () => {
    expect(textFromStreamLine('')).toBeNull()
    expect(textFromStreamLine('nem json')).toBeNull()
    expect(textFromStreamLine('null')).toBeNull()
    expect(textFromStreamLine(JSON.stringify({ type: 'system', subtype: 'init' }))).toBeNull()
  })
})

describe('a beszelgetes atadasa', () => {
  it('a szerepek jelolve mennek, es a valasz helye a vegen all', () => {
    const out = renderConversation({
      system: 's',
      lang: 'hu',
      messages: [{ role: 'user', content: 'Szia' }, { role: 'assistant', content: 'Szia!' }, { role: 'user', content: 'Mi újság?' }],
    })
    expect(out).toContain('USER:\nSzia')
    expect(out).toContain('ASSISTANT:\nSzia!')
    expect(out.trimEnd().endsWith('ASSISTANT:')).toBe(true)
  })
})

// A valodi AnthropicProvider config-fuggo agai kulon modulban, mert a
// `settings-store` modul-szintu allapotot tart.
describe('AnthropicProvider -- config-fuggo viselkedes', () => {
  it('kulcs nelkul es bejelentkezes nelkul: NEM elerheto, es kimondja miert', async () => {
    vi.resetModules()
    vi.doMock('../settings-store.js', () => ({ getEffectiveSettingValue: () => '' }))
    vi.doMock('../web/claude-plans.js', () => ({ resolveAgentConfigDir: () => ({ configDir: '/nincs/ilyen/konyvtar' }) }))
    const { anthropicProvider } = await import('../workbench-agent/provider-anthropic.js')
    const a = anthropicProvider.availability()
    expect(a.available).toBe(false)
    expect(a.reason).toBe('not_configured')
    expect(a.detail).toContain('no signed-in Claude account')
    // A stream sem dob: kimondott hibat ad.
    const chunks: AIChunk[] = []
    for await (const c of anthropicProvider.stream({ system: 's', messages: [{ role: 'user', content: 'x' }], lang: 'hu' })) chunks.push(c)
    expect(chunks).toEqual([{ kind: 'error', code: 'not_configured', detail: 'no signed-in Claude account and no server-side API key' }])
    vi.doUnmock('../settings-store.js')
    vi.doUnmock('../web/claude-plans.js')
  })

  it('a modell a CONFIGBOL jon, es ures beallitasnal a telepites alapertelmezettje', async () => {
    vi.resetModules()
    vi.doMock('../settings-store.js', () => ({
      getEffectiveSettingValue: (k: string) => (k === 'WORKBENCH_MODEL' ? '  claude-sonnet-5  ' : ''),
    }))
    const m1 = await import('../workbench-agent/provider-anthropic.js')
    expect(m1.workbenchModel()).toBe('claude-sonnet-5')

    vi.resetModules()
    vi.doMock('../settings-store.js', () => ({ getEffectiveSettingValue: () => '' }))
    const m2 = await import('../workbench-agent/provider-anthropic.js')
    const { DEFAULT_AGENT_MODEL } = await import('../config.js')
    expect(m2.workbenchModel()).toBe(DEFAULT_AGENT_MODEL)
    vi.doUnmock('../settings-store.js')
  })

  it('a szerveroldali kulcs LETEZESE latszik, maga a kulcs SOSE', async () => {
    vi.resetModules()
    const SECRET = 'sk-ant-titkos-kulcs-amit-senki-nem-lathat'
    vi.doMock('../settings-store.js', () => ({
      getEffectiveSettingValue: (k: string) => (k === 'WORKBENCH_ANTHROPIC_API_KEY' ? SECRET : ''),
    }))
    const mod = await import('../workbench-agent/provider-anthropic.js')
    expect(mod.hasServerApiKey()).toBe(true)
    const a = mod.anthropicProvider.availability()
    expect(a.available).toBe(true)
    // A kulcs SEM az allapotban, SEM a reszletben nem jelenik meg.
    expect(JSON.stringify(a)).not.toContain(SECRET)
    expect(JSON.stringify(a)).not.toContain('sk-ant')

    // A hibauzenetbe sem szivaroghat ki: a szolgaltato elutasit, a kulcs nem latszik.
    const origFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response('{"error":"nope"}', { status: 401 })) as typeof fetch
    try {
      const chunks: AIChunk[] = []
      for await (const c of mod.anthropicProvider.stream({ system: 's', messages: [{ role: 'user', content: 'x' }], lang: 'hu' })) chunks.push(c)
      expect(JSON.stringify(chunks)).not.toContain(SECRET)
      expect(chunks[0]).toMatchObject({ kind: 'error', code: 'failed' })
    } finally {
      globalThis.fetch = origFetch
    }
    vi.doUnmock('../settings-store.js')
  })

  it('a kulcsos uton a 429-et a szolgaltato SAJAT szava alapjan nevezzuk keret-hibanak', async () => {
    vi.resetModules()
    vi.doMock('../settings-store.js', () => ({
      getEffectiveSettingValue: (k: string) => (k === 'WORKBENCH_ANTHROPIC_API_KEY' ? 'kulcs' : ''),
    }))
    const mod = await import('../workbench-agent/provider-anthropic.js')
    const origFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response('rate_limit_error', { status: 429 })) as typeof fetch
    try {
      const chunks: AIChunk[] = []
      for await (const c of mod.anthropicProvider.stream({ system: 's', messages: [{ role: 'user', content: 'x' }], lang: 'hu' })) chunks.push(c)
      expect(chunks[0]).toMatchObject({ kind: 'error', code: 'limit' })
    } finally {
      globalThis.fetch = origFetch
    }
    vi.doUnmock('../settings-store.js')
  })
})
