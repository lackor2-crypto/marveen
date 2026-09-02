// GLM (Z.ai) provider wiring.
//
// The bug this locks down is a SILENT one, which is why it earns a test rather
// than a comment. agent-process.ts classifies a model string by prefix:
// `claude-`, `deepseek-`, then "contains a slash" for OpenRouter, and whatever
// is left falls through to Ollama. `glm-5.3` has no slash and none of the
// prefixes, so before this change it was filed under Ollama and the agent was
// launched against localhost:11434. That does not raise an error anywhere: with
// Ollama running it answers from some entirely different local model, and with
// Ollama down it just hangs. Nothing in the dashboard would say "wrong
// provider" -- the operator would see a GLM-labelled agent giving strange
// answers.
//
// The second half of the file guards the three settings that are easy to drop
// on a later edit and whose absence produces confusing, intermittent failures
// rather than clean errors (see glm-models.ts for why each one is there).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  GLM_BASE_URL,
  GLM_FAST_MODEL,
  GLM_MODELS,
  GLM_TIMEOUT_MS,
  GLM_VAULT_KEY,
  isGlmModel,
} from '../web/glm-models.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SRC = join(__dirname, '..')

describe('recognising a GLM model', () => {
  it('claims the models the Coding Plan actually serves', () => {
    for (const m of GLM_MODELS) {
      expect(isGlmModel(m.id)).toBe(true)
    }
  })

  it('leaves every other provider alone', () => {
    expect(isGlmModel('claude-opus-5')).toBe(false)
    expect(isGlmModel('deepseek-v4-pro')).toBe(false)
    expect(isGlmModel('z-ai/glm-4.6')).toBe(false) // OpenRouter id for the same family
    expect(isGlmModel('qwen3.6:27b')).toBe(false)
    expect(isGlmModel('')).toBe(false)
  })

  it('does not mistake a local Ollama tag that merely mentions glm', () => {
    // Ollama tags carry a ':' and would be pulled locally; only the bare
    // `glm-` prefix means the Z.ai subscription.
    expect(isGlmModel('myglm-5.3')).toBe(false)
  })
})

describe('the launcher routes GLM to Z.ai, not to Ollama', () => {
  const launcher = readFileSync(join(SRC, 'web', 'agent-process.ts'), 'utf-8')

  it('classifies GLM before the Ollama fallback', () => {
    const glmLine = launcher.indexOf('const isGLM')
    const ollamaLine = launcher.indexOf('const isOllama')
    expect(glmLine).toBeGreaterThan(-1)
    expect(ollamaLine).toBeGreaterThan(-1)
    expect(glmLine).toBeLessThan(ollamaLine)
  })

  it('excludes GLM from the Ollama and OpenRouter branches', () => {
    // Both fall-through branches must subtract isGLM, or a GLM model reaches
    // two providers at once and the last export wins.
    const ollama = launcher.match(/const isOllama = [^\n]*/)?.[0] ?? ''
    const openrouter = launcher.match(/const isOpenRouter = [^\n]*/)?.[0] ?? ''
    expect(ollama).toContain('!isGLM')
    expect(openrouter).toContain('!isGLM')
  })

  it('puts the GLM env on the launch command', () => {
    // A branch that computes an env string nobody interpolates is the quietest
    // failure of all: everything type-checks and the agent runs on Claude.
    const cmd = launcher.match(/const cmd = `[^`]*`/)?.[0] ?? ''
    expect(cmd).toContain('${glmEnv}')
  })
})

describe('the three settings whose absence fails confusingly', () => {
  const launcher = readFileSync(join(SRC, 'web', 'agent-process.ts'), 'utf-8')
  const glmEnv = launcher.match(/const glmEnv = isGLM[\s\S]*?: ''/)?.[0] ?? ''

  it('was found in the launcher at all', () => {
    expect(glmEnv).not.toBe('')
  })

  it('sends the key as ANTHROPIC_AUTH_TOKEN, never as ANTHROPIC_API_KEY', () => {
    // Z.ai reads AUTH_TOKEN. A key placed in ANTHROPIC_API_KEY comes back as a
    // 401 that reads like a bad key -- the most reported mistake with this
    // integration.
    expect(glmEnv).toContain('export ANTHROPIC_AUTH_TOKEN="${glmKey}"')
    expect(glmEnv).toContain('unset ANTHROPIC_API_KEY')
    expect(glmEnv).not.toMatch(/export ANTHROPIC_API_KEY/)
  })

  it('sets the haiku alias so background calls do not ask Z.ai for a Claude model', () => {
    // Without this, conversation titles and small classifications go out as
    // `claude-haiku-...` and 404 while the main chat works fine.
    expect(glmEnv).toContain('ANTHROPIC_DEFAULT_HAIKU_MODEL')
    expect(glmEnv).toContain('${GLM_FAST_MODEL}')
  })

  it('raises the client timeout GLM needs on long turns', () => {
    expect(glmEnv).toContain('API_TIMEOUT_MS')
  })

  it('uses the coding endpoint, which is not interchangeable with the general one', () => {
    expect(GLM_BASE_URL).toBe('https://api.z.ai/api/anthropic')
    expect(GLM_BASE_URL).not.toContain('/paas/v4')
  })
})

describe('an empty model list means "no key", and the UI can tell', () => {
  const route = readFileSync(join(SRC, 'web', 'routes', 'agents.ts'), 'utf-8')

  it('gates the models behind the vault key', () => {
    expect(route).toContain(`getSecret(GLM_VAULT_KEY)`)
    expect(route).toContain('glm: hasGlm ? GLM_MODELS : []')
  })

  it('ships the reason alongside the empty list', () => {
    // Zero models has two causes -- not connected, or connected and empty. The
    // flag is what lets the dropdown say which, instead of showing a blank
    // group and leaving the operator to guess.
    expect(route).toContain('glmConfigured: hasGlm')
  })
})

describe('setup is reachable from a fresh install', () => {
  it('the vault id the launcher reads is the one the UI offers', () => {
    const app = readFileSync(join(SRC, '..', 'web', 'app.js'), 'utf-8')
    // The Overview capability card, the Vault "known integrations" entry and
    // the Accounts page card are all driven by this single registry entry.
    expect(app).toContain(`vaultId: '${GLM_VAULT_KEY}'`)
  })

  it('the Accounts and Overview endpoints report the same key', () => {
    for (const f of ['accounts.ts', 'overview.ts']) {
      const src = readFileSync(join(SRC, 'web', 'routes', f), 'utf-8')
      expect(src).toContain('GLM_VAULT_KEY')
      expect(src).toContain(`id: 'zai'`)
    }
  })

  it('both dashboard languages describe it', () => {
    for (const lang of ['hu.js', 'en.js']) {
      const src = readFileSync(join(SRC, '..', 'web', 'lang', lang), 'utf-8')
      expect(src).toContain('overview.capability.zai.label')
      expect(src).toContain('vault.known.zai.steps')
      expect(src).toContain('agents.model.glm_group')
    }
  })
})

describe('constants stay coherent', () => {
  it('the fast model is one of the offered models', () => {
    expect(GLM_MODELS.some(m => m.id === GLM_FAST_MODEL)).toBe(true)
  })

  it('the timeout is a plain integer of milliseconds', () => {
    expect(GLM_TIMEOUT_MS).toMatch(/^\d+$/)
  })

  it('the vault id is a boring, shell-safe string', () => {
    expect(GLM_VAULT_KEY).toMatch(/^[a-z0-9-]+$/)
  })
})
