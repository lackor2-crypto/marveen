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
// Every call (and the closing summary) is appended to store/debate-log.jsonl
// -- full prompt + full response text, not just token counts, so the
// dashboard's "Vitaztatas" page can show the whole back-and-forth verbatim,
// not just aggregate stats (Boss, 2026-08-07: wants the process itself to be
// reviewable, not just a call-count). Logging lives here, not in the caller,
// so no invocation path can skip it.
//
// The log is a bounded ring buffer, not an unbounded append (Boss,
// 2026-08-07: "legyen olyan hogy maximum mennyi mehet abba a kosárba, és
// hogyha tele van a kosár, a régiek törlődnek, az újak megmaradnak"). After
// every write the file size is checked against the DEBATE_LOG_MAX_MB setting
// (Beallitasok -> Vitaztatas fül); if over, the OLDEST lines are dropped
// until it fits. This can silently orphan a session's later rounds/conclude
// marker from its aged-out earlier rounds -- an accepted trade-off of a
// simple oldest-out/newest-in cap, not something worth a more complex
// per-session-atomic eviction for a feature this low-volume.
//
// Subcommands:
//
//   ask "<prompt>" --models id1,id2[,id3...] [--session <id>] [--round <n>]
//     Fires the prompt at every model in parallel, prints their answers as
//     JSON. Omit --session on round 1 -- a fresh id is generated and printed
//     back; pass that same id on every later round of the same debate.
//     --round defaults to 1.
//
//   conclude --session <id> --consensus true|false --summary "<text>"
//     Appends a closing marker for the session (no model calls) -- the
//     agent's final synthesis and whether the models converged. Without this
//     a session in the log just trails off after its last round with no
//     visible outcome.
//
// Output (stdout, `ask`): { session, round, models, responses:
//   [{ model, ok, text?, error?, tokensIn?, tokensOut? }] }

import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { appendFileSync, readFileSync, writeFileSync, statSync, existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = join(__dirname, '..')
const LOG_PATH = join(projectRoot, 'store', 'debate-log.jsonl')

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'
const PER_MODEL_TIMEOUT_MS = 90_000
const VAULT_SECRET_ID = 'openrouter-fleet-key'
const DEFAULT_LOG_MAX_MB = 20

// Settings-store read is best-effort: if the dist build is stale/missing
// (fresh checkout, not yet `npm run build`) the log just keeps the default
// cap instead of failing the whole debate call over a housekeeping detail.
async function readLogMaxMb() {
  try {
    const { getEffectiveSettingValue } = await import(join(projectRoot, 'dist', 'settings-store.js'))
    const v = getEffectiveSettingValue('DEBATE_LOG_MAX_MB')
    const n = typeof v === 'number' ? v : parseInt(String(v), 10)
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_LOG_MAX_MB
  } catch {
    return DEFAULT_LOG_MAX_MB
  }
}

async function trimLogIfNeeded() {
  if (!existsSync(LOG_PATH)) return
  const maxBytes = (await readLogMaxMb()) * 1024 * 1024
  const stat = statSync(LOG_PATH)
  if (stat.size <= maxBytes) return
  const lines = readFileSync(LOG_PATH, 'utf-8').split('\n').filter(Boolean)
  let totalBytes = lines.reduce((sum, l) => sum + Buffer.byteLength(l, 'utf-8') + 1, 0)
  while (totalBytes > maxBytes && lines.length > 0) {
    const dropped = lines.shift()
    totalBytes -= Buffer.byteLength(dropped, 'utf-8') + 1
  }
  writeFileSync(LOG_PATH, lines.length ? lines.join('\n') + '\n' : '')
}

function parseAskArgs(argv) {
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

function parseConcludeArgs(argv) {
  const args = { session: null, consensus: null, summary: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--session') { args.session = argv[++i]; continue }
    if (a === '--consensus') { args.consensus = argv[++i] === 'true'; continue }
    if (a === '--summary') { args.summary = argv[++i]; continue }
  }
  return args
}

function logLine(entry) {
  try { appendFileSync(LOG_PATH, JSON.stringify(entry) + '\n') } catch { /* stats are best-effort, never block the actual call */ }
}

async function callModelOnce(model, prompt, apiKey) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PER_MODEL_TIMEOUT_MS)
  try {
    const resp = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        // X-Title is optional per OpenRouter's docs -- labels these calls in
        // their own dashboard instead of showing up unattributed. Skipping
        // HTTP-Referer: that's meant to be the calling app's real public URL,
        // and this install doesn't have a stable public one to give.
        'X-Title': 'Marveen debate',
      },
      // reasoning: low caps how much of the token budget a reasoning model
      // (e.g. openai/gpt-5.5) spends thinking before it has to start writing
      // the actual answer.
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], reasoning: { effort: 'low' } }),
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

const EMPTY_RESPONSE_MAX_RETRIES = 2

// Live incident, 2026-08-07: openai/gpt-5.5 (a reasoning model) intermittently
// returns HTTP 200 / finish_reason 'stop' with a completely EMPTY message on
// the FIRST call for a given prompt, then answers correctly (fast, as if
// served from a provider-side cache) on a repeat of the exact same request.
// Root cause on OpenRouter/upstream's side is unconfirmed, but the pattern is
// consistent enough that a bounded retry-on-empty is the practical fix: ok:true
// with blank text is treated as a transient failure here, not a real answer,
// and retried before giving up.
async function callModel(model, prompt, apiKey) {
  let last = null
  for (let attempt = 0; attempt <= EMPTY_RESPONSE_MAX_RETRIES; attempt++) {
    last = await callModelOnce(model, prompt, apiKey)
    if (last.ok && last.text && last.text.trim()) return last
  }
  if (last.ok) return { ...last, ok: false, error: `empty response after ${EMPTY_RESPONSE_MAX_RETRIES + 1} attempts` }
  return last
}

async function loadApiKey() {
  const { getSecret } = await import(join(projectRoot, 'dist', 'web', 'vault.js'))
  const apiKey = getSecret(VAULT_SECRET_ID)
  if (!apiKey) {
    console.error(`No OpenRouter key in vault (secret id: ${VAULT_SECRET_ID}). Add it on the dashboard's Vault page first.`)
    process.exit(1)
  }
  return apiKey
}

async function runAsk(argv) {
  const args = parseAskArgs(argv)
  if (!args.prompt || !args.models.length) {
    console.error('Usage: node scripts/debate.mjs ask "<prompt>" --models id1,id2[,id3...] [--session <id>] [--round <n>]')
    process.exit(1)
  }
  const apiKey = await loadApiKey()

  const session = args.session || randomUUID()
  const round = args.round ?? 1
  const ts = Math.floor(Date.now() / 1000)

  const responses = await Promise.all(args.models.map(m => callModel(m, args.prompt, apiKey)))

  for (const r of responses) {
    logLine({
      ts, session, round, type: 'round', prompt: args.prompt, model: r.model, ok: r.ok,
      text: r.ok ? r.text : null, tokensIn: r.tokensIn ?? null, tokensOut: r.tokensOut ?? null,
      error: r.ok ? null : r.error,
    })
  }
  await trimLogIfNeeded()

  console.log(JSON.stringify({ session, round, models: args.models, responses }, null, 2))
}

async function runConclude(argv) {
  const args = parseConcludeArgs(argv)
  if (!args.session || args.consensus === null || !args.summary) {
    console.error('Usage: node scripts/debate.mjs conclude --session <id> --consensus true|false --summary "<text>"')
    process.exit(1)
  }
  logLine({ ts: Math.floor(Date.now() / 1000), session: args.session, type: 'conclude', consensus: args.consensus, summary: args.summary })
  await trimLogIfNeeded()
  console.log(JSON.stringify({ ok: true, session: args.session }))
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2)
  if (cmd === 'ask') return runAsk(rest)
  if (cmd === 'conclude') return runConclude(rest)
  console.error('Usage: node scripts/debate.mjs <ask|conclude> ...')
  process.exit(1)
}

main().catch(err => { console.error('debate.mjs failed:', err); process.exit(1) })
