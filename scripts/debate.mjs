#!/usr/bin/env node
// Multi-model "vitaztatas" (cross-check/debate) call -- fires the same prompt
// at N OpenRouter models in parallel and returns each one's answer as JSON.
//
// This is deliberately a DUMB, single-round primitive (same pattern as
// scripts/google.py): it does not decide what to ask, does not judge
// consensus, does not loop. The calling agent (the main agent, reading the
// JSON on stdout) drives the actual multi-round debate -- round 1 sends the
// raw question, round 2+ sends the agent's synthesized position back to
// every model asking "do you agree, and why/why not", repeated until
// agreement or a round cap. Keeping that judgment out of this script matches
// every other scripts/*.py|mjs CLI here: the script is I/O, the reasoning
// lives in the agent that calls it.
//
// Auth: reuses the SAME vault secret ('openrouter-fleet-key') already wired
// for the dashboard's per-agent OpenRouter model picker (src/web/agent-
// process.ts) -- one key, two consumers, no new vault plumbing. Read
// directly via the compiled vault module (same trick scripts/vault-
// resolve.mjs uses), not a subprocess -- this script already runs in Node,
// no need for a second hop.
//
// Usage:
//   node scripts/debate.mjs "<prompt>" --models openai/gpt-5,x-ai/grok-4 [--session <id>] [--round <n>]
//
// Output (stdout): one JSON object --
//   { session, round, models, responses: [{ model, ok, text?, error?, tokensIn?, tokensOut? }] }
//
// Every per-model result (success or failure) is also appended as one JSON
// line to store/debate-log.jsonl -- this is the raw data a future "Vitaztatas"
// dashboard stats page reads (call count/tokens per model, success rate).
// Logging lives here (not in the caller) so no invocation path can skip it.
//
// --session groups rounds of the same debate together for that future
// history view. Omit it on round 1 -- a fresh session id is generated and
// printed back; pass it on every later round of the same debate.

import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { appendFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = join(__dirname, '..')
const LOG_PATH = join(projectRoot, 'store', 'debate-log.jsonl')

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'
const PER_MODEL_TIMEOUT_MS = 90_000
const VAULT_SECRET_ID = 'openrouter-fleet-key'

function parseArgs(argv) {
  const args = { models: [], session: null, round: null, prompt: null }
  const rest = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--models') { args.models = (argv[++i] || '').split(',').map(s => s.trim()).filter(Boolean); continue }
    if (a === '--session') { args.session = argv[++i]; continue }
    if (a === '--round') { args.round = parseInt(argv[++i], 10); continue }
    rest.push(a)
  }
  args.prompt = rest.join(' ')
  return args
}

function logLine(entry) {
  try { appendFileSync(LOG_PATH, JSON.stringify(entry) + '\n') } catch { /* stats are best-effort, never block the actual call */ }
}

async function callModel(model, prompt, apiKey) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PER_MODEL_TIMEOUT_MS)
  try {
    const resp = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }] }),
      signal: controller.signal,
    })
    const data = await resp.json().catch(() => null)
    if (!resp.ok) {
      const msg = data?.error?.message || `HTTP ${resp.status}`
      return { model, ok: false, error: msg }
    }
    const text = data?.choices?.[0]?.message?.content ?? ''
    const usage = data?.usage || {}
    return { model, ok: true, text, tokensIn: usage.prompt_tokens ?? null, tokensOut: usage.completion_tokens ?? null }
  } catch (err) {
    return { model, ok: false, error: err.name === 'AbortError' ? `timeout after ${PER_MODEL_TIMEOUT_MS}ms` : String(err.message || err) }
  } finally {
    clearTimeout(timer)
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.prompt || !args.models.length) {
    console.error('Usage: node scripts/debate.mjs "<prompt>" --models id1,id2[,id3...] [--session <id>] [--round <n>]')
    process.exit(1)
  }

  const { getSecret } = await import(join(projectRoot, 'dist', 'web', 'vault.js'))
  const apiKey = getSecret(VAULT_SECRET_ID)
  if (!apiKey) {
    console.error(`No OpenRouter key in vault (secret id: ${VAULT_SECRET_ID}). Add it on the dashboard's Vault page first.`)
    process.exit(1)
  }

  const session = args.session || randomUUID()
  const round = args.round ?? 1
  const ts = Math.floor(Date.now() / 1000)

  const responses = await Promise.all(args.models.map(m => callModel(m, args.prompt, apiKey)))

  for (const r of responses) {
    logLine({ ts, session, round, model: r.model, ok: r.ok, tokensIn: r.tokensIn ?? null, tokensOut: r.tokensOut ?? null, error: r.ok ? null : r.error })
  }

  console.log(JSON.stringify({ session, round, models: args.models, responses }, null, 2))
}

main().catch(err => { console.error('debate.mjs failed:', err); process.exit(1) })
