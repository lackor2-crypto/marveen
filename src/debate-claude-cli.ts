// Boss TG 2960: a debate model from Anthropic runs on the owner's Claude SUBSCRIPTION (the signed-in `claude`
// CLI), not on OpenRouter credit. OpenRouter stays for every other maker and as the fallback when no account
// can answer. The accounts are tried best first (lowest 5-hour usage), a "limit" answer moves on to the next.

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { tryResolveFromPath } from './platform.js'
import { CLAUDE_MODELS, claudeVersionRank, parseClaudeModelId } from './claude-models.js'
import { STRIPPED_ENV, listClaudeAccountCandidates, orderClaudeAccounts, type ClaudeAccount } from './life-inbox-ai.js'

export interface SubscriptionAnswer { ok: true; text: string; tokensIn: number | null; tokensOut: number | null }
export interface SubscriptionFailure { ok: false; error: string }
export type SubscriptionRunner = (model: string, system: string, prompt: string, account: ClaudeAccount, timeoutMs: number) => Promise<SubscriptionAnswer | SubscriptionFailure | 'limit'>

/**
 * The `claude --model` value for an OpenRouter-style spec, or null when the spec is not a plain Anthropic
 * model (another maker, a `:online` / `:thinking` variant, a version we cannot name): those stay on OpenRouter.
 *   ~anthropic/claude-opus-latest -> opus      anthropic/claude-opus-4.5 -> claude-opus-4-5
 */
export function claudeCliModel(spec: string): string | null {
  const m = /^~?anthropic\/(claude-[a-z0-9.-]+)$/i.exec(String(spec || '').trim())
  if (!m) return null
  const id = m[1].toLowerCase()
  const latest = /^claude-(opus|sonnet|haiku)-latest$/.exec(id)
  if (latest) return latest[1]
  const fableLatest = /^claude-fable-latest$/.exec(id)
  if (fableLatest) {
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

const realRunner: SubscriptionRunner = (model, system, prompt, account, timeoutMs) => {
  const bin = tryResolveFromPath('claude')
  if (!bin) return Promise.resolve({ ok: false, error: 'the claude program was not found' })
  const cwd = mkdtempSync(join(tmpdir(), 'marveen-debate-cli-'))
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CONFIG_DIR: account.configDir }
  for (const k of STRIPPED_ENV) delete env[k]
  const args = ['-p', '--model', model, '--tools', '', '--setting-sources', 'project', '--no-session-persistence', '--output-format', 'json', '--system-prompt', system]
  return new Promise((resolve) => {
    let out = ''
    let err = ''
    let done = false
    const finish = (v: SubscriptionAnswer | SubscriptionFailure | 'limit') => {
      if (done) return
      done = true
      clearTimeout(timer)
      try { rmSync(cwd, { recursive: true, force: true }) } catch { /* temp dir already gone */ }
      resolve(v)
    }
    const child = spawn(bin, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish({ ok: false, error: `timeout after ${timeoutMs}ms` }) }, timeoutMs)
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err = (err + d).slice(-400) })
    child.on('error', (e) => finish({ ok: false, error: String(e.message || e) }))
    child.on('close', () => {
      try {
        const j = JSON.parse(out)
        if (j.is_error && typeof j.result === 'string') {
          if (/\blimit\b/i.test(j.result)) return finish('limit')
          return finish({ ok: false, error: j.result.slice(0, 300) })
        }
        if (typeof j.result !== 'string') return finish({ ok: false, error: 'no answer from the claude program' })
        finish({ ok: true, text: j.result, tokensIn: j.usage?.input_tokens ?? null, tokensOut: j.usage?.output_tokens ?? null })
      } catch {
        finish({ ok: false, error: (err.trim() || out.trim() || 'unreadable answer from the claude program').slice(0, 300) })
      }
    })
    child.stdin.end(prompt)
  })
}

let runner: SubscriptionRunner = realRunner
let accountLister: () => ClaudeAccount[] = () => orderClaudeAccounts(listClaudeAccountCandidates())

/** Tests only: replace the external calls. `null` restores the real one. */
export function setSubscriptionRunners(r: { run?: SubscriptionRunner | null; accounts?: (() => ClaudeAccount[]) | null }): void {
  if (r.run !== undefined) runner = r.run || realRunner
  if (r.accounts !== undefined) accountLister = r.accounts || (() => orderClaudeAccounts(listClaudeAccountCandidates()))
}

/** Asks the model on the subscription: the accounts best first, a limit answer moves on. */
export async function askOnSubscription(model: string, system: string, prompt: string, timeoutMs: number): Promise<SubscriptionAnswer | SubscriptionFailure> {
  const accounts = accountLister()
  if (!accounts.length) return { ok: false, error: 'no signed-in Claude account has room right now' }
  let last: SubscriptionFailure = { ok: false, error: 'no account answered' }
  for (const a of accounts) {
    const r = await runner(model, system, prompt, a, timeoutMs)
    if (r === 'limit') { last = { ok: false, error: `the usage limit of ${a.agent} is reached` }; continue }
    if (r.ok) return r
    last = r
  }
  return last
}
