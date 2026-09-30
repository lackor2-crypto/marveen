// #454 (Boss TG 2125): the Workbench chat model is a dropdown and is not
// Claude-only. A non-Claude choice must actually be RUN, not just shown: the
// provider points the same `claude -p` runner at Z.ai with the vault key.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'

let vaultKey: string | null = null
vi.mock('../web/vault.js', () => ({ getSecret: (id: string) => (id === 'zai-coding-key' ? vaultKey : null) }))
vi.mock('../platform.js', () => ({ tryResolveFromPath: () => '/usr/bin/claude' }))
let model = ''
vi.mock('../settings-store.js', async (orig) => {
  const actual = await orig<typeof import('../settings-store.js')>()
  return { ...actual, getEffectiveSettingValue: (k: string) => (k === 'WORKBENCH_MODEL' ? model : '') }
})

import { anthropicProvider, setSpawnerForTest } from '../workbench-agent/provider-anthropic.js'
import { getSettingDefinition } from '../config-registry.js'

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
  beforeEach(() => { vaultKey = null; model = ''; setSpawnerForTest(null) })

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
})
