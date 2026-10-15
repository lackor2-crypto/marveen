import { describe, it, expect, afterEach } from 'vitest'
import { claudeCliModel, askOnSubscription, askOnProvider, routeFor, isFlatRate, toPickerId, setSubscriptionRunners } from '../debate-claude-cli.js'

const acct = (agent: string) => ({ agent, configDir: `/x/${agent}`, model: 'opus', fiveHourPct: 10, usageAt: null })

afterEach(() => setSubscriptionRunners({ run: null, accounts: null }))

describe('claudeCliModel (Boss TG 2960: Anthropic models run on the subscription)', () => {
  it('maps OpenRouter ids to claude CLI models, leaves everything else on OpenRouter', () => {
    expect(claudeCliModel('~anthropic/claude-opus-latest')).toBe('opus')
    expect(claudeCliModel('~anthropic/claude-sonnet-latest')).toBe('sonnet')
    expect(claudeCliModel('anthropic/claude-opus-4.5')).toBe('claude-opus-4-5')
    expect(claudeCliModel('anthropic/claude-sonnet-4')).toBe('claude-sonnet-4')
    expect(claudeCliModel('openai/gpt-5')).toBeNull()
    expect(claudeCliModel('~openai/gpt-latest')).toBeNull()
    expect(claudeCliModel('anthropic/claude-opus-4.5:thinking')).toBeNull()
    expect(claudeCliModel('anthropic/claude-opus-4.5:online')).toBeNull()
  })
})

describe('askOnSubscription', () => {
  it('uses the first account that answers and skips one at its limit', async () => {
    const asked: string[] = []
    setSubscriptionRunners({
      accounts: () => [acct('a'), acct('b')],
      run: async (call) => {
        asked.push(`${call.account?.agent}:${call.model}`)
        return call.account?.agent === 'a' ? 'limit' : { ok: true, text: 'valasz', tokensIn: 3, tokensOut: 4 }
      },
    })
    const r = await askOnSubscription('opus', 's', 'p', 1000)
    expect(r).toEqual({ ok: true, text: 'valasz', tokensIn: 3, tokensOut: 4 })
    expect(asked).toEqual(['a:opus', 'b:opus'])
  })

  it('says why when nothing answers', async () => {
    setSubscriptionRunners({ accounts: () => [acct('a')], run: async () => 'limit' })
    const r = await askOnSubscription('opus', 's', 'p', 1000)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('usage limit of a')
    setSubscriptionRunners({ accounts: () => [] })
    const none = await askOnSubscription('opus', 's', 'p', 1000)
    expect(none.ok).toBe(false)
  })
})

describe('routeFor (Boss TG 2966/2969: the debate uses the agent settings list)', () => {
  it('routes the agent-list ids like the agent launcher does', () => {
    expect(routeFor('claude-opus-5-5')).toMatchObject({ kind: 'claude', fallback: false })
    expect(routeFor('deepseek-v4-pro').kind).toBe('deepseek')
    expect(routeFor('glm-5.1').kind).toBe('glm')
    expect(routeFor('qwen3:8b').kind).toBe('ollama')
    expect(routeFor('openai/gpt-5').kind).toBe('openrouter')
    expect(routeFor('anthropic/claude-opus-4.5:online').kind).toBe('openrouter')
    expect(routeFor('~anthropic/claude-opus-latest')).toMatchObject({ kind: 'claude', model: 'opus', fallback: true })
  })
  it('flat-rate routes cost nothing per token', () => {
    expect(isFlatRate('claude-opus-5-5')).toBe(true)
    expect(isFlatRate('qwen3:8b')).toBe(true)
    expect(isFlatRate('openai/gpt-5')).toBe(false)
  })
  it('turns the saved latest alias into the list id', () => {
    expect(toPickerId('~anthropic/claude-opus-latest')).toMatch(/^claude-opus-/)
    expect(toPickerId('openai/gpt-5')).toBe('openai/gpt-5')
  })
  it('an Ollama call carries the local endpoint env', async () => {
    let seen: Record<string, string> | undefined
    setSubscriptionRunners({ run: async (c) => { seen = c.env; return { ok: true, text: 'x', tokensIn: 1, tokensOut: 1 } } })
    const r = await askOnProvider(routeFor('qwen3:8b'), 's', 'p', 1000)
    expect(r.ok).toBe(true)
    expect(seen?.ANTHROPIC_MODEL).toBe('qwen3:8b')
    expect(seen?.ANTHROPIC_AUTH_TOKEN).toBe('ollama')
  })
})
