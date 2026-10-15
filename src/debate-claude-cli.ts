// Boss TG 2960 / 2966 / 2969: a debate model runs the way the owner's AGENT SETTINGS list says it runs, not
// always on OpenRouter credit. The picker shows the same list as the agent settings (/api/models/available), so
// the ids are the agents' ids and they are routed like the agent launcher does it (agent-process.ts):
//   claude-*            the owner's Claude SUBSCRIPTION (signed-in `claude` CLI; accounts best first, a limit moves on)
//   deepseek-*          DeepSeek's Anthropic-compatible endpoint, key from the vault
//   glm-*               Z.ai coding plan endpoint, key from the vault
//   provider/model      OpenRouter (direct HTTP, see debate-run.ts); `openrouter-auto:<tier>` resolves to one
//   anything else       a local Ollama model
// An old `anthropic/...` spec still goes to the subscription first and falls back to OpenRouter.

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OLLAMA_URL } from './config.js'
import { tryResolveFromPath } from './platform.js'
import { getSecret } from './web/vault.js'
import { CLAUDE_MODELS, claudeVersionRank, parseClaudeModelId } from './claude-models.js'
import { GLM_BASE_URL, GLM_FAST_MODEL, GLM_TIMEOUT_MS, GLM_VAULT_KEY, isGlmModel } from './web/glm-models.js'
import { resolveOpenRouterModel } from './web/openrouter-models.js'
import { STRIPPED_ENV, listClaudeAccountCandidates, orderClaudeAccounts, type ClaudeAccount } from './life-inbox-ai.js'

export type RouteKind = 'claude' | 'deepseek' | 'glm' | 'ollama' | 'openrouter'
export interface ModelRoute {
  kind: RouteKind
  /** The id the route's own endpoint knows (OpenRouter: the resolved provider/model id). */
  model: string
  /** An old `anthropic/...` spec: when the subscription cannot answer, OpenRouter may. */
  fallback: boolean
}

/**
 * The `claude --model` value for an OpenRouter-style Anthropic spec, or null when it is not a plain Anthropic model.
 *   ~anthropic/claude-opus-latest -> opus      anthropic/claude-opus-4.5 -> claude-opus-4-5
 */
export function claudeCliModel(spec: string): string | null {
  const m = /^~?anthropic\/(claude-[a-z0-9.-]+)$/i.exec(String(spec || '').trim())
  if (!m) return null
  const id = m[1].toLowerCase()
  const latest = /^claude-(opus|sonnet|haiku)-latest$/.exec(id)
  if (latest) return latest[1]
  if (id === 'claude-fable-latest') {
    let best: string | null = null
    for (const c of CLAUDE_MODELS) {
      if (c.family !== 'fable') continue
      if (best === null || claudeVersionRank(c.id) > claudeVersionRank(best)) best = c.id
    }
    return best
  }
  const dashed = id.replace(/\./g, '-')
  return parseClaudeModelId(dashed) ? dashed : null
}

/** The newest known Claude id of a family (what the agent settings list offers), or null. */
export function newestClaudeId(family: string): string | null {
  let best: string | null = null
  for (const c of CLAUDE_MODELS) {
    if (c.family !== family) continue
    if (best === null || claudeVersionRank(c.id) > claudeVersionRank(best)) best = c.id
  }
  return best
}

/**
 * A saved spec in the form the shared picker lists: `~anthropic/claude-opus-latest` becomes the newest `claude-opus-*`
 * id of the agent settings list; everything else is kept as it is.
 */
export function toPickerId(spec: string): string {
  const cli = claudeCliModel(spec)
  if (!cli) return spec
  if (cli === 'opus' || cli === 'sonnet' || cli === 'haiku') return newestClaudeId(cli) ?? spec
  return cli
}

/** Where a model spec of the debate goes. `:online` (web search) is an OpenRouter plugin, so it stays there. */
export function routeFor(spec: string): ModelRoute {
  const raw = String(spec || '').trim()
  if (raw.endsWith(':online')) return { kind: 'openrouter', model: raw, fallback: false }
  const legacy = claudeCliModel(raw)
  if (legacy) return { kind: 'claude', model: legacy, fallback: true }
  const model = resolveOpenRouterModel(raw)
  if (model.startsWith('claude-')) return { kind: 'claude', model, fallback: false }
  if (model.startsWith('deepseek-')) return { kind: 'deepseek', model, fallback: false }
  if (isGlmModel(model)) return { kind: 'glm', model, fallback: false }
  if (model.includes('/')) return { kind: 'openrouter', model, fallback: false }
  return { kind: 'ollama', model, fallback: false }
}

/** Models that cost nothing per token: the subscription, the Z.ai coding plan and a local model. */
export function isFlatRate(spec: string): boolean {
  const k = routeFor(spec).kind
  return k === 'claude' || k === 'glm' || k === 'ollama'
}

export interface CliAnswer { ok: true; text: string; tokensIn: number | null; tokensOut: number | null }
export interface CliFailure { ok: false; error: string }
export interface CliCall {
  model: string
  system: string
  prompt: string
  timeoutMs: number
  /** Subscription calls: the signed-in account's config dir. Other routes need none. */
  account?: ClaudeAccount
  /** Other routes: the endpoint and its token, as the agent launcher exports them. */
  env?: Record<string, string>
}
export type CliRunner = (call: CliCall) => Promise<CliAnswer | CliFailure | 'limit'>

const realRunner: CliRunner = (call) => {
  const bin = tryResolveFromPath('claude')
  if (!bin) return Promise.resolve({ ok: false, error: 'the claude program was not found' })
  const cwd = mkdtempSync(join(tmpdir(), 'marveen-debate-cli-'))
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const k of STRIPPED_ENV) delete env[k]
  if (call.account) env.CLAUDE_CONFIG_DIR = call.account.configDir
  else env.CLAUDE_CONFIG_DIR = join(cwd, '.claude')
  Object.assign(env, call.env || {})
  const args = ['-p', '--model', call.model, '--tools', '', '--setting-sources', 'project', '--no-session-persistence', '--output-format', 'json', '--system-prompt', call.system]
  return new Promise((resolve) => {
    let out = ''
    let err = ''
    let done = false
    const finish = (v: CliAnswer | CliFailure | 'limit') => {
      if (done) return
      done = true
      clearTimeout(timer)
      try { rmSync(cwd, { recursive: true, force: true }) } catch { /* temp dir already gone */ }
      resolve(v)
    }
    const child = spawn(bin, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish({ ok: false, error: `timeout after ${call.timeoutMs}ms` }) }, call.timeoutMs)
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err = (err + d).slice(-400) })
    child.on('error', (e) => finish({ ok: false, error: String(e.message || e) }))
    child.on('close', () => {
      try {
        const j = JSON.parse(out)
        if (j.is_error && typeof j.result === 'string') {
          if (call.account && /\blimit\b/i.test(j.result)) return finish('limit')
          return finish({ ok: false, error: j.result.slice(0, 300) })
        }
        if (typeof j.result !== 'string') return finish({ ok: false, error: 'no answer from the claude program' })
        finish({ ok: true, text: j.result, tokensIn: j.usage?.input_tokens ?? null, tokensOut: j.usage?.output_tokens ?? null })
      } catch {
        finish({ ok: false, error: (err.trim() || out.trim() || 'unreadable answer from the claude program').slice(0, 300) })
      }
    })
    child.stdin.end(call.prompt)
  })
}

let runner: CliRunner = realRunner
let accountLister: () => ClaudeAccount[] = () => orderClaudeAccounts(listClaudeAccountCandidates())

/** Tests only: replace the external calls. `null` restores the real one. */
export function setCliRunners(r: { run?: CliRunner | null; accounts?: (() => ClaudeAccount[]) | null }): void {
  if (r.run !== undefined) runner = r.run || realRunner
  if (r.accounts !== undefined) accountLister = r.accounts || (() => orderClaudeAccounts(listClaudeAccountCandidates()))
}

/** The Claude subscription: the accounts best first, a limit answer moves on to the next one. */
export async function askOnSubscription(model: string, system: string, prompt: string, timeoutMs: number): Promise<CliAnswer | CliFailure> {
  const accounts = accountLister()
  if (!accounts.length) return { ok: false, error: 'no signed-in Claude account has room right now' }
  let last: CliFailure = { ok: false, error: 'no account answered' }
  for (const account of accounts) {
    const r = await runner({ model, system, prompt, timeoutMs, account })
    if (r === 'limit') { last = { ok: false, error: `the usage limit of ${account.agent} is reached` }; continue }
    if (r.ok) return r
    last = r
  }
  return last
}

/** A DeepSeek / GLM / Ollama model, through the same Anthropic-compatible endpoint the agents use. */
export async function askOnProvider(route: ModelRoute, system: string, prompt: string, timeoutMs: number): Promise<CliAnswer | CliFailure> {
  let env: Record<string, string>
  if (route.kind === 'deepseek') {
    const key = getSecret('DEEPSEEK_API_KEY')
    if (!key) return { ok: false, error: 'no DeepSeek key in the vault (Accounts page)' }
    env = { ANTHROPIC_AUTH_TOKEN: key, ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic', ANTHROPIC_MODEL: route.model }
  } else if (route.kind === 'glm') {
    const key = getSecret(GLM_VAULT_KEY)
    if (!key) return { ok: false, error: 'no Z.ai (GLM) key in the vault (Accounts page)' }
    env = {
      ANTHROPIC_AUTH_TOKEN: key, ANTHROPIC_BASE_URL: GLM_BASE_URL, ANTHROPIC_MODEL: route.model,
      ANTHROPIC_DEFAULT_OPUS_MODEL: route.model, ANTHROPIC_DEFAULT_SONNET_MODEL: route.model,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: GLM_FAST_MODEL, API_TIMEOUT_MS: GLM_TIMEOUT_MS,
    }
  } else if (route.kind === 'ollama') {
    env = { ANTHROPIC_AUTH_TOKEN: 'ollama', ANTHROPIC_BASE_URL: OLLAMA_URL, ANTHROPIC_MODEL: route.model }
  } else {
    return { ok: false, error: `route ${route.kind} is not a CLI route` }
  }
  const r = await runner({ model: route.model, system, prompt, timeoutMs, env })
  return r === 'limit' ? { ok: false, error: 'the provider answered with a limit message' } : r
}

/** Kept for the existing tests: the runner now takes an env-aware call. */
export const setSubscriptionRunners = setCliRunners
