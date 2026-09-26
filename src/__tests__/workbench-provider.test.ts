// AI Munkapad (kanban #336, 2. fazis): a PROVIDER-reteg es a FRISS TELEPITES aga.
//
// Amit oriz:
//   1. a nyilvantartas: uj szolgaltato hozzaadasa nem nyul az orchestratorhoz;
//   2. "nincs beallitva szolgaltato" KIMONDOTT allapot (null), nem kivetel;
//   3. a modell a CONFIGBOL jon, nincs beegetve;
//   4. EGY UT (#404): nincs sajat API-kulcsos ut, egy regi tarolt kulcs sem
//      kapcsol at fizetos hivasra;
//   5. a CLI stream-json sorainak ertelmezese (ez viszi a valodi valaszt).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  clearAIProvidersForTest, listAIProviders, pickAIProvider, registerAIProvider,
  type AIChunk, type AIProvider,
} from '../workbench-agent/provider.js'
import { textFromStreamLine, renderConversation, makeCliTextFilter } from '../workbench-agent/provider-anthropic.js'

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
    }))).toEqual({ text: 'Első rész', whole: true })
  })

  // #401: a CLI a darabokat ES a zaro egesz uzenetet is kuldi; ha mindketto
  // tovabbmegy, a tool-hivas JSON-ja duplazodik es a JSON.parse elhasal.
  const cliText = (lines: object[]): string => {
    const pick = makeCliTextFilter()
    let out = ''
    for (const l of lines) {
      const ev = textFromStreamLine(JSON.stringify(l))
      const t = ev ? pick(ev) : null
      if (t) out += t
    }
    return out
  }
  const delta = (text: string) => ({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } })
  const whole = (text: string) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } })

  it('#401: darabok + zaro egesz uzenet -> a szoveg EGYSZER jon, a tool-JSON ertelmezheto', () => {
    const call = '{"tool":"project.listKanban","input":{}}'
    const out = cliText([
      { type: 'system', subtype: 'init' },
      delta('{"tool":"project.'), delta('listKanban","input":{}}'),
      whole(call),
      { type: 'result', is_error: false, result: call },
    ])
    expect(out).toBe(call)
    expect(JSON.parse(out)).toEqual({ tool: 'project.listKanban', input: {} })
  })

  it('#401: delta nelkuli futas -- az egesz uzenet a tartalek, az megy ki', () => {
    expect(cliText([whole('Szia!'), { type: 'result', is_error: false, result: 'Szia!' }])).toBe('Szia!')
  })

  it('#401: tobb uzenet egymas utan -- mindegyik egyszer', () => {
    expect(cliText([delta('A'), whole('A'), delta('B'), delta('C'), whole('BC')])).toBe('ABC')
    expect(cliText([delta('A'), whole('A'), whole('D')])).toBe('AD')
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
  it('bejelentkezes nelkul: NEM elerheto, es kimondja miert', async () => {
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
    expect(chunks).toEqual([{ kind: 'error', code: 'not_configured', detail: 'no signed-in Claude account' }])
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

  it('#404: nincs sajat API-kulcsos ut -- egy regi tarolt kulcs sem kapcsol at fizetos hivasra', async () => {
    vi.resetModules()
    const asked: string[] = []
    // A valodi beallitas-tar ISMERETLEN kulcsra dob: ha a provider meg kerdezne
    // a regi kulcsot, ez a teszt elbukik.
    vi.doMock('../settings-store.js', () => ({
      getEffectiveSettingValue: (k: string) => {
        asked.push(k)
        if (k === 'WORKBENCH_ANTHROPIC_API_KEY') throw new Error('Unknown setting key: ' + k)
        return ''
      },
    }))
    vi.doMock('../web/claude-plans.js', () => ({ resolveAgentConfigDir: () => ({ configDir: '/nincs/ilyen/konyvtar-404' }) }))
    vi.doMock('../workbench-agent/accounts.js', () => ({ workbenchAccounts: () => [] }))
    const mod = await import('../workbench-agent/provider-anthropic.js')
    expect('hasServerApiKey' in mod).toBe(false)
    expect('ANTHROPIC_API_URL' in mod).toBe(false)
    const origFetch = globalThis.fetch
    let fetched = 0
    globalThis.fetch = (async () => { fetched++; return new Response('{}', { status: 200 }) }) as typeof fetch
    try {
      const a = mod.anthropicProvider.availability()
      expect(a).toMatchObject({ available: false, reason: 'not_configured', detail: 'no signed-in Claude account' })
      expect(mod.anthropicProvider.accounts!()).toEqual([])
      const chunks: AIChunk[] = []
      for await (const c of mod.anthropicProvider.stream({ system: 's', messages: [{ role: 'user', content: 'x' }], lang: 'hu' })) chunks.push(c)
      expect(chunks).toEqual([{ kind: 'error', code: 'not_configured', detail: 'no signed-in Claude account' }])
      expect(fetched).toBe(0)
      expect(asked).not.toContain('WORKBENCH_ANTHROPIC_API_KEY')
    } finally {
      globalThis.fetch = origFetch
      vi.doUnmock('../settings-store.js')
      vi.doUnmock('../web/claude-plans.js')
      vi.doUnmock('../workbench-agent/accounts.js')
    }
  })
})
