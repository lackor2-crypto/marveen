/**
 * EGESZ DOKUMENTUM FORDITASA EGY GOMBBAL (kanban #501, Boss TG 2762-2769).
 *
 * Boss: "a Forditas gomb az EGESZ dokumentumot forditsa le (minden fejezet,
 * az 'Uj fejezet' cim is), ne uresen varja a kezi beirast". A regi ut a
 * Munkapad chatjenek kuldott egy kerest; ha az agens nem valaszolt (2026-10-07
 * 03:36: minden fiok kerete kifogyott), a valtozat ures, eredeti nyelvu
 * helyorzokkel allt, es semmi nem mondta meg, miert.
 *
 * Itt a SZERVER forditja le a valtozat minden leforditatlan es elavult
 * fejezetet, egymas utan, a Munkapad sajat szolgaltatojan at (ugyanaz a
 * fiokvalasztas, kozos keret-kapu es fiokvaltas limitnel, mint a chatben).
 * A mentes a meglevo `translateSection`-nel megy, tehat a forrasok, a
 * szoszedet-ellenorzes es az elavulas-jelzes ugyanugy mukodik. A haladas
 * es a hiba (emberi mondattal) a valtozat fejlecen latszik.
 */
import { getDb } from './db.js'
import { logger } from './logger.js'
import { listBlocks, listSections, type BlockRow } from './workbench-docmodel.js'
import { LANG_NAMES, listGlossary, translateSection, variantInfo, variantOf } from './workbench-doclang.js'
import { getWorkItem } from './workbench.js'
import { ensureWorkbenchAgent } from './workbench-agent/index.js'
import { msg, type Lang } from './workbench-agent/messages.js'
import { notReadyMessage, usageNotice } from './workbench-agent/orchestrator.js'
import { pickAIProvider, whyNoAIProvider } from './workbench-agent/provider.js'
import { OFF_BUDGET, record, reserve } from './workbench-agent/usage-manager.js'

/** Egy fejezet hanyszor probalhato (rossz JSON, hianyzo blokk): az elso hiba utan meg egyszer. */
export const SECTION_ATTEMPTS = 2

export interface TranslateJobState {
  variant_id: string
  lang: string
  running: boolean
  total: number
  done: number
  /** Az eppen forditott eredeti fejezet cime (a fejlec mutatja). */
  current: string | null
  /** A fejezetek, amelyeket a modell valasza utan sem sikerult menteni. */
  failed: { source_section: string; title: string; detail: string }[]
  /** Az eredeti allitasai, amelyek a forditasba nem kerultek at a forrasukkal. */
  claims_not_carried: number
  glossary_issues: number
  /** A szolgaltato-szintu leallas (nincs szolgaltato, kifogyott keret): emberi mondat. */
  error: { code: string; message: string } | null
  started_at: number
  finished_at: number | null
}

/** Egy modellhivas eredmenye: a teljes szoveg, vagy a kiadhato emberi mondat. */
export type TranslateCall =
  | { ok: true; text: string; account: string | null; model: string | null }
  | { ok: false; code: string; message: string; account?: string | null }

export type TranslateCaller = (req: { system: string; user: string; lang: Lang }) => Promise<TranslateCall>

const jobs = new Map<string, TranslateJobState>()
const runs = new Map<string, Promise<void>>()
let caller: TranslateCaller = callModel

/** Csak teszthez: a modellhivas cserelese. `null` visszaallitja a valodit. */
export function setTranslateCallerForTest(c: TranslateCaller | null): void { caller = c || callModel }
/** Csak teszthez: megvarja, amig a valtozat forditasa lefut. */
export async function waitForTranslationForTest(variantId: string): Promise<void> { await runs.get(variantId) }
/** Csak teszthez: a nyilvantartas uritese. */
export function resetTranslateJobsForTest(): void { jobs.clear(); runs.clear() }

const now = (): number => Math.floor(Date.now() / 1000)

let logReady: unknown = null
/** A kimeno adatok naploja (K-1.33): minden forditasi hivas, hogy a "Mi ment ki" lista ezt is mutassa. */
export function ensureTranslateLogTable(): void {
  const db = getDb()
  if (logReady === db) return
  db.exec(`CREATE TABLE IF NOT EXISTS wb_doc_translate_log (
    at INTEGER NOT NULL,
    work_item_id TEXT NOT NULL,
    account TEXT,
    model TEXT,
    chars INTEGER NOT NULL,
    status TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_wb_doc_translate_log_item ON wb_doc_translate_log(work_item_id, at);`)
  logReady = db
}

function logCall(itemId: string, chars: number, r: TranslateCall): void {
  try {
    ensureTranslateLogTable()
    getDb().prepare('INSERT INTO wb_doc_translate_log (at, work_item_id, account, model, chars, status) VALUES (?, ?, ?, ?, ?, ?)')
      .run(now(), itemId, r.account ?? null, r.ok ? r.model : null, chars, r.ok ? 'sent' : 'failed')
  } catch (e) { logger.warn({ err: e }, 'doclang-translate: egress log write failed') }
}

/** A valtozat forditasanak allapota (a fejlec ebbol mutatja a haladast), vagy null. */
export function translateJobState(variantId: string): TranslateJobState | null {
  const j = jobs.get(variantId)
  return j ? { ...j, failed: j.failed.slice() } : null
}

function langLabel(code: string): string {
  const n = LANG_NAMES[code]
  return n ? `${n.en} (${n.self})` : code.toUpperCase()
}

interface SourceBlock { id: string; kind: string; text: string; claims: { id: string; text: string }[] }

function sourceBlocks(sourceItemId: string, sectionId: string): SourceBlock[] {
  const blocks = listBlocks(sourceItemId).filter((b: BlockRow) => b.section_id === sectionId)
  const claimQ = getDb().prepare('SELECT id, text FROM wb_doc_claims WHERE block_id = ? ORDER BY created_at')
  return blocks.map((b) => ({ id: b.id, kind: b.kind, text: b.text, claims: claimQ.all(b.id) as { id: string; text: string }[] }))
}

/** A forditasi keres: a rendszer-utasitas es az eredeti fejezet (JSON). Tiszta, teszthez exportalva. */
export function buildTranslatePrompt(input: {
  targetLang: string
  title: string
  blocks: SourceBlock[]
  glossary: { term: string; translation: string }[]
}): { system: string; user: string } {
  const target = langLabel(input.targetLang)
  const gl = input.glossary.length
    ? `\n- Fixed translations from the case glossary -- where the term occurs, use exactly this translation:\n${input.glossary.map((g) => `  "${g.term}" -> "${g.translation}"`).join('\n')}`
    : ''
  const system = [
    `You are a professional translator of legal and official documents. You translate ONE section of a document into ${target}.`,
    'Rules:',
    '- Translate faithfully and completely: do not add, drop, summarise or soften anything. Names, numbers, dates, amounts, case numbers, file names and annex labels stay exact; translate the words around them.',
    '- Translate the section title too, even if it is only a placeholder such as "Új fejezet" (it means "New section").',
    '- Keep every block separate, in the same order, with the same id; keep the line breaks inside a block.',
    '- A block of kind "image" holds a picture file path: copy its text unchanged.',
    '- For each claim listed under a block, put into "claims" the part of YOUR translated block text that states that claim, copied word for word from your translation.' + gl,
    'Reply with ONE JSON object and nothing else -- no prose, no code fence:',
    '{"title": "<translated title>", "blocks": [{"id": "<block id>", "text": "<translated text>", "claims": [{"source_claim": "<claim id>", "text": "<verbatim part of your translated text>"}]}]}',
  ].join('\n')
  const user = JSON.stringify({
    title: input.title,
    blocks: input.blocks.map((b) => ({ id: b.id, kind: b.kind, text: b.text, claims: b.claims.map((c) => ({ id: c.id, text: c.text })) })),
  }, null, 1)
  return { system, user }
}

/** A modell valaszabol a mentheto forditas, vagy a hiba oka. Tiszta, teszthez exportalva. */
export function parseTranslation(text: string, src: SourceBlock[]):
  | { ok: true; title: string; blocks: { kind: string; text: string; claims: { source_claim: string; text: string }[] }[] }
  | { ok: false; detail: string } {
  const raw = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return { ok: false, detail: 'the model did not answer with a JSON object' }
  let v: unknown
  try { v = JSON.parse(raw.slice(start, end + 1)) } catch { return { ok: false, detail: 'the model answer is not valid JSON' } }
  const o = v as { title?: unknown; blocks?: unknown }
  const title = String(o.title ?? '').trim()
  if (!title) return { ok: false, detail: 'the translated title is missing' }
  const got = Array.isArray(o.blocks) ? o.blocks as { id?: unknown; text?: unknown; claims?: unknown }[] : []
  if (got.length !== src.length) return { ok: false, detail: `the original section has ${src.length} block(s), the translation ${got.length}` }
  const byId = new Map(got.map((b) => [String(b.id ?? ''), b]))
  const blocks = src.map((s, i) => {
    // Az id a biztos par; ha a modell elirta, a sorrend.
    const b = byId.get(s.id) ?? got[i] ?? {}
    const claims = (Array.isArray(b.claims) ? b.claims as { source_claim?: unknown; text?: unknown }[] : [])
      .map((c) => ({ source_claim: String(c.source_claim ?? ''), text: String(c.text ?? '') }))
    // A picture block is a file path, not words: it is never translated.
    if (s.kind === 'image') return { kind: s.kind, text: s.text, claims: [] }
    return { kind: s.kind, text: String(b.text ?? '').trim(), claims }
  })
  if (blocks.some((b) => !b.text)) return { ok: false, detail: 'a translated block is empty' }
  return { ok: true, title, blocks }
}

/**
 * A valtozat leforditando fejezetei, az eredeti sorrendjeben: amelyik meg
 * nincs lefordítva, elavult, vagy azota kerult az eredetibe.
 */
function pendingSections(variantId: string): { id: string; title: string }[] {
  const info = variantInfo(variantId)
  if (!info) return []
  const want = new Set<string>([
    ...info.sections.filter((s) => s.state === 'untranslated' || s.state === 'stale').map((s) => s.source_section_id),
    ...info.new_in_source.map((s) => s.id),
  ])
  return listSections(info.source_item_id).filter((s) => want.has(s.id)).map((s) => ({ id: s.id, title: s.title }))
}

/** A hiba kodja; az emberi mondatot a vegpont adja (`translate_<kod>`), kiveve a
 *  szolgaltato hianyat, amelynek az oka (melyik kulcs hianyzik) itt derul ki. */
export type StartTranslateResult =
  | { ok: true; job: TranslateJobState; started: boolean }
  | { ok: false; code: 'not_variant' | 'source_gone' | 'nothing' | 'no_provider'; message?: string }

/**
 * Az egesz valtozat forditasanak inditasa. Ha mar fut, a futo allapotat adja
 * (egy masodik kattintas nem indit masodik forditast). A munka a hatterben
 * megy; a hivo azonnal valaszt kap.
 */
export function startVariantTranslation(variantId: string, opts: { lang: Lang; by: string | null }): StartTranslateResult {
  const v = variantOf(variantId)
  if (!v) return { ok: false, code: 'not_variant' }
  const src = getWorkItem(v.source_item_id)
  if (!src || src.deleted_at) return { ok: false, code: 'source_gone' }
  const running = jobs.get(variantId)
  if (running && running.running) return { ok: true, job: translateJobState(variantId) as TranslateJobState, started: false }
  const pending = pendingSections(variantId)
  if (!pending.length) return { ok: false, code: 'nothing' }
  // A szolgaltato hianya azonnal kiderul: ne egy "fut" allapot utan, hanem a kattintasra.
  // Az ok a valtozat allapotaban is megmarad, hogy a fejlec (ujratoltes utan is) kimondja.
  if (caller === callModel) {
    ensureWorkbenchAgent()
    if (!pickAIProvider()) {
      const message = whyNoAIProvider(opts.lang)
      jobs.set(variantId, {
        variant_id: variantId, lang: v.lang, running: false, total: pending.length, done: 0, current: null,
        failed: [], claims_not_carried: 0, glossary_issues: 0, error: { code: 'no_provider', message }, started_at: now(), finished_at: now(),
      })
      return { ok: false, code: 'no_provider', message }
    }
  }
  const job: TranslateJobState = {
    variant_id: variantId, lang: v.lang, running: true, total: pending.length, done: 0, current: null,
    failed: [], claims_not_carried: 0, glossary_issues: 0, error: null, started_at: now(), finished_at: null,
  }
  jobs.set(variantId, job)
  const p = runJob(job, variantId, pending, opts)
    .catch((e) => {
      logger.warn({ err: e, variantId }, 'doclang-translate: job crashed')
      job.error = { code: 'failed', message: msg('provider_failed', opts.lang, { detail: e instanceof Error ? e.message : String(e) }) }
    })
    .finally(() => { job.running = false; job.current = null; job.finished_at = now(); runs.delete(variantId) })
  runs.set(variantId, p)
  return { ok: true, job: translateJobState(variantId) as TranslateJobState, started: true }
}

async function runJob(job: TranslateJobState, variantId: string, pending: { id: string; title: string }[], opts: { lang: Lang; by: string | null }): Promise<void> {
  const v = variantOf(variantId)
  const item = getWorkItem(variantId)
  if (!v || !item) return
  for (const s of pending) {
    job.current = s.title
    const blocks = sourceBlocks(v.source_item_id, s.id)
    // A fejezet cime az eredetiben azota valtozhatott: a mostanit forditjuk.
    const title = listSections(v.source_item_id).find((x) => x.id === s.id)?.title ?? s.title
    const glossary = listGlossary(item.project_id, v.lang).map((g) => ({ term: g.term, translation: g.translation }))
    const prompt = buildTranslatePrompt({ targetLang: v.lang, title, blocks, glossary })
    let detail = ''
    let saved = false
    for (let attempt = 0; attempt < SECTION_ATTEMPTS && !saved; attempt++) {
      const r = await caller({ system: prompt.system, user: prompt.user, lang: opts.lang })
      logCall(variantId, prompt.system.length + prompt.user.length, r)
      // Szolgaltato-szintu hiba (nincs fiok, kifogyott keret): a tobbi fejezet sem menne -- megallunk, kimondva.
      if (!r.ok) { job.error = { code: r.code, message: r.message }; return }
      const parsed = parseTranslation(r.text, blocks)
      if (!parsed.ok) { detail = parsed.detail; continue }
      const t = translateSection(variantId, { source_section: s.id, title: parsed.title, blocks: parsed.blocks }, opts.by)
      if (!t.ok) { detail = t.detail; continue }
      saved = true
      job.done++
      job.claims_not_carried += t.result.claims_not_carried.length
      job.glossary_issues += t.result.glossary_issues.length
    }
    if (!saved) job.failed.push({ source_section: s.id, title, detail })
  }
}

/**
 * Egy modellhivas a Munkapad szolgaltatojan at, ugyanazzal a fiok- es
 * keret-kezelessel, mint a chat: a kozos 5 oras kapu fiokonkent, limitnel a
 * kovetkezo fiok. A valasz a teljes szoveg; hiba eseten az emberi mondat.
 */
async function callModel(req: { system: string; user: string; lang: Lang }): Promise<TranslateCall> {
  ensureWorkbenchAgent()
  const provider = pickAIProvider()
  if (!provider) return { ok: false, code: 'no_provider', message: whyNoAIProvider(req.lang) }
  if (!provider.availability().available) return { ok: false, code: 'no_provider', message: notReadyMessage(provider, req.lang) }
  const onClaudeBudget = provider.onClaudeBudget?.() ?? true
  let candidates: (string | undefined)[] = onClaudeBudget ? (provider.accounts?.() || []) : []
  if (!candidates.length) candidates = [undefined]
  let blocked: { code: string; message: string } | null = null
  let last: TranslateCall | null = null
  for (const account of candidates) {
    const budgetKey = onClaudeBudget ? account : OFF_BUDGET
    const gate = usageNotice(req.lang, budgetKey)
    if (gate) { blocked = gate; if (gate.code === 'too_many_in_flight') break; continue }
    const res = reserve(budgetKey)
    if (!res.ok) {
      blocked = {
        code: res.reason,
        message: res.reason === 'too_many_in_flight'
          ? msg('too_many_in_flight', req.lang, { n: res.usage.inFlight })
          : msg('limit_critical', req.lang, { pct: res.usage.usedPct === null ? '?' : Math.round(res.usage.usedPct), reset: msg('limit_reset_unknown', req.lang) }),
      }
      if (res.reason === 'too_many_in_flight') break
      continue
    }
    const startedAt = Date.now()
    let text = ''
    let model: string | null = null
    let via: string | null = account ?? null
    let failure: { code: string; message: string; limit: boolean } | null = null
    try {
      for await (const chunk of provider.stream({ system: req.system, messages: [{ role: 'user', content: req.user }], lang: req.lang, account })) {
        if (chunk.kind === 'text') text += chunk.text
        else if (chunk.kind === 'done') { model = chunk.model; if (chunk.via && chunk.via.kind === 'account') via = chunk.via.account }
        else {
          failure = chunk.code === 'limit'
            ? { code: 'all_accounts_limited', message: onClaudeBudget ? msg('all_accounts_limited', req.lang) : msg('model_provider_limited', req.lang, { model: provider.model() }), limit: true }
            : chunk.code === 'not_configured'
              ? { code: 'no_provider', message: notReadyMessage(provider, req.lang), limit: false }
              : chunk.code === 'no_answer'
                ? { code: 'provider_no_answer', message: msg('provider_no_answer', req.lang), limit: false }
                : { code: 'provider_failed', message: msg('provider_failed', req.lang, { detail: chunk.detail }), limit: false }
        }
      }
    } catch (e) {
      failure = { code: 'provider_failed', message: msg('provider_failed', req.lang, { detail: e instanceof Error ? e.message : String(e) }), limit: false }
    } finally {
      record(res.reservation.id, { agent: 'doc-translate', model: provider.model(), outcome: failure ? (failure.limit ? 'limit' : 'error') : 'ok', durationMs: Date.now() - startedAt })
    }
    if (!failure) return { ok: true, text, account: via, model }
    last = { ok: false, code: failure.code, message: failure.message, account: via }
    // Ennek a fioknak fogyott el a kerete: a kovetkezo probalja.
    if (failure.limit) continue
    return last
  }
  if (last) return last
  return { ok: false, code: blocked?.code ?? 'no_provider', message: blocked?.message ?? whyNoAIProvider(req.lang) }
}
