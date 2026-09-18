/**
 * A PROJEKT ATTEKINTESE -- csak MERT forrasbol (kanban #321, spec 9-13. pont).
 *
 * Minden sor, ami itt keletkezik, egy meglevo adatbazis-sorra vagy egy fajl
 * modositasi idejere vezetheto vissza. Nincs "szerkesztes alatt" jelzes, amit
 * a rendszer valojaban nem mer, nincs AI-altal kitalalt kovetkezo lepes, es
 * nincs AI-itelet a projekt egeszsegerol -- a "tenyek" blokk szamokat mutat,
 * nem velemenyt.
 *
 * Forrasok:
 *   - `kanban_cards` (project = a projekt id-je) -- a gerinc,
 *   - `card_work_claims` -- ki dolgozik EPPEN egy kartyan (ha van ilyen tabla),
 *   - `code_tasks` -- a kod-hid feladatai (kartya-hivatkozassal VAGY a projekthez
 *     kotott aliassal),
 *   - `approvals` -- a kartyahoz kotott jovahagyas (`action_payload.kanban_card_id`),
 *   - `kanban_card_events`, `kanban_comments`, `idea_status_log` -- az idovonal,
 *   - a projektmappa -- a legutobb modositott fajlok.
 *
 * Minden ido EZREDMASODPERCBEN megy ki (a kanban masodpercben tarol, a kod-hid
 * ezredben -- itt egysegesitjuk).
 */
import { readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { getDb } from './db.js'
import { explorerRoot, resolveLifePath } from './life-explorer.js'
import {
  getProject, hasTable, projectCardIds, projectCodeAliases, projectIdeaIds,
  type ProjectRow,
} from './projects.js'

const toMs = (v: number | null | undefined): number => {
  if (!v) return 0
  return v > 1e12 ? v : v * 1000
}

export interface OverviewCard {
  id: string
  seq: number | null
  title: string
  status: string
  priority: string
  assignee: string | null
  dueAt: number | null
  updatedAt: number
}

export interface WorkClaim { holder: string; kind: string; ref: string | null; since: number }
export interface CodeTaskRef { id: string; status: string; alias: string; cardId: string | null; excerpt: string; at: number }

export interface CurrentWorkItem {
  card: OverviewCard | null
  claims: WorkClaim[]
  codeTasks: CodeTaskRef[]
}

export interface ApprovalItem {
  id: string
  cardId: string
  cardTitle: string
  category: string
  description: string
  requestedAt: number
  agentId: string
}

export type ActivityKind = 'status' | 'comment' | 'approval' | 'idea' | 'code' | 'file' | 'card_created' | 'idea_created'
export interface ActivityItem {
  at: number
  kind: ActivityKind
  /** A kiiras nyers adatai -- a felulet rakja ossze a mondatot (HU/EN). */
  cardId?: string | null
  cardTitle?: string | null
  from?: string | null
  to?: string | null
  actor?: string | null
  text?: string | null
  name?: string | null
  rel?: string | null
}

/**
 * A projektmappa allapota. A NULLA KET DOLGOT JELENTHET: "meg nincs fajl" vagy
 * "nem latok oda" -- ezert kulon mondjuk meg, melyik.
 */
export type FolderState = 'ok' | 'no_folder' | 'no_depot' | 'missing' | 'unreachable'

export interface ProjectFacts {
  openCards: number
  inProgress: number
  waiting: number
  overdue: number
  pendingApprovals: number
  activeWork: number
  /** A legregebb, 14 napja nem mozdult nyitott kartya kora napban (vagy null). */
  staleOpenCards: number
}

export interface ProjectOverview {
  project: ProjectRow
  currentWork: CurrentWorkItem[]
  approvals: ApprovalItem[]
  nextSteps: OverviewCard[]
  nextStepsTotal: number
  activity: ActivityItem[]
  folder: { state: FolderState; path: string | null; recentFiles: number }
  facts: ProjectFacts
  /** Van-e a projekthez fejlesztesi munka (kod-hid alias vagy kodfeladat) --
   *  a Code Bridge gomb CSAK ekkor jelenik meg (terv 1.4). */
  hasDevWork: boolean
  codeAliases: string[]
}

const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 }
const STATUS_RANK: Record<string, number> = { in_progress: 0, testing: 1, waiting: 2, planned: 3 }
const OPEN_STATUSES = ['planned', 'in_progress', 'testing', 'waiting']
const STALE_DAYS = 14

function placeholders(n: number): string {
  return new Array(n).fill('?').join(',')
}

function loadCards(projectId: string): OverviewCard[] {
  if (!hasTable('kanban_cards')) return []
  const rows = getDb().prepare(
    `SELECT rowid AS seq, id, title, status, priority, assignee, due_date, updated_at
       FROM kanban_cards WHERE project = ? AND archived_at IS NULL`,
  ).all(projectId) as { seq: number; id: string; title: string; status: string; priority: string; assignee: string | null; due_date: number | null; updated_at: number }[]
  return rows.map((r) => ({
    id: r.id,
    seq: r.seq ?? null,
    title: r.title,
    status: r.status,
    priority: r.priority,
    assignee: r.assignee,
    dueAt: r.due_date ? toMs(r.due_date) : null,
    updatedAt: toMs(r.updated_at),
  }))
}

/** A kovetkezo lepesek sorrendje: 1. prioritas, 2. hatarido, 3. allapot (spec 12). */
export function sortNextSteps(cards: OverviewCard[]): OverviewCard[] {
  return [...cards].sort((a, b) =>
    ((PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9))
    || ((a.dueAt ?? Number.MAX_SAFE_INTEGER) - (b.dueAt ?? Number.MAX_SAFE_INTEGER))
    || ((STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9))
    || (b.updatedAt - a.updatedAt))
}

function loadClaims(cardIds: string[], now: number): Map<string, WorkClaim[]> {
  const out = new Map<string, WorkClaim[]>()
  if (!cardIds.length || !hasTable('card_work_claims')) return out
  const rows = getDb().prepare(
    `SELECT card_id, holder, kind, ref, created_at FROM card_work_claims
      WHERE card_id IN (${placeholders(cardIds.length)}) AND released_at IS NULL AND expires_at > ?
      ORDER BY created_at ASC`,
  ).all(...cardIds, now) as { card_id: string; holder: string; kind: string; ref: string | null; created_at: number }[]
  for (const r of rows) {
    const list = out.get(r.card_id) ?? []
    list.push({ holder: r.holder, kind: r.kind, ref: r.ref, since: toMs(r.created_at) })
    out.set(r.card_id, list)
  }
  return out
}

function loadCodeTasks(cardIds: string[], aliases: string[], where: string, limit: number): CodeTaskRef[] {
  if (!hasTable('code_tasks') || (!cardIds.length && !aliases.length)) return []
  const conds: string[] = []
  const params: unknown[] = []
  if (cardIds.length) { conds.push(`card_ref IN (${placeholders(cardIds.length)})`); params.push(...cardIds) }
  if (aliases.length) { conds.push(`project IN (${placeholders(aliases.length)})`); params.push(...aliases) }
  const rows = getDb().prepare(
    `SELECT id, status, project, card_ref, substr(prompt, 1, 160) AS excerpt, created_at, started_at, finished_at
       FROM code_tasks WHERE (${conds.join(' OR ')}) ${where}
       ORDER BY created_at DESC LIMIT ${limit}`,
  ).all(...params) as { id: string; status: string; project: string; card_ref: string | null; excerpt: string; created_at: number; started_at: number | null; finished_at: number | null }[]
  return rows.map((r) => ({
    id: r.id,
    status: r.status,
    alias: r.project,
    cardId: r.card_ref,
    excerpt: String(r.excerpt || '').replace(/\s+/g, ' ').trim(),
    at: toMs(r.finished_at || r.started_at || r.created_at),
  }))
}

function loadApprovals(cards: OverviewCard[]): ApprovalItem[] {
  if (!cards.length || !hasTable('approvals')) return []
  const ids = cards.map((c) => c.id)
  const byId = new Map(cards.map((c) => [c.id, c]))
  const rows = getDb().prepare(
    `SELECT id, agent_id, category, action_description, requested_at,
            CASE WHEN json_valid(action_payload) THEN json_extract(action_payload, '$.kanban_card_id') END AS card_id
       FROM approvals
      WHERE status = 'pending'
        AND CASE WHEN json_valid(action_payload) THEN json_extract(action_payload, '$.kanban_card_id') END IN (${placeholders(ids.length)})
      ORDER BY requested_at ASC`,
  ).all(...ids) as { id: string; agent_id: string; category: string; action_description: string; requested_at: number; card_id: string }[]
  return rows.map((r) => ({
    id: r.id,
    cardId: r.card_id,
    cardTitle: byId.get(r.card_id)?.title ?? '',
    category: r.category,
    description: String(r.action_description || '').slice(0, 300),
    requestedAt: toMs(r.requested_at),
    agentId: r.agent_id,
  }))
}

/** A mappa legutobb modositott fajljai, korlatos bejarassal (melyseg + darabszam),
 *  hogy egy nagy mappa se lassitsa a lapot. */
function recentFiles(project: ProjectRow, limit: number): { state: FolderState; files: { rel: string; name: string; at: number }[] } {
  // Raktar nelkul mappat sem lehet megadni -- ilyenkor az a kovetkezo lepes.
  if (!explorerRoot()) return { state: 'no_depot', files: [] }
  if (!project.folder_path) return { state: 'no_folder', files: [] }
  const abs = resolveLifePath(project.folder_path)
  if (!abs) return { state: 'unreachable', files: [] }
  if (!existsSync(abs)) return { state: 'missing', files: [] }
  const files: { rel: string; name: string; at: number }[] = []
  let visited = 0
  const MAX_VISIT = 3000
  const walk = (dir: string, relDir: string, depth: number): void => {
    if (depth > 4 || visited > MAX_VISIT) return
    let entries: import('node:fs').Dirent[]
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (++visited > MAX_VISIT) return
      if (e.name.startsWith('.') || e.name === 'node_modules') continue
      const full = join(dir, e.name)
      const rel = relDir ? `${relDir}/${e.name}` : e.name
      if (e.isDirectory()) { walk(full, rel, depth + 1); continue }
      if (!e.isFile()) continue
      try {
        const st = statSync(full)
        files.push({ rel: `${project.folder_path}/${rel}`, name: e.name, at: st.mtimeMs })
      } catch { /* eltunt kozben -- nem hiba */ }
    }
  }
  try {
    statSync(abs)
  } catch {
    return { state: 'unreachable', files: [] }
  }
  walk(abs, '', 0)
  files.sort((a, b) => b.at - a.at)
  return { state: 'ok', files: files.slice(0, limit) }
}

function loadActivity(project: ProjectRow, cards: OverviewCard[], aliases: string[], files: { rel: string; name: string; at: number }[], limit: number): ActivityItem[] {
  const db = getDb()
  const out: ActivityItem[] = []
  // Az archivalt kartyak esemenyei is a projekt tortenetehez tartoznak.
  const allIds = projectCardIds(project.id, { includeArchived: true })
  const titles = new Map<string, string>()
  if (allIds.length && hasTable('kanban_cards')) {
    for (const r of db.prepare(`SELECT id, title FROM kanban_cards WHERE id IN (${placeholders(allIds.length)})`).all(...allIds) as { id: string; title: string }[]) {
      titles.set(r.id, r.title)
    }
    // A kartya SZULETESE nem allapotvaltas, ezert a kanban_card_events nem
    // naplozza -- a sor sajat created_at-je viszont mert adat.
    for (const r of db.prepare(
      `SELECT id, title, created_at FROM kanban_cards WHERE id IN (${placeholders(allIds.length)}) ORDER BY created_at DESC LIMIT ${limit}`,
    ).all(...allIds) as { id: string; title: string; created_at: number }[]) {
      out.push({ at: toMs(r.created_at), kind: 'card_created', cardId: r.id, cardTitle: r.title })
    }
  }
  for (const c of cards) titles.set(c.id, c.title)
  const per = limit
  if (allIds.length && hasTable('kanban_card_events')) {
    for (const r of db.prepare(
      `SELECT card_id, from_status, to_status, actor, created_at FROM kanban_card_events
        WHERE card_id IN (${placeholders(allIds.length)}) ORDER BY created_at DESC LIMIT ${per}`,
    ).all(...allIds) as { card_id: string; from_status: string | null; to_status: string; actor: string | null; created_at: number }[]) {
      out.push({ at: toMs(r.created_at), kind: 'status', cardId: r.card_id, cardTitle: titles.get(r.card_id) ?? null, from: r.from_status, to: r.to_status, actor: r.actor })
    }
  }
  if (allIds.length && hasTable('kanban_comments')) {
    for (const r of db.prepare(
      `SELECT card_id, author, substr(content, 1, 200) AS content, created_at FROM kanban_comments
        WHERE card_id IN (${placeholders(allIds.length)}) ORDER BY created_at DESC LIMIT ${per}`,
    ).all(...allIds) as { card_id: string; author: string; content: string; created_at: number }[]) {
      out.push({ at: toMs(r.created_at), kind: 'comment', cardId: r.card_id, cardTitle: titles.get(r.card_id) ?? null, actor: r.author, text: String(r.content || '').replace(/\s+/g, ' ').trim() })
    }
  }
  if (allIds.length && hasTable('approvals')) {
    for (const r of db.prepare(
      `SELECT status, resolved_by, requested_at, resolved_at,
              CASE WHEN json_valid(action_payload) THEN json_extract(action_payload, '$.kanban_card_id') END AS card_id
         FROM approvals
        WHERE CASE WHEN json_valid(action_payload) THEN json_extract(action_payload, '$.kanban_card_id') END IN (${placeholders(allIds.length)})
        ORDER BY COALESCE(resolved_at, requested_at) DESC LIMIT ${per}`,
    ).all(...allIds) as { status: string; resolved_by: string | null; requested_at: number; resolved_at: number | null; card_id: string }[]) {
      out.push({ at: toMs(r.resolved_at || r.requested_at), kind: 'approval', cardId: r.card_id, cardTitle: titles.get(r.card_id) ?? null, to: r.status, actor: r.resolved_by })
    }
  }
  const ideaIds = projectIdeaIds(project.id)
  if (ideaIds.length && hasTable('idea_box')) {
    for (const r of db.prepare(
      `SELECT title, created_at FROM idea_box WHERE id IN (${placeholders(ideaIds.length)}) ORDER BY created_at DESC LIMIT ${limit}`,
    ).all(...ideaIds) as { title: string; created_at: number }[]) {
      out.push({ at: toMs(r.created_at), kind: 'idea_created', name: r.title })
    }
  }
  if (ideaIds.length && hasTable('idea_status_log')) {
    const ideaTitles = new Map<string, string>()
    if (hasTable('idea_box')) {
      for (const r of db.prepare(`SELECT id, title FROM idea_box WHERE id IN (${placeholders(ideaIds.length)})`).all(...ideaIds) as { id: string; title: string }[]) ideaTitles.set(r.id, r.title)
    }
    for (const r of db.prepare(
      `SELECT idea_id, from_status, to_status, actor, created_at FROM idea_status_log
        WHERE idea_id IN (${placeholders(ideaIds.length)}) ORDER BY created_at DESC LIMIT ${per}`,
    ).all(...ideaIds) as { idea_id: string; from_status: string | null; to_status: string; actor: string; created_at: number }[]) {
      out.push({ at: toMs(r.created_at), kind: 'idea', name: ideaTitles.get(r.idea_id) ?? r.idea_id, from: r.from_status, to: r.to_status, actor: r.actor })
    }
  }
  for (const t of loadCodeTasks(allIds, aliases, '', per)) {
    out.push({ at: t.at, kind: 'code', cardId: t.cardId, cardTitle: t.cardId ? titles.get(t.cardId) ?? null : null, to: t.status, text: t.excerpt, actor: t.alias })
  }
  for (const f of files) out.push({ at: f.at, kind: 'file', name: f.name, rel: f.rel })
  return out.filter((a) => a.at > 0).sort((a, b) => b.at - a.at).slice(0, limit)
}

export function buildProjectOverview(projectId: string, opts: { now?: number; activityLimit?: number } = {}): ProjectOverview | null {
  const project = getProject(projectId)
  if (!project || project.id !== projectId) return null
  const now = opts.now ?? Date.now()
  const cards = loadCards(project.id)
  const cardIds = cards.map((c) => c.id)
  const aliases = projectCodeAliases(project.id)
  const claims = loadClaims(cardIds, now)
  const running = loadCodeTasks(cardIds, aliases, "AND status IN ('queued', 'running')", 50)

  // AKTUALIS MUNKA: a folyamatban levo kartyak + minden kartya, amin EPPEN van
  // foglalas vagy futo kodfeladat (akkor is, ha a kartya meg "tervezett") +
  // a projekt aliasan futo, kartya nelkuli kodfeladatok.
  const runningByCard = new Map<string, CodeTaskRef[]>()
  const cardless: CodeTaskRef[] = []
  for (const t of running) {
    if (t.cardId && cardIds.includes(t.cardId)) {
      const l = runningByCard.get(t.cardId) ?? []
      l.push(t)
      runningByCard.set(t.cardId, l)
    } else cardless.push(t)
  }
  const currentWork: CurrentWorkItem[] = []
  for (const c of sortNextSteps(cards)) {
    const active = c.status === 'in_progress' || c.status === 'testing'
    const cl = claims.get(c.id) ?? []
    const ct = runningByCard.get(c.id) ?? []
    if (active || cl.length || ct.length) currentWork.push({ card: c, claims: cl, codeTasks: ct })
  }
  for (const t of cardless) currentWork.push({ card: null, claims: [], codeTasks: [t] })

  const approvals = loadApprovals(cards)
  const open = cards.filter((c) => OPEN_STATUSES.includes(c.status))
  const next = sortNextSteps(open)
  const folderScan = recentFiles(project, 5)
  const activity = loadActivity(project, cards, aliases, folderScan.files, opts.activityLimit ?? 25)

  let hasDevWork = aliases.length > 0
  if (!hasDevWork && hasTable('code_tasks') && cardIds.length) {
    const ids = projectCardIds(project.id, { includeArchived: true })
    hasDevWork = !!getDb().prepare(`SELECT 1 FROM code_tasks WHERE card_ref IN (${placeholders(ids.length)}) LIMIT 1`).get(...ids)
  }

  const staleCut = now - STALE_DAYS * 86400_000
  return {
    project,
    currentWork,
    approvals,
    nextSteps: next.slice(0, 10),
    nextStepsTotal: next.length,
    activity,
    folder: { state: folderScan.state, path: project.folder_path, recentFiles: folderScan.files.length },
    facts: {
      openCards: open.length,
      inProgress: cards.filter((c) => c.status === 'in_progress' || c.status === 'testing').length,
      waiting: cards.filter((c) => c.status === 'waiting').length,
      overdue: open.filter((c) => c.dueAt != null && c.dueAt < now).length,
      pendingApprovals: approvals.length,
      activeWork: currentWork.filter((w) => w.claims.length || w.codeTasks.length).length,
      staleOpenCards: open.filter((c) => c.updatedAt > 0 && c.updatedAt < staleCut).length,
    },
    hasDevWork,
    codeAliases: aliases,
  }
}
