import { describe, it, expect, afterEach } from 'vitest'
import { claudeCliModel, askOnSubscription, setSubscriptionRunners } from '../debate-claude-cli.js'

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
      run: async (model, _s, _p, account) => {
        asked.push(`${account.agent}:${model}`)
        return account.agent === 'a' ? 'limit' : { ok: true, text: 'valasz', tokensIn: 3, tokensOut: 4 }
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
