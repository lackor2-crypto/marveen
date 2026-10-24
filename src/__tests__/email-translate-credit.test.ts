import { describe, it, expect } from 'vitest'
import { affordableTokens, translationErrorMessage } from '../web/email-translate.js'

describe('email translation on a nearly empty OpenRouter balance', () => {
  const body = '{"error":{"message":"This request requires more credits, or fewer max_tokens. You requested up to 4000 tokens, but can only afford 1368. To increase, visit https://openrouter.ai/settings/credits and a"}}'

  it('reads the affordable token count from the 402 message', () => {
    expect(affordableTokens(body)).toBe(1368)
  })

  it('returns null for any other error text', () => {
    expect(affordableTokens('{"error":"rate limited"}')).toBeNull()
    expect(affordableTokens('')).toBeNull()
  })

  it('turns a 402 into a sentence with the credit link, not the raw JSON', () => {
    const msg = translationErrorMessage(402, body, 'hu')
    expect(msg).toContain('openrouter.ai/settings/credits')
    expect(msg).not.toContain('{')
  })

  it('answers in English on an English install', () => {
    expect(translationErrorMessage(402, body, 'en')).toContain('out of credit')
  })

  it('keeps the status and text for unknown errors', () => {
    expect(translationErrorMessage(500, 'boom')).toBe('OpenRouter 500: boom')
  })
})

import { parseEngineOrder } from '../web/email-translate.js'

describe('translator engine order', () => {
  it('keeps the owner order and appends the missing engines', () => {
    expect(parseEngineOrder('claude,ollama,openrouter')).toEqual(['claude', 'ollama', 'openrouter'])
    expect(parseEngineOrder('claude')).toEqual(['claude', 'openrouter', 'ollama'])
  })

  it('drops unknown names and duplicates, and falls back to the default on empty', () => {
    expect(parseEngineOrder('gpt, claude,claude ,')).toEqual(['claude', 'openrouter', 'ollama'])
    expect(parseEngineOrder('')).toEqual(['openrouter', 'claude', 'ollama'])
    expect(parseEngineOrder(undefined)).toEqual(['openrouter', 'claude', 'ollama'])
  })
})
