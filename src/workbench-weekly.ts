/**
 * AUTOMATIKUS HETI OSSZEFOGLALO a Munkapadon (kanban #406, 13. pont).
 *
 * Eddig osszefoglalo csak kulon kerere keszult. Most minden projekthez minden
 * lezart hetrol (hetfo 00:00 -- a kovetkezo hetfo 00:00, a telepites sajat
 * idozonajaban) magatol keszul egy rovid osszefoglalo, es MEGMARAD: a regi
 * hetek visszanezhetok. A folyo het "eddig" allapota elo szamitas, nem mentjuk.
 *
 * NEM kell hozza AI-kulcs, internet, se agens: az adat a projekt idovonalabol
 * (7. pont), a munkadarabokbol es a dontesnaplobol (10. pont) jon -- tehat egy
 * friss telepitesen, barmilyen modell nelkul is mukodik, es nem talal ki semmit.
 *
 * Mikor keszul? (1) Amikor valaki megnyitja a projekt osszefoglalojat, a
 * hianyzo MULT HETI osszefoglalo azonnal elkeszul; (2) a dashboard 6 orankent
 * vegigmegy az aktiv projekteken, hogy akkor is meglegyen, ha senki nem nyitja
 * meg. Ugyanaz a het soha nem keszul el ketszer (elsodleges kulcs).
 *
 * NULLA != "NEM LATTAM": ha az idovonal egy forrasa nem olvashato, a hiba a
 * `errors` listaba kerul, es a felulet kimondja -- nem allitja, hogy azon a
 * heten nem tortent semmi.
 */
import { getDb } from './db.js'
import { getProject, listActiveProjectIds } from './projects.js'
import { ensureWorkbenchTables } from './workbench.js'
import { buildProjectTimeline, TIMELINE_MAX_LIMIT, type TimelineEvent, type TimelineSource } from './workbench-timeline.js'
import { listDecisions } from './workbench-decisions.js'

const DAY = 24 * 60 * 60
/** Listankent ennyi nevet mutatunk; a tobbit a szam mondja meg. */
export const WEEKLY_LIST_MAX = 8
/** Ennyi regi hetet adunk vissza a feluletnek. */
export const WEEKLY_HISTORY_MAX = 12
/** A hatter-sopres gyakorisaga. */
export const WEEKLY_SWEEP_MS = 6 * 60 * 60 * 1000

export interface WeeklyCounts {
  items_created: number
  versions: number
  files: number
  approvals_requested: number
  approvals_approved: number
  approvals_rejected: number
  cards_created: number
  cards_done: number
  decisions: number
  finished: number
}

export interface WeeklySummary {
  project_id: string
  /** A het eleje es vege (masodperc, a vege mar NEM tartozik bele). */
  week_start: number
  week_end: number
  /** Elo (folyo het) vagy mentett (lezart het). */
  live: boolean
  generated_at: number
  counts: WeeklyCounts
  /** Uj munkadarabok cime. */
  created: string[]
  /** A heten keszre allitott munkadarabok cime. */
  finished: string[]
  /** A legtobbet valtozott munkadarabok (verziok szama szerint). */
  busiest: { title: string; versions: number }[]
  /** A heten rogzitett dontesek szovege. */
  decisions: string[]
  /** Most nyitott (nem kesz) munkadarabok szama a het vegen / most. */
  open_now: number | null
  /** Semmi nem tortent a heten (es minden forras olvashato volt). */
  quiet: boolean
  /** Forrasok, amiket NEM tudtunk elolvasni. */
  errors: { source: TimelineSource | 'decisions' | 'items'; detail: string }[]
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 200)

/** A het eleje (hetfo 00:00, helyi ido), masodpercben. */
export function weekStartOf(atSec: number): number {
  const d = new Date(atSec * 1000)
  const back = (d.getDay() + 6) % 7 // hetfo = 0
  const m = new Date(d.getFullYear(), d.getMonth(), d.getDate() - back, 0, 0, 0, 0)
  return Math.floor(m.getTime() / 1000)
}

/** A kovetkezo het eleje -- naptar szerint, igy a nyari/teli atallas se csusztat. */
export function nextWeekStart(startSec: number): number {
  const d = new Date(startSec * 1000)
  return Math.floor(new Date(d.getFullYear(), d.getMonth(), d.getDate() + 7, 0, 0, 0, 0).getTime() / 1000)
}

export function prevWeekStart(startSec: number): number {
  const d = new Date(startSec * 1000)
  return Math.floor(new Date(d.getFullYear(), d.getMonth(), d.getDate() - 7, 0, 0, 0, 0).getTime() / 1000)
}

export function ensureWeeklyTable(): void {
  getDb().exec(`CREATE TABLE IF NOT EXISTS workbench_weekly_summaries (
    project_id TEXT NOT NULL,
    week_start INTEGER NOT NULL,
    week_end INTEGER NOT NULL,
    generated_at INTEGER NOT NULL,
    data_json TEXT NOT NULL,
    PRIMARY KEY (project_id, week_start)
  )`)
}

/** Az idovonal esemenyei [start, end) kozott -- lapozva, hogy semmi ne vesszen el. */
function eventsBetween(projectId: string, start: number, end: number): { events: TimelineEvent[]; errors: WeeklySummary['errors'] } {
  const out: TimelineEvent[] = []
  const errors: WeeklySummary['errors'] = []
  let before: number | null = end
  for (let guard = 0; guard < 50 && before !== null; guard++) {
    const r = buildProjectTimeline(projectId, { before, limit: TIMELINE_MAX_LIMIT })
    if (guard === 0) for (const e of r.errors) errors.push(e)
    let older = false
    for (const e of r.events) {
      if (e.at >= start) out.push(e)
      else older = true
    }
    if (older || !r.more) break
    before = r.next_before
  }
  return { events: out, errors }
}

/** Egy het osszefoglaloja, a mar meglevo adatbol. Nem ir semmit. */
export function computeWeeklySummary(projectId: string, start: number, end: number, now: number, live: boolean): WeeklySummary {
  ensureWorkbenchTables()
  const { events, errors } = eventsBetween(projectId, start, end)
  const counts: WeeklyCounts = {
    items_created: 0, versions: 0, files: 0, approvals_requested: 0, approvals_approved: 0,
    approvals_rejected: 0, cards_created: 0, cards_done: 0, decisions: 0, finished: 0,
  }
  const created: string[] = []
  const perItem = new Map<string, { title: string; versions: number }>()
  for (const e of events) {
    switch (e.kind) {
      case 'item_created': counts.items_created++; if (e.item_title) created.push(e.item_title); break
      case 'version': case 'version_restored': {
        counts.versions++
        if (e.item_id) {
          const p = perItem.get(e.item_id) ?? { title: e.item_title || '', versions: 0 }
          p.versions++
          perItem.set(e.item_id, p)
        }
        break
      }
      case 'file_added': counts.files++; break
      case 'approval_requested': counts.approvals_requested++; break
      case 'approval_approved': counts.approvals_approved++; break
      case 'approval_rejected': counts.approvals_rejected++; break
      case 'card_created': counts.cards_created++; break
      case 'card_done': counts.cards_done++; break
    }
  }

  // Keszre allitott munkadarabok: most "done", es az utolso modositasuk a hetre
  // esik. (Kulon statusz-naplo nincs; ez a legpontosabb, amit az adat enged.)
  let finished: string[] = []
  let openNow: number | null = null
  try {
    const db = getDb()
    finished = (db.prepare(
      `SELECT title FROM work_items WHERE project_id = ? AND status = 'done' AND updated_at >= ? AND updated_at < ? ORDER BY updated_at ASC`,
    ).all(projectId, start, end) as { title: string }[]).map((r) => r.title)
    openNow = (db.prepare(`SELECT COUNT(*) AS n FROM work_items WHERE project_id = ? AND status != 'done'`).get(projectId) as { n: number }).n
  } catch (e) {
    errors.push({ source: 'items', detail: errText(e) })
  }
  counts.finished = finished.length

  let decisions: string[] = []
  try {
    decisions = listDecisions(projectId, { includeRevoked: true })
      .filter((d) => d.created_at >= start && d.created_at < end)
      .sort((a, b) => a.created_at - b.created_at)
      .map((d) => d.text)
  } catch (e) {
    errors.push({ source: 'decisions', detail: errText(e) })
  }
  counts.decisions = decisions.length

  const busiest = [...perItem.values()]
    .filter((p) => p.versions > 1 && p.title)
    .sort((a, b) => b.versions - a.versions)
    .slice(0, 3)

  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  return {
    project_id: projectId,
    week_start: start,
    week_end: end,
    live,
    generated_at: now,
    counts,
    created: created.slice(0, WEEKLY_LIST_MAX),
    finished: finished.slice(0, WEEKLY_LIST_MAX),
    busiest,
    decisions: decisions.slice(0, WEEKLY_LIST_MAX),
    open_now: openNow,
    quiet: total === 0 && errors.length === 0,
    errors,
  }
}

/**
 * A MULT HET osszefoglaloja, ha meg nincs meg -- elkeszul es megmarad. Egy
 * projekt, ami a het vegen meg nem is letezett, nem kap osszefoglalot (egy
 * tegnap letrehozott projektnek nincs "mult hete"). Hiba eseten NEM ment: a
 * kovetkezo alkalom ujraprobalja, igy egy atmeneti hiba nem ragad be orokre.
 */
export function ensureLastWeekSummary(projectId: string, now: number): 'created' | 'exists' | 'too_new' | 'not_found' | 'failed' {
  const project = getProject(projectId)
  if (!project) return 'not_found'
  ensureWeeklyTable()
  const end = weekStartOf(now)
  const start = prevWeekStart(end)
  if (project.created_at >= end) return 'too_new'
  const db = getDb()
  if (db.prepare('SELECT 1 FROM workbench_weekly_summaries WHERE project_id = ? AND week_start = ?').get(project.id, start)) return 'exists'
  const s = computeWeeklySummary(project.id, start, end, now, false)
  if (s.errors.length) return 'failed'
  db.prepare(
    'INSERT OR IGNORE INTO workbench_weekly_summaries (project_id, week_start, week_end, generated_at, data_json) VALUES (?, ?, ?, ?, ?)',
  ).run(project.id, start, end, now, JSON.stringify(s))
  return 'created'
}

/** A mentett hetek, a legfrissebb elol. */
export function listWeeklySummaries(projectId: string, limit = WEEKLY_HISTORY_MAX): WeeklySummary[] {
  ensureWeeklyTable()
  const rows = getDb().prepare(
    'SELECT data_json FROM workbench_weekly_summaries WHERE project_id = ? ORDER BY week_start DESC LIMIT ?',
  ).all(projectId, limit) as { data_json: string }[]
  const out: WeeklySummary[] = []
  for (const r of rows) {
    try { out.push(JSON.parse(r.data_json) as WeeklySummary) } catch { /* serult sor: kihagyjuk, a tobbi latszik */ }
  }
  return out
}

/** A folyo het "eddig" allapota -- elo, nem mentjuk. */
export function currentWeekSummary(projectId: string, now: number): WeeklySummary {
  const start = weekStartOf(now)
  return computeWeeklySummary(projectId, start, nextWeekStart(start), now, true)
}

/** Minden aktiv projektre: a mult heti osszefoglalo, ha hianyzik. */
export function sweepWeeklySummaries(now = Math.floor(Date.now() / 1000)): { created: number; failed: number } {
  let created = 0
  let failed = 0
  for (const id of listActiveProjectIds()) {
    try {
      const r = ensureLastWeekSummary(id, now)
      if (r === 'created') created++
      else if (r === 'failed') failed++
    } catch {
      failed++
    }
  }
  return { created, failed }
}

/** Indulaskor es 6 orankent. A visszaadott ertekkel allithato le. */
export function startWeeklySummarySweeper(onError?: (err: unknown) => void): NodeJS.Timeout {
  const run = (): void => {
    try { sweepWeeklySummaries() } catch (err) { onError?.(err) }
  }
  const first = setTimeout(run, 30_000)
  if (typeof first.unref === 'function') first.unref()
  const t = setInterval(run, WEEKLY_SWEEP_MS)
  if (typeof t.unref === 'function') t.unref()
  return t
}
