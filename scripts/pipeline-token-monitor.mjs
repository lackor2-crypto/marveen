#!/usr/bin/env node
// Pipeline token-monitor (kanban #266, card c0cf6382).
//
// Measures a MULTI-AGENT pipeline run -- the "I command -> usalackor plans ->
// VS Code implements -> I verify" shape Boss described (2026-09-12) -- so the
// real token cost of splitting a task across agents can be compared against a
// single-agent counterfactual ESTIMATE.
//
// What it measures, all from primary sources (never guessed):
//   - each participant's token consumption, read from the Claude Code JSONL
//     transcripts (`message.usage`), collapsed per assistant turn so a
//     tool-calling turn is counted ONCE (the same ~2x inflation fix as
//     src/web/token-usage.ts collapseByMessageId);
//   - the hand-off cost: the plan/context bytes passed between agents, recorded
//     as timeline events (`mark ... --chars N`);
//   - a per-run timeline;
//   - a single-agent counterfactual ESTIMATE (clearly labelled -- it is a
//     model, not a measurement).
//
// Host-agnostic: the project root is the script's own parent directory, the
// dashboard port comes from .env (WEB_PORT), and the bearer token from
// store/.dashboard-token. Nothing about this machine is baked in.
//
// Subcommands: start | mark | map | sessions | report
//
// Usage:
//   node scripts/pipeline-token-monitor.mjs start --card <id|#seq> \
//        [--run <name>] [--role tervezo=usalackor,implementalo=kod-hid,ellenorzo=lackor2-bot] \
//        [--orchestrator <agent>]
//   node scripts/pipeline-token-monitor.mjs mark <run> <kind> [note...] [--chars N]
//   node scripts/pipeline-token-monitor.mjs map <run> <sessionId> <roleOrAgent>
//   node scripts/pipeline-token-monitor.mjs sessions [--agent <name>] [--since-hours N]
//   node scripts/pipeline-token-monitor.mjs report <run> [--json]

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'

export const PROJECT_ROOT = process.env.MARVEEN_PROJECT_ROOT
  || join(dirname(fileURLToPath(import.meta.url)), '..')

// ---------------------------------------------------------------------------
// Config (host-agnostic)
// ---------------------------------------------------------------------------

/** Read a KEY=value from .env, tolerating quotes and comments. Returns null
 *  when the file or key is absent -- the caller decides the fallback, and a
 *  missing value is never silently turned into a wrong one. */
export function readEnvValue(key, envText) {
  if (typeof envText !== 'string') {
    const envPath = join(PROJECT_ROOT, '.env')
    envText = existsSync(envPath) ? readFileSync(envPath, 'utf-8') : ''
  }
  for (const raw of envText.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq < 0) continue
    if (line.slice(0, eq).trim() !== key) continue
    return line.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
  }
  return null
}

function webPort() {
  const v = readEnvValue('WEB_PORT')
  const n = v ? Number(v) : NaN
  return Number.isFinite(n) && n > 0 ? n : 3420
}

function dashboardToken() {
  const p = join(PROJECT_ROOT, 'store', '.dashboard-token')
  return existsSync(p) ? readFileSync(p, 'utf-8').trim() : ''
}

function runsDir() {
  return join(PROJECT_ROOT, 'store', 'pipeline-runs')
}

/** Claude Code transcript root. Honours CLAUDE_CONFIG_DIR so a per-agent
 *  isolated config is found too, and falls back to ~/.claude. */
export function projectsDir() {
  const base = process.env.CLAUDE_CONFIG_DIR
    ? process.env.CLAUDE_CONFIG_DIR
    : join(homedir(), '.claude')
  return join(base, 'projects')
}

async function dashboardGet(path) {
  const url = `http://localhost:${webPort()}${path}`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${dashboardToken()}` } })
  if (!res.ok) throw new Error(`GET ${path} -> HTTP ${res.status}`)
  return res.json()
}

// ---------------------------------------------------------------------------
// Transcript discovery + parsing (mirrors src/web/token-usage.ts)
// ---------------------------------------------------------------------------

/** Claude Code encodes a project's absolute path into a directory name by
 *  replacing every non-alphanumeric/non-dash char with `-`. */
export function encodeProjectPath(p) {
  return p.replace(/[^a-zA-Z0-9-]/g, '-')
}

/** Discover {agent, projectDir} sources under the projects root. The main
 *  agent's dir is encodeProjectPath(PROJECT_ROOT); a fleet agent's dir ends in
 *  `-agents-<name>`. Returns [] when the root is absent (fresh install) -- the
 *  caller distinguishes "no transcripts yet" from "could not look". */
export function discoverAgentSources(root = projectsDir(), projectRoot = PROJECT_ROOT) {
  const out = []
  if (!existsSync(root)) return out
  const mainDir = encodeProjectPath(projectRoot)
  let entries
  try { entries = readdirSync(root) } catch { return out }
  for (const entry of entries) {
    const full = join(root, entry)
    let st
    try { st = statSync(full) } catch { continue }
    if (!st.isDirectory()) continue
    const m = entry.match(/-agents-([a-z0-9-]+)$/)
    if (m) out.push({ agent: m[1], projectDir: full })
    else if (entry === mainDir) out.push({ agent: mainAgentId(), projectDir: full })
  }
  return out
}

function mainAgentId() {
  return readEnvValue('MAIN_AGENT_ID') || 'main'
}

function findJsonlFiles(dir) {
  const files = []
  if (!existsSync(dir)) return files
  const scan = (d) => {
    let entries
    try { entries = readdirSync(d) } catch { return }
    for (const e of entries) {
      const full = join(d, e)
      if (e.endsWith('.jsonl')) { files.push(full); continue }
      let st
      try { st = statSync(full) } catch { continue }
      if (st.isDirectory()) scan(full)
    }
  }
  scan(dir)
  return files
}

/** Parse one transcript's assistant `message.usage` rows. Pure over `text` so
 *  it is unit-testable without touching the filesystem. */
export function parseUsageText(text, agent = '') {
  const calls = []
  let sessionId = ''
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let obj
    try { obj = JSON.parse(line) } catch { continue }
    if (obj.sessionId) sessionId = obj.sessionId
    if (obj.type !== 'assistant' || !obj.message || !obj.message.usage) continue
    const u = obj.message.usage
    const ts = obj.timestamp ? new Date(obj.timestamp).getTime() : 0
    if (!ts) continue
    let thinking = 0
    const content = obj.message.content
    if (Array.isArray(content)) {
      for (const b of content) {
        if (b && b.type === 'thinking' && typeof b.thinking === 'string') {
          thinking += Math.ceil(b.thinking.length / 4)
        }
      }
    }
    calls.push({
      agent,
      sessionId: sessionId || '',
      ts,
      inputTokens: u.input_tokens || 0,
      outputTokens: u.output_tokens || 0,
      cacheReadTokens: u.cache_read_input_tokens || 0,
      cacheCreationTokens: u.cache_creation_input_tokens || 0,
      thinkingTokens: thinking,
      model: (obj.message && obj.message.model) || null,
      messageId: (obj.message && obj.message.id) || null,
    })
  }
  return collapseByMessageId(calls)
}

/** Collapse rows sharing a message id into one turn. Usage repeats identically
 *  across a tool-calling turn's lines, so we take the max per field (defensive
 *  against a partial streaming line). Rows without an id pass through. */
export function collapseByMessageId(calls) {
  const byId = new Map()
  const out = []
  for (const c of calls) {
    if (!c.messageId) { out.push(c); continue }
    const ex = byId.get(c.messageId)
    if (!ex) { const copy = { ...c }; byId.set(c.messageId, copy); out.push(copy); continue }
    ex.inputTokens = Math.max(ex.inputTokens, c.inputTokens)
    ex.outputTokens = Math.max(ex.outputTokens, c.outputTokens)
    ex.cacheReadTokens = Math.max(ex.cacheReadTokens, c.cacheReadTokens)
    ex.cacheCreationTokens = Math.max(ex.cacheCreationTokens, c.cacheCreationTokens)
    ex.thinkingTokens = Math.max(ex.thinkingTokens, c.thinkingTokens)
    if (!ex.model && c.model) ex.model = c.model
  }
  return out
}

/** Sum a list of collapsed calls into per-field totals. */
export function sumUsage(calls) {
  const t = {
    turns: calls.length,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
    cacheCreationTokens: 0, thinkingTokens: 0,
    firstTs: null, lastTs: null, model: null,
  }
  for (const c of calls) {
    t.inputTokens += c.inputTokens
    t.outputTokens += c.outputTokens
    t.cacheReadTokens += c.cacheReadTokens
    t.cacheCreationTokens += c.cacheCreationTokens
    t.thinkingTokens += c.thinkingTokens
    if (c.ts) {
      if (t.firstTs === null || c.ts < t.firstTs) t.firstTs = c.ts
      if (t.lastTs === null || c.ts > t.lastTs) t.lastTs = c.ts
    }
    if (!t.model && c.model) t.model = c.model
  }
  // The "billable" number treats a fresh (cache-creation) input token and an
  // output token as full price and a cache-READ token as ~0.1x -- the same
  // rough shape Anthropic pricing uses. This is a WEIGHT for comparison, not a
  // dollar figure; dollars need per-model rates the report marks as estimates.
  t.weightedTokens = t.inputTokens + t.cacheCreationTokens + t.outputTokens
    + Math.ceil(t.cacheReadTokens * 0.1)
  return t
}

// ---------------------------------------------------------------------------
// Run files
// ---------------------------------------------------------------------------

export function runFilePath(name) {
  const clean = name.endsWith('.json') ? name : `${name}.json`
  const withPrefix = clean.startsWith('run-') || clean.startsWith('card-') ? clean : `run-${clean}`
  return join(runsDir(), withPrefix)
}

/** Resolve a run reference (name, run-id, card id, or path) to an on-disk file
 *  path, preferring an exact existing file. */
export function resolveRunPath(ref) {
  if (ref.includes('/') && existsSync(ref)) return ref
  const direct = runFilePath(ref)
  if (existsSync(direct)) return direct
  // Fall back to a scan: match by runId/run/card fields or filename substring.
  const dir = runsDir()
  if (existsSync(dir)) {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue
      if (f === `${ref}.json` || f.includes(ref)) return join(dir, f)
      try {
        const j = JSON.parse(readFileSync(join(dir, f), 'utf-8'))
        if (j.runId === ref || j.run === ref || j.card === ref || j.cardId === ref) return join(dir, f)
      } catch { /* skip unreadable */ }
    }
  }
  return direct
}

export function loadRun(ref) {
  const p = resolveRunPath(ref)
  if (!existsSync(p)) throw new Error(`run not found: ${ref} (looked at ${p})`)
  return { path: p, run: normalizeRun(JSON.parse(readFileSync(p, 'utf-8'))) }
}

/** Accept either legacy shape (run-3837120e: {run, baseline, no events} or
 *  run-2026-...: {runId, sessionMap, events}) and normalise to one object. */
export function normalizeRun(j) {
  return {
    schema: 2,
    runId: j.runId || j.run || null,
    run: j.run || j.runId || null,
    card: j.card || null,
    cardId: j.cardId || j.card || null,
    title: j.title || null,
    startedAt: j.startedAt || null,
    endedAt: j.endedAt || null,
    roles: j.roles || {},
    baseline: j.baseline || {},
    sessionMap: j.sessionMap || {},
    events: Array.isArray(j.events) ? j.events : [],
  }
}

function saveRun(path, run) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(run, null, 2) + '\n')
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

/** Build the report object from a normalised run and a function that returns
 *  the collapsed calls for a session id. Pure (the fetcher is injected) so the
 *  aggregation + single-agent estimate can be unit-tested with fixtures. */
export function buildReport(run, callsForSession) {
  const perRole = {}
  const bySession = {}
  for (const [sessionId, role] of Object.entries(run.sessionMap)) {
    const calls = callsForSession(sessionId) || []
    const totals = sumUsage(calls)
    bySession[sessionId] = { role, ...totals }
    if (!perRole[role]) perRole[role] = emptyTotals()
    addTotals(perRole[role], totals)
  }
  const grand = emptyTotals()
  for (const r of Object.values(perRole)) addTotals(grand, r)

  // Hand-off cost: the plan/context bytes explicitly passed between agents,
  // recorded as timeline events. This is the price of splitting the work --
  // context that a single agent would already have in-window.
  let handoffChars = 0
  let handoffTokEst = 0
  for (const e of run.events) {
    if (typeof e.payloadChars === 'number') handoffChars += e.payloadChars
    if (typeof e.payloadTokEst === 'number') handoffTokEst += e.payloadTokEst
    else if (typeof e.payloadChars === 'number') handoffTokEst += Math.ceil(e.payloadChars / 4)
  }

  return {
    runId: run.runId,
    card: run.card,
    title: run.title,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    roles: run.roles,
    perRole,
    bySession,
    grandTotal: grand,
    handoff: { chars: handoffChars, tokEst: handoffTokEst },
    singleAgentEstimate: estimateSingleAgent(perRole, grand),
    timeline: buildTimeline(run),
    sessionsMissing: Object.keys(run.sessionMap).filter((s) => (callsForSession(s) || []).length === 0),
  }
}

function emptyTotals() {
  return {
    turns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
    cacheCreationTokens: 0, thinkingTokens: 0, weightedTokens: 0,
  }
}

function addTotals(acc, t) {
  acc.turns += t.turns || 0
  acc.inputTokens += t.inputTokens || 0
  acc.outputTokens += t.outputTokens || 0
  acc.cacheReadTokens += t.cacheReadTokens || 0
  acc.cacheCreationTokens += t.cacheCreationTokens || 0
  acc.thinkingTokens += t.thinkingTokens || 0
  acc.weightedTokens += t.weightedTokens || 0
}

/**
 * Single-agent counterfactual ESTIMATE. This is a model, not a measurement --
 * the report labels it so.
 *
 * The reasoning: the multi-agent split pays for INPUT/context re-loading once
 * per agent (each agent reads the task, the plan, the code from scratch), while
 * a single agent would carry ONE growing context across the whole task. The
 * OUTPUT work (the plan text, the code, the verification) still has to be
 * produced no matter who does it. So:
 *   single-agent input  ~= the largest single role's input+cacheCreation
 *                          (one context load, the biggest one observed)
 *   single-agent output ~= sum of every role's output (productive work stays)
 * The overhead the split cost = multi-agent weighted total - single estimate.
 */
export function estimateSingleAgent(perRole, grand) {
  let maxContext = 0
  for (const r of Object.values(perRole)) {
    const ctx = (r.inputTokens || 0) + (r.cacheCreationTokens || 0)
    if (ctx > maxContext) maxContext = ctx
  }
  const estInput = maxContext
  const estOutput = grand.outputTokens || 0
  const estThinking = grand.thinkingTokens || 0
  const estWeighted = estInput + estOutput
  return {
    method: 'estimate',
    note: 'BECSLES: egy-agens ~= egy kontextus-betoltes (a legnagyobb szerepe) + minden szerep kimenete',
    inputTokens: estInput,
    outputTokens: estOutput,
    thinkingTokens: estThinking,
    weightedTokens: estWeighted,
    multiAgentWeighted: grand.weightedTokens || 0,
    splitOverheadWeighted: Math.max(0, (grand.weightedTokens || 0) - estWeighted),
  }
}

function buildTimeline(run) {
  const start = run.startedAt || (run.events[0] && run.events[0].ts) || null
  return run.events.map((e) => ({
    ts: e.ts,
    elapsedMs: start && e.ts ? e.ts - start : null,
    kind: e.kind,
    note: e.note || '',
    payloadChars: typeof e.payloadChars === 'number' ? e.payloadChars : null,
    payloadTokEst: typeof e.payloadTokEst === 'number' ? e.payloadTokEst
      : (typeof e.payloadChars === 'number' ? Math.ceil(e.payloadChars / 4) : null),
  }))
}

// ---------------------------------------------------------------------------
// Session discovery (for `sessions` + report's file lookup)
// ---------------------------------------------------------------------------

/** Map every discoverable session id to its transcript file + agent + mtime.
 *  A session id can appear under several files; the newest wins. */
export function indexSessions(sources = discoverAgentSources()) {
  const idx = new Map()
  for (const src of sources) {
    for (const file of findJsonlFiles(src.projectDir)) {
      const sid = basename(file, '.jsonl')
      let mtime = 0
      try { mtime = statSync(file).mtimeMs } catch { /* keep 0 */ }
      const prev = idx.get(sid)
      if (!prev || mtime > prev.mtime) idx.set(sid, { sessionId: sid, agent: src.agent, file, mtime })
    }
  }
  return idx
}

function callsForSessionFromDisk(idx) {
  return (sessionId) => {
    const hit = idx.get(sessionId)
    if (!hit) return []
    try {
      // parseUsageText reads whole file; fine for the report path (invoked
      // rarely, per-run). The heavy streaming path stays in token-usage.ts.
      return parseUsageText(readFileSync(hit.file, 'utf-8'), hit.agent)
    } catch { return [] }
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseFlags(argv) {
  const flags = {}
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) { flags[key] = true }
      else { flags[key] = next; i++ }
    } else positional.push(a)
  }
  return { flags, positional }
}

function fmtTok(n) {
  if (n === null || n === undefined) return '?'
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k'
  return String(n)
}

async function cmdStart(flags) {
  const cardRef = flags.card
  if (!cardRef) throw new Error('start: --card <id|#seq> kotelezo')
  let card = null
  try {
    const kb = await dashboardGet('/api/kanban')
    const cards = Array.isArray(kb) ? kb : (kb.cards || [])
    const want = String(cardRef).replace(/^#/, '')
    card = cards.find((c) => c.id === want || String(c.seq) === want) || null
  } catch (e) {
    console.error(`figyelmeztetes: a kartya nem kereshelto ki (${e.message}) -- cim/id nelkul folytatom`)
  }
  const cardId = card ? card.id : String(cardRef).replace(/^#/, '')
  const runName = flags.run || `card-${cardId}`
  const roles = {}
  if (typeof flags.role === 'string') {
    for (const pair of flags.role.split(',')) {
      const [k, v] = pair.split('=')
      if (k && v) roles[k.trim()] = v.trim()
    }
  }
  if (flags.orchestrator) roles.orchestrator = String(flags.orchestrator)

  const baseline = {}
  try {
    const ov = await dashboardGet('/api/overview')
    const accounts = ov.claudeAccounts || []
    const wanted = new Set(Object.values(roles).filter((r) => /^[a-z0-9-]+$/i.test(r)))
    for (const acc of accounts) {
      if (wanted.size === 0 || wanted.has(acc.id)) {
        baseline[acc.id] = {
          fiveHourPct: acc.fiveHourPct ?? null,
          sevenDayPct: acc.sevenDayPct ?? null,
          model: acc.model ?? null,
          measuredAt: acc.measuredAt ?? Date.now(),
        }
      }
    }
  } catch (e) {
    console.error(`figyelmeztetes: baseline nem olvashato (${e.message}) -- ures baseline`)
  }

  const now = Date.now()
  const run = normalizeRun({
    runId: runName, run: runName, card: cardId, cardId,
    title: card ? card.title : null,
    startedAt: now, endedAt: null, roles, baseline, sessionMap: {},
    events: [{ ts: now, kind: 'start', note: `pipeline start (${Object.entries(roles).map(([k, v]) => k + '=' + v).join(', ')})` }],
  })
  const path = runFilePath(runName)
  if (existsSync(path)) throw new Error(`mar letezik: ${path} (valassz mas --run nevet)`)
  saveRun(path, run)
  console.log(`run letrehozva: ${path}`)
  console.log(`  card=${cardId}${card ? ' "' + card.title + '"' : ''}  roles=${JSON.stringify(roles)}`)
  console.log(`  baseline agensek: ${Object.keys(baseline).join(', ') || '(nincs)'}`)
}

function cmdMark(positional, flags) {
  const [ref, kind, ...noteParts] = positional
  if (!ref || !kind) throw new Error('mark: <run> <kind> [note...] [--chars N]')
  const { path, run } = loadRun(ref)
  const ev = { ts: Date.now(), kind, note: noteParts.join(' ') }
  if (flags.chars !== undefined) {
    const chars = Number(flags.chars)
    if (Number.isFinite(chars)) { ev.payloadChars = chars; ev.payloadTokEst = Math.ceil(chars / 4) }
  }
  run.events.push(ev)
  if (kind === 'end' || kind === 'landed') run.endedAt = ev.ts
  saveRun(path, run)
  console.log(`esemeny hozzaadva: ${kind}${ev.payloadChars ? ` (${ev.payloadChars} char ~${ev.payloadTokEst} tok)` : ''}`)
}

function cmdMap(positional) {
  const [ref, sessionId, role] = positional
  if (!ref || !sessionId || !role) throw new Error('map: <run> <sessionId> <roleOrAgent>')
  const { path, run } = loadRun(ref)
  run.sessionMap[sessionId] = role
  saveRun(path, run)
  console.log(`session lekepezve: ${sessionId} -> ${role}`)
  console.log(`  jelenlegi map: ${JSON.stringify(run.sessionMap)}`)
}

function cmdSessions(flags) {
  const idx = indexSessions()
  if (idx.size === 0) {
    console.log(`nincs talalt transcript a ${projectsDir()} alatt.`)
    console.log('  (ket dolgot jelenthet: friss telepites -> meg nincs, VAGY nem lattam oda -> ellenorizd CLAUDE_CONFIG_DIR-t)')
    return
  }
  const sinceHours = flags['since-hours'] !== undefined ? Number(flags['since-hours']) : null
  const cutoff = sinceHours && Number.isFinite(sinceHours) ? Date.now() - sinceHours * 3600_000 : null
  const rows = [...idx.values()]
    .filter((r) => (!flags.agent || r.agent === flags.agent))
    .filter((r) => (cutoff === null || r.mtime >= cutoff))
    .sort((a, b) => b.mtime - a.mtime)
  console.log(`talalt sessionok (${rows.length}):`)
  for (const r of rows) {
    const age = r.mtime ? `${Math.round((Date.now() - r.mtime) / 60000)} perce` : '?'
    console.log(`  ${r.agent.padEnd(14)} ${r.sessionId}  (${age})`)
  }
}

function cmdReport(positional, flags) {
  const [ref] = positional
  if (!ref) throw new Error('report: <run> [--json]')
  const { run } = loadRun(ref)
  const idx = indexSessions()
  const rep = buildReport(run, callsForSessionFromDisk(idx))
  if (flags.json) { console.log(JSON.stringify(rep, null, 2)); return }
  printReport(rep, run)
}

function printReport(rep, run) {
  const line = '-'.repeat(64)
  console.log(line)
  console.log(`PIPELINE TOKEN-JELENTES  run=${rep.runId}  card=${rep.card}${rep.title ? ' "' + rep.title + '"' : ''}`)
  if (rep.startedAt) {
    const dur = rep.endedAt ? `${Math.round((rep.endedAt - rep.startedAt) / 60000)} perc` : 'folyamatban'
    console.log(`ido: ${new Date(rep.startedAt).toISOString()}  (${dur})`)
  }
  console.log(line)
  console.log('SZEREPENKENT (mert, JSONL message.usage, turn-onkent osszevonva):')
  console.log(`  ${'szerep'.padEnd(16)} ${'turn'.padStart(5)} ${'input'.padStart(8)} ${'output'.padStart(8)} ${'cacheR'.padStart(8)} ${'sulyzott'.padStart(9)}  model`)
  for (const [role, t] of Object.entries(rep.perRole)) {
    const model = rep.bySession && Object.values(rep.bySession).find((s) => s.role === role && s.model)?.model
    console.log(`  ${role.padEnd(16)} ${String(t.turns).padStart(5)} ${fmtTok(t.inputTokens).padStart(8)} ${fmtTok(t.outputTokens).padStart(8)} ${fmtTok(t.cacheReadTokens).padStart(8)} ${fmtTok(t.weightedTokens).padStart(9)}  ${model || ''}`)
  }
  const g = rep.grandTotal
  console.log(`  ${'OSSZESEN'.padEnd(16)} ${String(g.turns).padStart(5)} ${fmtTok(g.inputTokens).padStart(8)} ${fmtTok(g.outputTokens).padStart(8)} ${fmtTok(g.cacheReadTokens).padStart(8)} ${fmtTok(g.weightedTokens).padStart(9)}`)
  console.log(line)
  console.log(`HAND-OFF (atadasi) koltseg: ${rep.handoff.chars} char ~${fmtTok(rep.handoff.tokEst)} tok`)
  const est = rep.singleAgentEstimate
  console.log(line)
  console.log('EGY-AGENS ELLENPELDA (BECSLES, nem meres):')
  console.log(`  ${est.note}`)
  console.log(`  becsult sulyzott: ${fmtTok(est.weightedTokens)}  vs  tobb-agens mert: ${fmtTok(est.multiAgentWeighted)}`)
  console.log(`  a szetdarabolas becsult tobbletkoltsege: ${fmtTok(est.splitOverheadWeighted)} sulyzott token`)
  console.log(line)
  if (rep.timeline.length) {
    console.log('IDOVONAL:')
    for (const e of rep.timeline) {
      const el = e.elapsedMs !== null ? `+${Math.round(e.elapsedMs / 1000)}s` : ''
      const pl = e.payloadTokEst !== null ? ` [~${fmtTok(e.payloadTokEst)} tok]` : ''
      console.log(`  ${el.padStart(8)}  ${e.kind}${pl}  ${e.note}`)
    }
    console.log(line)
  }
  if (rep.sessionsMissing.length) {
    console.log(`FIGYELEM: ${rep.sessionsMissing.length} lekepezett session nem talalhato transcriptkent:`)
    for (const s of rep.sessionsMissing) console.log(`  - ${s}  (a "sessions" alparanccsal ellenorizd a nevet)`)
    console.log('  (ez NEM nulla-fogyasztas: nem lattunk ra a naplora. Kulon jelezve, nem osszemosva.)')
    console.log(line)
  }
}

async function main() {
  const [, , sub, ...rest] = process.argv
  const { flags, positional } = parseFlags(rest)
  switch (sub) {
    case 'start': await cmdStart(flags); break
    case 'mark': cmdMark(positional, flags); break
    case 'map': cmdMap(positional); break
    case 'sessions': cmdSessions(flags); break
    case 'report': cmdReport(positional, flags); break
    default:
      console.log('pipeline-token-monitor -- kanban #266')
      console.log('alparancsok: start | mark | map | sessions | report')
      console.log('  start --card <id|#seq> [--run <name>] [--role k=v,...] [--orchestrator <agent>]')
      console.log('  mark <run> <kind> [note...] [--chars N]')
      console.log('  map <run> <sessionId> <roleOrAgent>')
      console.log('  sessions [--agent <name>] [--since-hours N]')
      console.log('  report <run> [--json]')
      if (sub) process.exitCode = 2
  }
}

// Run the CLI only when invoked directly, so tests can import the helpers.
const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (invokedDirectly) {
  main().catch((e) => { console.error(`hiba: ${e.message}`); process.exitCode = 1 })
}
