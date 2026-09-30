// #454 (Boss TG 2125): the Workbench chat model is a dropdown and is not
// Claude-only. A non-Claude choice must actually be RUN, not just shown: the
// provider points the same `claude -p` runner at Z.ai with the vault key.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'

let vaultKey: string | null = null
let deepseekKey: string | null = null
let openrouterKey: string | null = null
vi.mock('../web/vault.js', () => ({
  getSecret: (id: string) => (id === 'zai-coding-key' ? vaultKey : id === 'DEEPSEEK_API_KEY' ? deepseekKey : id === 'openrouter-fleet-key' ? openrouterKey : null),
}))
vi.mock('../platform.js', () => ({ tryResolveFromPath: () => '/usr/bin/claude' }))
let model = ''
vi.mock('../settings-store.js', async (orig) => {
  const actual = await orig<typeof import('../settings-store.js')>()
  return { ...actual, getEffectiveSettingValue: (k: string) => (k === 'WORKBENCH_MODEL' ? model : '') }
})

import { anthropicProvider, setSpawnerForTest } from '../workbench-agent/provider-anthropic.js'
import { getSettingDefinition, validateSettingValue } from '../config-registry.js'

function fakeSpawner(seen: { env?: NodeJS.ProcessEnv; args?: string[] }) {
  return ((_bin: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => {
    seen.env = opts.env
    seen.args = args
    const child: any = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.stdin = {
      end() {
        setImmediate(() => {
          child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { text: 'szia' } } }) + '\n'))
          child.emit('close')
        })
      },
    }
    child.kill = () => true
    return child
  }) as any
}

async function drain(it: AsyncIterable<any>) {
  const out: any[] = []
  for await (const c of it) out.push(c)
  return out
}

describe('workbench model picker (#454)', () => {
  beforeEach(() => { vaultKey = null; deepseekKey = null; openrouterKey = null; model = ''; setSpawnerForTest(null) })

  it('the registry accepts the GLM ids as the Workbench model', () => {
    const def = getSettingDefinition('WORKBENCH_MODEL')!
    expect(def.valueSet).toContain('glm-5.3')
    expect(def.valueSet).toContain('')
  })

  it('GLM without a vault key: clear not_configured, no spawn', async () => {
    model = 'glm-5.3'
    const seen: any = {}
    setSpawnerForTest(fakeSpawner(seen))
    const av = anthropicProvider.availability()
    expect(av.available).toBe(false)
    const chunks = await drain(anthropicProvider.stream({ system: 's', messages: [{ role: 'user', content: 'hi' }], lang: 'hu' }))
    expect(chunks[0]).toMatchObject({ kind: 'error', code: 'not_configured' })
    expect(seen.env).toBeUndefined()
  })

  it('GLM with a key: runs against Z.ai, key only in the child env', async () => {
    model = 'glm-5.3'
    vaultKey = 'sk-test-glm'
    const seen: any = {}
    setSpawnerForTest(fakeSpawner(seen))
    expect(anthropicProvider.availability().available).toBe(true)
    const chunks = await drain(anthropicProvider.stream({ system: 's', messages: [{ role: 'user', content: 'hi' }], lang: 'hu' }))
    expect(chunks.some((c) => c.kind === 'text' && c.text === 'szia')).toBe(true)
    expect(chunks[chunks.length - 1]).toMatchObject({ kind: 'done', model: 'glm-5.3' })
    expect(seen.env.ANTHROPIC_BASE_URL).toBe('https://api.z.ai/api/anthropic')
    expect(seen.env.ANTHROPIC_AUTH_TOKEN).toBe('sk-test-glm')
    expect(seen.args).toContain('glm-5.3')
    // the key is never part of the arguments or of a chunk
    expect(JSON.stringify(seen.args)).not.toContain('sk-test-glm')
    expect(JSON.stringify(chunks)).not.toContain('sk-test-glm')
  })

  // --- #455: every model the fleet can run, not only Claude + GLM ----------

  it('the registry accepts DeepSeek and OpenRouter ids, but not an Ollama tag or a shell-breaking value', () => {
    const def = getSettingDefinition('WORKBENCH_MODEL')!
    expect(validateSettingValue(def, 'deepseek-v4-pro')).toMatchObject({ ok: true })
    expect(validateSettingValue(def, 'openai/gpt-5')).toMatchObject({ ok: true })
    expect(validateSettingValue(def, 'openrouter-auto:tier2')).toMatchObject({ ok: true })
    expect(validateSettingValue(def, 'qwen3.6:27b')).toMatchObject({ ok: false })
    expect(validateSettingValue(def, "x'; rm -rf /; echo '")).toMatchObject({ ok: false })
  })

  it('DeepSeek with a key: runs against the DeepSeek endpoint, key only in the env', async () => {
    model = 'deepseek-v4-pro'
    deepseekKey = 'sk-test-ds'
    const seen: any = {}
    setSpawnerForTest(fakeSpawner(seen))
    expect(anthropicProvider.availability().available).toBe(true)
    const chunks = await drain(anthropicProvider.stream({ system: 's', messages: [{ role: 'user', content: 'hi' }], lang: 'hu' }))
    expect(chunks[chunks.length - 1]).toMatchObject({ kind: 'done', model: 'deepseek-v4-pro' })
    expect(seen.env.ANTHROPIC_BASE_URL).toBe('https://api.deepseek.com/anthropic')
    expect(seen.env.ANTHROPIC_AUTH_TOKEN).toBe('sk-test-ds')
    expect(JSON.stringify(seen.args)).not.toContain('sk-test-ds')
  })

  it('OpenRouter (ChatGPT) with a key: runs against openrouter.ai', async () => {
    model = 'openai/gpt-5'
    openrouterKey = 'sk-test-or'
    const seen: any = {}
    setSpawnerForTest(fakeSpawner(seen))
    const chunks = await drain(anthropicProvider.stream({ system: 's', messages: [{ role: 'user', content: 'hi' }], lang: 'hu' }))
    expect(chunks[chunks.length - 1]).toMatchObject({ kind: 'done', model: 'openai/gpt-5' })
    expect(seen.env.ANTHROPIC_BASE_URL).toBe('https://openrouter.ai/api')
    expect(seen.env.ANTHROPIC_MODEL).toBe('openai/gpt-5')
    expect(seen.args).toContain('openai/gpt-5')
  })

  it('OpenRouter / DeepSeek without a key: clear not_configured, no spawn', async () => {
    for (const m of ['openai/gpt-5', 'deepseek-v4-flash']) {
      model = m
      const seen: any = {}
      setSpawnerForTest(fakeSpawner(seen))
      expect(anthropicProvider.availability().available).toBe(false)
      const chunks = await drain(anthropicProvider.stream({ system: 's', messages: [{ role: 'user', content: 'hi' }], lang: 'hu' }))
      expect(chunks[0]).toMatchObject({ kind: 'error', code: 'not_configured' })
      expect(seen.env).toBeUndefined()
    }
  })

  it('a stored Ollama tag is not answered from the wrong model: not_configured, no spawn', async () => {
    model = 'qwen3.6:27b'
    const seen: any = {}
    setSpawnerForTest(fakeSpawner(seen))
    expect(anthropicProvider.availability().available).toBe(false)
    const chunks = await drain(anthropicProvider.stream({ system: 's', messages: [{ role: 'user', content: 'hi' }], lang: 'hu' }))
    expect(chunks[0]).toMatchObject({ kind: 'error', code: 'not_configured' })
    expect(seen.env).toBeUndefined()
  })
})
