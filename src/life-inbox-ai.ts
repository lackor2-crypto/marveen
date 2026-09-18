// AI classifier for the Inbox (card 56530b08).
//
// Boss, 2026-09-18: the Inbox suggestion must be "professional" -- read the
// document, tell what it is, whose it is, its date, and where it belongs (or
// which NEW folder it should get when nothing fits). Decisions:
//   msg 1026 "csinald az A t."        -> Claude from the owner's own subscription
//   msg 1028 "ha nincs is claude fiok a gepen akkor ne lepodjon meg es azzal
//            csinalja ami van a gepen!" -> fall back to what the machine has
//   msg 1030 "lehetoleg mindig a legokosabb modellel." -> the strongest model
//
// The chain, first that answers wins:
//   1. `claude -p` on a subscription account that still has 5-hour limit left,
//      asking for the latest Opus (falls back to Sonnet inside the CLI);
//   2. a local Ollama model (the largest chat model installed);
//   3. nothing -- the rule-based suggestion stays, and the UI says so.
//
// Never a paid API: the child environment is stripped of every API-key /
// base-URL variable, so the CLI can only use the account's own OAuth login.
// Every answer is VALIDATED here: owner ids, folders and dates the model
// invents are dropped, a new folder can only be created inside a person's own
// folder, and nothing is moved -- the user still confirms every placement.
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAIN_AGENT_ID, OLLAMA_URL } from './config.js'
import { logger } from './logger.js'
import { tierForPct, STALE_AFTER_MS } from './rate-limit-status.js'
import { tryResolveFromPath } from './platform.js'
import { rankModelTier } from './web/smartest-worker.js'
import { listAgentNames, readAgentModel } from './web/agent-config.js'
import { resolveAgentConfigDir } from './web/claude-plans.js'
import { readRateLimitSnapshot } from './web/rate-limit-status-io.js'
import { T, type AiInfo, type DateCandidate, type InboxSuggestion, type KnownFolder, type Prefetched } from './life-inbox-analyze.js'
import { humanLocation } from './life-explorer.js'
import type { LifeConfig } from './life-tree.js'

const CLAUDE_TIMEOUT_MS = 180_000
// A small model on CPU: tens of seconds per document. One item per call, and
// after the first timeout we stop asking -- the rules' suggestion stays.
const OLLAMA_TIMEOUT_MS = 240_000
/** Characters of document text per item: the first pages carry sender, date, subject. */
const TEXT_PER_ITEM = 4000
/** Folders listed in the prompt; shallow ones first. */
const MAX_PROMPT_FOLDERS = 600
const MAX_PROMPT_FOLDERS_LOCAL = 80
const MAX_ITEMS_PER_CALL = 12

// ---------------------------------------------------------------------------
// Which Claude account?
// ---------------------------------------------------------------------------
export interface ClaudeAccount {
  agent: string
  configDir: string
  /** The model the agent itself runs on -- tells which plan the account has. */
  model: string
  fiveHourPct: number | null
  usageAt: number | null
}

/**
 * Accounts worth trying, best first: a Claude-model agent whose login exists
 * on disk and whose 5-hour limit is not critical (only the 5-hour frame counts,
 * the weekly number is display only). Several agents may share one login --
 * each login is tried once. Pure: the caller gathers the live data.
 */
export function orderClaudeAccounts(cands: ClaudeAccount[], now: number = Date.now()): ClaudeAccount[] {
  const seen = new Set<string>()
  return cands
    .filter((c) => rankModelTier(c.model) >= 200)
    .filter((c) => {
      if (c.fiveHourPct === null) return true
      if (c.usageAt !== null && now - c.usageAt > STALE_AFTER_MS) return true
      return tierForPct(c.fiveHourPct) !== 'critical'
    })
    .sort((a, b) => {
      const ap = a.fiveHourPct ?? -1
      const bp = b.fiveHourPct ?? -1
      if (ap !== bp) return ap - bp
      return rankModelTier(b.model) - rankModelTier(a.model) || a.agent.localeCompare(b.agent)
    })
    .filter((c) => (seen.has(c.configDir) ? false : (seen.add(c.configDir), true)))
}

function listClaudeAccounts(): ClaudeAccount[] {
  const out: ClaudeAccount[] = []
  for (const agent of [MAIN_AGENT_ID, ...listAgentNames()]) {
    try {
      const dir = resolveAgentConfigDir(agent).configDir || join(homedir(), '.claude')
      if (!existsSync(join(dir, '.credentials.json'))) continue
      const snap = readRateLimitSnapshot(agent)
      out.push({
        agent, configDir: dir, model: readAgentModel(agent),
        fiveHourPct: snap?.fiveHour?.usedPct ?? null,
        usageAt: snap?.updatedAt && snap.updatedAt > 0 ? snap.updatedAt : null,
      })
    } catch { /* one broken agent config must not hide the others */ }
  }
  return orderClaudeAccounts(out)
}

// ---------------------------------------------------------------------------
// Runners (injectable for tests)
// ---------------------------------------------------------------------------
export interface RunnerAnswer { text: string; model: string }
export type ClaudeRunner = (system: string, prompt: string, account: ClaudeAccount) => Promise<RunnerAnswer | null>
/** 'missing' = no local model server / no chat model; null = there is one, but it gave no answer. */
export type OllamaRunner = (system: string, prompt: string) => Promise<RunnerAnswer | 'missing' | null>

// Variables that would route the CLI to a paid API or a foreign endpoint.
const STRIPPED_ENV = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'OPENROUTER_API_KEY',
]

const realClaudeRunner: ClaudeRunner = (system, prompt, account) => {
  const bin = tryResolveFromPath('claude')
  if (!bin) return Promise.resolve(null)
  const cwd = mkdtempSync(join(tmpdir(), 'marveen-inbox-ai-'))
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CONFIG_DIR: account.configDir }
  for (const k of STRIPPED_ENV) delete env[k]
  const args = [
    '-p', '--model', 'opus', '--fallback-model', 'sonnet',
    '--tools', '', '--setting-sources', 'project', '--no-session-persistence',
    '--output-format', 'json', '--system-prompt', system,
  ]
  return new Promise((resolve) => {
    let out = ''
    let done = false
    const finish = (v: RunnerAnswer | null) => {
      if (done) return
      done = true
      clearTimeout(timer)
      try { rmSync(cwd, { recursive: true, force: true }) } catch { /* temp dir already gone */ }
      resolve(v)
    }
    const child = spawn(bin, args, { cwd, env, stdio: ['pipe', 'pipe', 'ignore'] })
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(null) }, CLAUDE_TIMEOUT_MS)
    child.stdout.on('data', (d) => { out += d })
    child.on('error', () => finish(null))
    child.on('close', () => {
      try {
        const j = JSON.parse(out)
        if (j.is_error || typeof j.result !== 'string') return finish(null)
        const model = Object.keys(j.modelUsage || {}).find((m) => m.includes('opus'))
          || Object.keys(j.modelUsage || {})[0] || 'claude'
        finish({ text: j.result, model })
      } catch {
        finish(null)
      }
    })
    child.stdin.end(prompt)
  })
}

async function fetchJson(url: string, init: RequestInit, timeoutMs: number): Promise<any> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const r = await fetch(url, { ...init, signal: ctl.signal })
    if (!r.ok) return null
    return await r.json()
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** The largest installed chat model (embedding models cannot answer). */
export function pickOllamaModel(models: Array<{ name: string; size?: number }>): string {
  const chat = models.filter((m) => !/embed|bge|minilm|nomic/i.test(m.name))
  chat.sort((a, b) => (b.size || 0) - (a.size || 0))
  return chat[0]?.name || ''
}

const realOllamaRunner: OllamaRunner = async (system, prompt) => {
  const tags = await fetchJson(`${OLLAMA_URL}/api/tags`, {}, 3000)
  const model = pickOllamaModel(Array.isArray(tags?.models) ? tags.models : [])
  if (!model) return 'missing'
  const j = await fetchJson(`${OLLAMA_URL}/api/generate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, system, prompt, stream: false, format: 'json', options: { temperature: 0.1, num_ctx: 8192 } }),
  }, OLLAMA_TIMEOUT_MS)
  if (!j || typeof j.response !== 'string') return null
  return { text: j.response, model }
}

let claudeRunner: ClaudeRunner = realClaudeRunner
let ollamaRunner: OllamaRunner = realOllamaRunner
let accountLister: () => ClaudeAccount[] = listClaudeAccounts

/** Tests only: replace the external calls. `null` restores the real one. */
export function setAiRunners(r: { claude?: ClaudeRunner | null; ollama?: OllamaRunner | null; accounts?: (() => ClaudeAccount[]) | null }): void {
  if (r.claude !== undefined) claudeRunner = r.claude || realClaudeRunner
  if (r.ollama !== undefined) ollamaRunner = r.ollama || realOllamaRunner
  if (r.accounts !== undefined) accountLister = r.accounts || listClaudeAccounts
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT = `You file personal documents into a family "life tree" folder structure.
For EVERY input item decide: whose document it is, what it is, its own date, and where it belongs.
Rules:
- ownerId: one of the given person ids, or "" if the document gives no evidence. Names may appear without accents or in another word order (e.g. "Laszlo Korpas" = "Korpás László").
- date: the document's OWN date (issue/letter/statement date) as YYYY-MM-DD. Never a birth date, never an expiry date. Prefer a date written in the text; otherwise use the best metadata candidate; "" if unknown.
- targetRel: the single best EXISTING folder from the list, as written there (the deepest fitting one). "" if none fits well.
- newFolderRel: ONLY if no existing folder fits well: a new folder path that starts with an existing folder from the list and adds one or two new segments (e.g. "Korpás László/Hatóságok/Németország/Einwohnermeldeamt"). Otherwise "".
- suggestedName: a short, descriptive file name WITHOUT extension, in the document's own terms, format "<Owner name>_<YYYY-MM>_<short-title>" when owner and date are known.
- docType: the document type in a few words, in the answer language. summary: one sentence in the answer language. reason: one or two sentences in the answer language explaining owner, date and folder.
- confidence: 0..1.
Answer with ONLY a JSON object: {"items":[{"name":...,"ownerId":...,"docType":...,"summary":...,"date":...,"targetRel":...,"newFolderRel":...,"suggestedName":...,"reason":...,"confidence":...}]}. No prose, no code fence.`

interface PromptItem {
  name: string
  kind: string
  text: string
  metadata: Record<string, string>
  dateCandidates: DateCandidate[]
}

function promptFolders(folders: KnownFolder[], max: number): string[] {
  return [...folders]
    .sort((a, b) => a.rel.split('/').length - b.rel.split('/').length || a.rel.localeCompare(b.rel))
    .slice(0, max)
    .map((f) => f.rel)
}

export function buildPrompt(items: PromptItem[], config: LifeConfig, folders: KnownFolder[], lang: string, local: boolean): string {
  const answerLang = lang === 'en' ? 'English' : 'Hungarian'
  const payload = {
    answerLanguage: answerLang,
    persons: config.persons.map((p) => ({ id: p.id, name: p.name, role: p.role || '' })),
    existingFolders: promptFolders(folders, local ? MAX_PROMPT_FOLDERS_LOCAL : MAX_PROMPT_FOLDERS),
    items: items.map((i) => ({ ...i, text: i.text.slice(0, local ? 2000 : TEXT_PER_ITEM) })),
  }
  return JSON.stringify(payload)
}

// ---------------------------------------------------------------------------
// Answer parsing + validation
// ---------------------------------------------------------------------------
export interface AiItemResult {
  name: string
  ownerId: string
  docType: string
  summary: string
  date: string
  targetRel: string
  newFolderRel: string
  suggestedName: string
  reason: string
  confidence: number
}

function extractJson(text: string): any {
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
  try { return JSON.parse(t) } catch { /* fall through */ }
  const start = t.indexOf('{')
  const end = t.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try { return JSON.parse(t.slice(start, end + 1)) } catch { /* not JSON */ }
  }
  return null
}

const str = (v: unknown, max = 400): string => (typeof v === 'string' ? v.trim().slice(0, max) : '')

function validDate(s: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!m) return ''
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3])
  if (y < 1900 || y > 2100 || mo < 1 || mo > 12 || d < 1) return ''
  if (d > new Date(Date.UTC(y, mo, 0)).getUTCDate()) return ''
  return s
}

const BAD_SEGMENT = /[<>:"\\|?*\u0000-\u001f]/

/** A new folder must extend an existing one inside a person's folder, by one or two safe segments. */
export function validNewFolder(rel: string, known: Set<string>): string {
  const segs = rel.split('/').map((s) => s.trim()).filter(Boolean)
  if (segs.length < 2) return ''
  if (segs.some((s) => s === '.' || s === '..' || s.startsWith('.') || BAD_SEGMENT.test(s) || s.length > 80)) return ''
  const clean = segs.join('/')
  if (known.has(clean)) return ''
  for (let cut = segs.length - 1; cut >= Math.max(1, segs.length - 2); cut--) {
    if (known.has(segs.slice(0, cut).join('/'))) return clean
  }
  return ''
}

function safeFileStem(s: string): string {
  return s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120)
}

export function parseAiAnswer(text: string, names: string[], config: LifeConfig, folders: KnownFolder[]): AiItemResult[] {
  const j = extractJson(text)
  const raw: any[] = Array.isArray(j?.items) ? j.items : Array.isArray(j) ? j : []
  const personIds = new Set(config.persons.map((p) => p.id))
  const known = new Set(folders.map((f) => f.rel))
  const wanted = new Set(names)
  const out: AiItemResult[] = []
  for (const r of raw) {
    const name = str(r?.name, 500)
    if (!wanted.has(name) || out.some((o) => o.name === name)) continue
    const targetRel = known.has(str(r.targetRel, 1000)) ? str(r.targetRel, 1000) : ''
    const newFolderRel = targetRel ? '' : validNewFolder(str(r.newFolderRel, 1000), known)
    const conf = Number(r.confidence)
    out.push({
      name,
      ownerId: personIds.has(str(r.ownerId)) ? str(r.ownerId) : '',
      docType: str(r.docType, 120),
      summary: str(r.summary, 400),
      date: validDate(str(r.date, 20)),
      targetRel,
      newFolderRel,
      suggestedName: safeFileStem(str(r.suggestedName, 200)),
      reason: str(r.reason, 600),
      confidence: Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : 0.5,
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// The chain
// ---------------------------------------------------------------------------
export type AiEngine = 'claude' | 'ollama' | 'none'

export interface AiRun {
  engine: AiEngine
  model: string
  results: AiItemResult[]
  /** One sentence for the UI: which engine answered, or why none did. */
  note: string
}

export interface AiInputItem {
  suggestion: InboxSuggestion
  prefetched: Prefetched | undefined
}

function promptItem(it: AiInputItem): PromptItem {
  const s = it.suggestion
  const pdf = it.prefetched?.pdf
  const metadata: Record<string, string> = {}
  if (pdf?.title) metadata.pdfTitle = pdf.title
  if (pdf?.author) metadata.pdfAuthor = pdf.author
  if (pdf?.creator) metadata.pdfCreator = pdf.creator
  if (pdf?.creationDate) metadata.pdfCreated = pdf.creationDate
  if (s.contentSource) metadata.textSource = s.contentSource
  const dates: DateCandidate[] = s.date.value ? [{ value: s.date.value, source: s.date.source }] : []
  for (const a of s.date.alternatives || []) if (!dates.some((d) => d.value === a.value)) dates.push(a)
  return { name: s.name, kind: s.type.value, text: it.prefetched?.content.text || '', metadata, dateCandidates: dates }
}

async function runBatch(items: PromptItem[], config: LifeConfig, folders: KnownFolder[], lang: string): Promise<AiRun> {
  const names = items.map((i) => i.name)
  const tried: string[] = []
  for (const account of accountLister().slice(0, 2)) {
    tried.push(account.agent)
    const ans = await claudeRunner(SYSTEM_PROMPT, buildPrompt(items, config, folders, lang, false), account).catch(() => null)
    const results = ans ? parseAiAnswer(ans.text, names, config, folders) : []
    if (results.length) {
      return {
        engine: 'claude', model: ans!.model, results,
        note: T(lang, `A javaslatot a Claude (${ans!.model}) készítette.`, `Suggested by Claude (${ans!.model}).`),
      }
    }
    logger.warn({ agent: account.agent }, 'inbox-ai: Claude account gave no usable answer, trying the next engine')
  }
  // Local model: one document per call (a small CPU model loses track of a
  // batch, and one slow answer must not cost the whole batch).
  const localResults: AiItemResult[] = []
  let localModel = ''
  let localState: 'missing' | 'failed' | 'ok' = 'failed'
  for (const item of items) {
    const ans = await ollamaRunner(SYSTEM_PROMPT, buildPrompt([item], config, folders, lang, true)).catch(() => null)
    if (ans === 'missing') { localState = 'missing'; break }
    if (!ans) break
    const got = parseAiAnswer(ans.text, [item.name], config, folders)
    // A one-item answer may come without the name: it can only be this item.
    if (!got.length) {
      const j = extractJson(ans.text)
      const one = Array.isArray(j?.items) && j.items.length === 1 ? j.items[0] : (j && !Array.isArray(j) && !j.items ? j : null)
      if (one) got.push(...parseAiAnswer(JSON.stringify({ items: [{ ...one, name: item.name }] }), [item.name], config, folders))
    }
    localResults.push(...got)
    localModel = ans.model
    localState = 'ok'
  }
  if (localResults.length) {
    const why = tried.length
      ? T(lang, 'a Claude most nem válaszolt', 'Claude did not answer now')
      : T(lang, 'ezen a gépen nincs használható Claude-fiók', 'there is no usable Claude account on this machine')
    return {
      engine: 'ollama', model: localModel, results: localResults,
      note: T(lang,
        `A javaslatot a gépen futó helyi modell (${localModel}) készítette, mert ${why}. Kevésbé pontos, nézd át.`,
        `Suggested by the local model on this machine (${localModel}) because ${why}. Less accurate, please review.`),
    }
  }
  if (localState !== 'missing') {
    return {
      engine: 'none', model: '', results: [],
      note: tried.length
        ? T(lang, 'Sem a Claude, sem a helyi modell nem válaszolt most, ezért a szabályok szerinti javaslat maradt.',
          'Neither Claude nor the local model answered now, so the rule-based suggestion stays.')
        : T(lang, 'Nincs használható Claude-fiók, és a helyi modell nem válaszolt időben, ezért a szabályok szerinti javaslat maradt.',
          'There is no usable Claude account and the local model did not answer in time, so the rule-based suggestion stays.'),
    }
  }
  return {
    engine: 'none', model: '', results: [],
    note: tried.length
      ? T(lang, 'Az AI most nem válaszolt, ezért a szabályok szerinti javaslat maradt.', 'The AI did not answer now, so the rule-based suggestion stays.')
      : T(lang,
        'Ezen a gépen nincs elérhető AI (se Claude-fiók, se helyi modell), ezért a szabályok szerinti javaslatot látod.',
        'No AI is available on this machine (no Claude account, no local model), so you see the rule-based suggestion.'),
  }
}

/** Ask the AI about the given items, in batches. Credential items are never sent. */
export async function classifyWithAi(inputs: AiInputItem[], config: LifeConfig, folders: KnownFolder[], lang: string): Promise<AiRun> {
  const items = inputs.filter((i) => !i.suggestion.credentialWarning).map(promptItem)
  if (!items.length) return { engine: 'none', model: '', results: [], note: '' }
  const merged: AiRun = { engine: 'none', model: '', results: [], note: '' }
  for (let i = 0; i < items.length; i += MAX_ITEMS_PER_CALL) {
    const run = await runBatch(items.slice(i, i + MAX_ITEMS_PER_CALL), config, folders, lang)
    merged.results.push(...run.results)
    if (merged.engine === 'none' || run.engine === 'claude') {
      merged.engine = run.engine; merged.model = run.model; merged.note = run.note
    }
  }
  return merged
}

/** Put the AI's answer on top of the rule-based suggestion. Unknown fields keep the rule's value. */
export function mergeAiIntoSuggestion(s: InboxSuggestion, r: AiItemResult, run: Pick<AiRun, 'engine' | 'model'>, config: LifeConfig): InboxSuggestion {
  const out: InboxSuggestion = { ...s, notes: [...s.notes] }
  if (r.ownerId) {
    const p = config.persons.find((x) => x.id === r.ownerId)
    if (p) out.owner = { ...s.owner, personId: p.id, name: p.name, confidence: Math.max(r.confidence, 0.6), uncertain: r.confidence < 0.55 }
  }
  if (r.date && r.date !== s.date.value) {
    const alts = [{ value: s.date.value, source: s.date.source }, ...(s.date.alternatives || [])]
      .filter((a) => a.value && a.value !== r.date)
    out.date = { value: r.date, source: 'ai', confidence: r.confidence, alternatives: alts.slice(0, 4) }
  }
  const target = r.targetRel || r.newFolderRel
  if (target) {
    out.targetRel = target
    out.targetDisplay = humanLocation(target)
    out.targetExists = !!r.targetRel
    // The rule's "folder does not exist" note talked about ITS target.
    out.notes = out.notes.filter((n) => !n.includes('Mappa létrehozása') && !n.includes('Create folder'))
  }
  if (r.suggestedName) out.suggestedName = r.suggestedName
  const info: AiInfo = {
    engine: run.engine, model: run.model, docType: r.docType, summary: r.summary, reason: r.reason,
    newFolder: !r.targetRel && !!r.newFolderRel,
  }
  out.ai = info
  out.needsReview = out.owner.uncertain || !out.targetRel || !out.targetExists || r.confidence < 0.55
  return out
}
