/**
 * PROJEKT NELKULI KARTYAK BESOROLASA -- A TARTALMUK ALAPJAN (kanban #321,
 * migracio 4. pont).
 *
 * A tulajdonos dontese: a regi, projekt nelkuli kartyak besorolhatok, de NEM
 * vakon a cimkejukbol (a cimke a munka JELLEGE, nem az, hogy minek a munkaja),
 * hanem a tartalmuk szerint; ami egyik projekthez sem illik, vagy bizonytalan,
 * az projekt nelkul marad, es a tulajdonos ele kerul.
 *
 * Ez a modul CSAK JAVASOL. Semmit nem mozgat: a javaslat egy kulon tablaba
 * kerul (`project_card_suggestions`), a felulet kartyankent mutatja, es csak a
 * tulajdonos altal jovahagyott lista megy at a `applyProjectMigration`
 * `cards` mezojeben -- naplozva, visszavonhatoan.
 *
 * A javaslatot ugyanaz a lanc adja, mint a Beerkezo iktatasat es a projekt-
 * osszefoglalot: a tulajdonos sajat Claude-elofizetese, aztan a gepen futo
 * helyi modell -- fizetos API soha. A modell a kartya cimet es leirasat, a
 * projektek nevet, leirasat es par meglevo kartyajuk cimet kapja; a cimke csak
 * jelzeskent megy at. A valaszt a kod ellenorzi: ismeretlen kartya- vagy
 * projekt-azonosito nem kerulhet be, a hianyzo kartya "bizonytalan" lesz.
 *
 * Egyszerre egy futas lehet; a futas a hatterben megy, a felulet a haladast
 * kerdezi le (`classificationStatus`).
 */
import { randomUUID } from 'node:crypto'
import { getDb } from './db.js'
import { askAiJson } from './life-inbox-ai.js'
import { ensureProjectTables, hasTable } from './projects.js'

/** Ennyi kartya megy egy kerdesben: eleg kicsi, hogy a modell minden kartyat
 *  vegigolvasson, eleg nagy, hogy par szaz kartya par perc alatt meglegyen. */
export const CLASSIFY_BATCH = 15
/** Ez alatt a magabiztossag alatt a javaslat "bizonytalan": a felulet nem
 *  jeloli ki elore, a kartya projekt nelkul marad, hacsak a tulajdonos masket nem dont. */
export const CONFIDENT = 0.75

const DESC_CHARS = 600
const SAMPLE_CARDS = 12

export interface CardSuggestion {
  cardId: string
  /** A javasolt projekt, vagy NULL = egyik sem / bizonytalan. */
  projectId: string | null
  confidence: number
  reason: string
  engine: string
  createdAt: number
}

export type ClassifyState = 'idle' | 'running' | 'done' | 'failed'

export interface ClassifyStatus {
  state: ClassifyState
  runId: string | null
  total: number
  done: number
  /** Ennyi kartyara nem jott hasznalhato valasz (ujra kerheto). */
  failed: number
  startedAt: number | null
  finishedAt: number | null
  /** `no_ai` = nincs hasznalhato Claude-fiok es helyi modell sem; `no_projects` = nincs projekt, amibe sorolni lehetne. */
  error: '' | 'no_ai' | 'no_projects' | 'nothing_to_do'
  engine: string
}

const status: ClassifyStatus = { state: 'idle', runId: null, total: 0, done: 0, failed: 0, startedAt: null, finishedAt: null, error: '', engine: '' }

export function classificationStatus(): ClassifyStatus {
  return { ...status }
}

/** Csak teszthez. */
export function resetClassificationForTests(): void {
  Object.assign(status, { state: 'idle', runId: null, total: 0, done: 0, failed: 0, startedAt: null, finishedAt: null, error: '', engine: '' })
}

function ensureSuggestionTable(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS project_card_suggestions (
      card_id TEXT PRIMARY KEY,
      project_id TEXT,
      confidence REAL NOT NULL,
      reason TEXT,
      engine TEXT,
      run_id TEXT,
      created_at INTEGER NOT NULL
    )
  `)
}

/** A MEG MINDIG projekt nelkuli kartyak javaslatai (ami azota projektet kapott,
 *  vagy aminek a javasolt projektje kozben megszunt, az nem jon -- illetve
 *  "bizonytalan"-kent jon). */
export function listCardSuggestions(): CardSuggestion[] {
  if (!hasTable('project_card_suggestions') || !hasTable('kanban_cards')) return []
  ensureProjectTables()
  return (getDb().prepare(
    `SELECT s.card_id, CASE WHEN p.id IS NULL OR p.archived_at IS NOT NULL THEN NULL ELSE s.project_id END AS project_id,
            s.confidence, s.reason, s.engine, s.created_at
       FROM project_card_suggestions s
       JOIN kanban_cards k ON k.id = s.card_id AND (k.project IS NULL OR TRIM(k.project) = '')
       LEFT JOIN projects p ON p.id = s.project_id`,
  ).all() as { card_id: string; project_id: string | null; confidence: number; reason: string | null; engine: string | null; created_at: number }[])
    .map((r) => ({ cardId: r.card_id, projectId: r.project_id, confidence: r.confidence, reason: r.reason ?? '', engine: r.engine ?? '', createdAt: r.created_at * 1000 }))
}

interface ProjectBrief { id: string; name: string; description: string | null; client: string | null; samples: string[] }
interface CardBrief { id: string; title: string; description: string; labels: string[] }

function loadProjects(): ProjectBrief[] {
  ensureProjectTables()
  const db = getDb()
  const rows = db.prepare('SELECT id, name, description, client FROM projects WHERE archived_at IS NULL ORDER BY name COLLATE NOCASE').all() as
    { id: string; name: string; description: string | null; client: string | null }[]
  const sample = hasTable('kanban_cards')
    ? db.prepare(`SELECT title FROM kanban_cards WHERE project = ? ORDER BY updated_at DESC LIMIT ${SAMPLE_CARDS}`)
    : null
  return rows.map((r) => ({ ...r, samples: sample ? (sample.all(r.id) as { title: string }[]).map((x) => x.title) : [] }))
}

function loadUnassigned(): CardBrief[] {
  if (!hasTable('kanban_cards')) return []
  const db = getDb()
  const rows = db.prepare(
    `SELECT id, title, description FROM kanban_cards WHERE project IS NULL OR TRIM(project) = ''
      ORDER BY (archived_at IS NULL) DESC, updated_at DESC`,
  ).all() as { id: string; title: string; description: string | null }[]
  const labels = new Map<string, string[]>()
  if (rows.length && hasTable('kanban_card_labels') && hasTable('labels')) {
    for (const r of db.prepare(
      `SELECT cl.card_id, lb.name FROM kanban_card_labels cl JOIN labels lb ON lb.id = cl.label_id
         JOIN kanban_cards k ON k.id = cl.card_id WHERE k.project IS NULL OR TRIM(k.project) = ''`,
    ).all() as { card_id: string; name: string }[]) {
      const l = labels.get(r.card_id) ?? []
      l.push(r.name)
      labels.set(r.card_id, l)
    }
  }
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    description: String(r.description ?? '').replace(/\s+/g, ' ').trim().slice(0, DESC_CHARS),
    labels: labels.get(r.id) ?? [],
  }))
}

const SYSTEM = `You sort work items (kanban cards) into the owner's projects BY THEIR CONTENT.
A project is WHAT the work belongs to (a product, a client, an undertaking). A label is only the KIND of work -- never decide from the label alone.
For every card pick the ONE project whose work it clearly is, judging from the card's title and description and from the project's name, description and example cards.
If the card fits none of the projects, or it could belong to more than one, or you are not sure: answer null. A wrong project is worse than null -- the owner reviews every null by hand.
Never invent project ids or card ids. Answer with ONLY a JSON object, no prose, no code fence:
{"items":[{"id":"<card id>","project":"<project id or null>","confidence":<0..1>,"reason":"<max 12 words, in the requested language>"}]}`

/** A modellnek szolo kerdes. Exportalva a teszt miatt. */
export function classifyPrompt(projects: ProjectBrief[], cards: CardBrief[], lang: 'hu' | 'en'): string {
  const L: string[] = []
  L.push(`Answer language for "reason": ${lang === 'en' ? 'English' : 'Hungarian'}`)
  L.push('')
  L.push('PROJECTS:')
  for (const p of projects) {
    L.push(`- id ${p.id}: "${p.name}"${p.description ? ` -- ${p.description.replace(/\s+/g, ' ').slice(0, 300)}` : ''}${p.client ? ` (for: ${p.client})` : ''}`)
    if (p.samples.length) L.push(`  example cards: ${p.samples.map((t) => `"${t.slice(0, 80)}"`).join('; ')}`)
  }
  L.push('')
  L.push('CARDS TO SORT:')
  for (const c of cards) {
    L.push(`- id ${c.id}: "${c.title.slice(0, 200)}"${c.labels.length ? ` [label hint: ${c.labels.join(', ')}]` : ''}`)
    if (c.description) L.push(`  description: ${c.description}`)
  }
  return L.join('\n')
}

type Parsed = { id: string; project: string | null; confidence: number; reason: string }[]

/** A valasz ellenorzese: csak a kerdezett kartyak, csak letezo projektek. */
export function parseClassifyAnswer(json: any, cardIds: Set<string>, projectIds: Set<string>): Parsed | null {
  const items = json && Array.isArray(json.items) ? json.items : null
  if (!items) return null
  const out: Parsed = []
  const seen = new Set<string>()
  for (const it of items) {
    const id = typeof it?.id === 'string' ? it.id.trim() : ''
    if (!cardIds.has(id) || seen.has(id)) continue
    seen.add(id)
    const pid = typeof it.project === 'string' && projectIds.has(it.project.trim()) ? it.project.trim() : null
    let conf = Number(it.confidence)
    if (!Number.isFinite(conf)) conf = 0
    conf = Math.max(0, Math.min(1, conf))
    out.push({ id, project: pid, confidence: pid ? conf : 0, reason: typeof it.reason === 'string' ? it.reason.replace(/\s+/g, ' ').trim().slice(0, 160) : '' })
  }
  return out
}

export type StartOutcome = { ok: true; status: ClassifyStatus } | { ok: false; code: 'busy' | 'no_projects' | 'nothing_to_do'; status: ClassifyStatus }

/**
 * A javaslat-keszites inditasa a hatterben. A hivo azonnal visszakapja az
 * allapotot; a vegeredmeny a `listCardSuggestions`-ben es a
 * `classificationStatus`-ban latszik. `cardIds`: csak ezekre (pl. a
 * sikertelenek ujrakerese); hianyzo = minden projekt nelkuli kartya.
 */
export function startCardClassification(lang: 'hu' | 'en', cardIds?: string[] | null): StartOutcome {
  if (status.state === 'running') return { ok: false, code: 'busy', status: classificationStatus() }
  ensureSuggestionTable()
  const projects = loadProjects()
  if (!projects.length) {
    Object.assign(status, { state: 'failed', error: 'no_projects', finishedAt: Date.now() })
    return { ok: false, code: 'no_projects', status: classificationStatus() }
  }
  let cards = loadUnassigned()
  if (cardIds?.length) {
    const want = new Set(cardIds.map(String))
    cards = cards.filter((c) => want.has(c.id))
  }
  if (!cards.length) {
    Object.assign(status, { state: 'failed', error: 'nothing_to_do', finishedAt: Date.now() })
    return { ok: false, code: 'nothing_to_do', status: classificationStatus() }
  }
  const runId = randomUUID().slice(0, 8)
  Object.assign(status, { state: 'running', runId, total: cards.length, done: 0, failed: 0, startedAt: Date.now(), finishedAt: null, error: '', engine: '' })
  void runClassification(runId, projects, cards, lang)
  return { ok: true, status: classificationStatus() }
}

/** Egy adag kartya kikerdezese es a javaslatok mentese. A globalis futas
 *  allapotahoz NEM nyul -- azt a hivo vezeti (runClassification), a
 *  kartyankenti javaslat (queueCardSuggestion) pedig egyaltalan nem. */
async function classifyAndSave(projects: ProjectBrief[], batch: CardBrief[], lang: 'hu' | 'en', runId: string):
  Promise<{ ok: true; engine: string } | { ok: false; noAi: boolean }> {
  const db = getDb()
  const projectIds = new Set(projects.map((p) => p.id))
  const ids = new Set(batch.map((c) => c.id))
  const ask = await askAiJson(SYSTEM, classifyPrompt(projects, batch, lang), (j) => parseClassifyAnswer(j, ids, projectIds))
  if (ask.engine === 'none' || !ask.value) return { ok: false, noAi: ask.reason === 'no_ai' }
  const engine = `${ask.engine}:${ask.model}`
  const save = db.prepare(
    `INSERT INTO project_card_suggestions (card_id, project_id, confidence, reason, engine, run_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(card_id) DO UPDATE SET project_id = excluded.project_id, confidence = excluded.confidence,
       reason = excluded.reason, engine = excluded.engine, run_id = excluded.run_id, created_at = excluded.created_at`,
  )
  const answered = new Map(ask.value.map((x) => [x.id, x]))
  const now = Math.floor(Date.now() / 1000)
  db.transaction(() => {
    for (const c of batch) {
      const a = answered.get(c.id)
      // A valaszbol kimaradt kartya "bizonytalan" -- nem vesz el, a tulajdonos latja.
      save.run(c.id, a?.project ?? null, a?.confidence ?? 0, a?.reason ?? '', engine, runId, now)
    }
  })()
  return { ok: true, engine }
}

/** A futas maga. Exportalva a teszt miatt (ott megvarjuk). */
export async function runClassification(runId: string, projects: ProjectBrief[], cards: CardBrief[], lang: 'hu' | 'en'): Promise<void> {
  ensureSuggestionTable()
  try {
    for (let i = 0; i < cards.length; i += CLASSIFY_BATCH) {
      if (status.runId !== runId) return
      const batch = cards.slice(i, i + CLASSIFY_BATCH)
      const out = await classifyAndSave(projects, batch, lang, runId)
      if (status.runId !== runId) return
      if (!out.ok) {
        // Az elso kerdesnel derul ki, ha egyaltalan nincs AI: akkor nincs mit folytatni.
        if (out.noAi && status.done === 0 && status.failed === 0) {
          Object.assign(status, { state: 'failed', error: 'no_ai', failed: cards.length, finishedAt: Date.now() })
          return
        }
        status.failed += batch.length
        continue
      }
      status.engine = out.engine
      status.done += batch.length
    }
    if (status.runId === runId) Object.assign(status, { state: 'done', finishedAt: Date.now() })
  } catch {
    if (status.runId === runId) Object.assign(status, { state: 'failed', finishedAt: Date.now(), failed: status.total - status.done })
  }
}

// ---- kartyankenti javaslat (uj, projekt nelkul mentett kartya) ----
// Kulon sor, kulon allapot: a nagy (Regi adatok atvetele) futas allapotat nem
// irja felul, es ha az eppen fut, a kartya nem vesz el -- a sorban var, amig
// az elozo kartyankenti keres vegez.

const singleQueue = new Map<string, 'hu' | 'en'>()
let singleRunning: Promise<void> | null = null

export type QueueOutcome = 'queued' | 'no_projects' | 'not_unassigned'

export function queueCardSuggestion(cardId: string, lang: 'hu' | 'en'): QueueOutcome {
  ensureSuggestionTable()
  if (!loadProjects().length) return 'no_projects'
  if (!loadUnassigned().some((c) => c.id === cardId)) return 'not_unassigned'
  singleQueue.set(cardId, lang)
  if (!singleRunning) singleRunning = drainSingleQueue().finally(() => { singleRunning = null })
  return 'queued'
}

/** A teszt megvarhatja a kartyankenti sort. */
export function cardSuggestionIdle(): Promise<void> {
  return singleRunning ?? Promise.resolve()
}

async function drainSingleQueue(): Promise<void> {
  while (singleQueue.size) {
    const entries = [...singleQueue.entries()]
    singleQueue.clear()
    const projects = loadProjects()
    if (!projects.length) return
    const unassigned = new Map(loadUnassigned().map((c) => [c.id, c]))
    for (const [id, lang] of entries) {
      const card = unassigned.get(id)
      if (!card) continue
      try {
        await classifyAndSave(projects, [card], lang, 'card')
      } catch { /* egy kartya javaslata elmaradhat; a kartya maga megvan */ }
    }
  }
}
