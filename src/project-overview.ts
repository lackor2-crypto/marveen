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
 *   - `code_tasks` -- a kod-hid feladatai: az EGYENKENT a projekthez kotott
 *     feladat (`code_task` kotes), kulonben a kartya-hivatkozas VAGY a projekthez
 *     kotott alias (a kotes `since` idopontja utan) -- lasd `codeTaskMembership`,
 *   - `approvals` -- a kartyahoz kotott jovahagyas (`action_payload.kanban_card_id`)
 *     ES a Munkapad sajat jegye, ami a projektet nevezi meg (`action_payload.project`),
 *   - `work_items` -- a Munkapad munkadarabjai (a Kanban ful ugyanezeket mutatja),
 *   - `kanban_card_events`, `kanban_comments`, `idea_status_log` -- az idovonal,
 *   - a projektmappa -- a legutobb modositott fajlok.
 *
 * Minden ido EZREDMASODPERCBEN megy ki (a kanban masodpercben tarol, a kod-hid
 * ezredben -- itt egysegesitjuk).
 */
import { readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { getDb, listPendingApprovals } from './db.js'
import { approvalCardId } from './kanban-related.js'
import { explorerRoot, resolveLifePath } from './life-explorer.js'
import { mountsInside } from './life-mounts.js'
import {
  getProject, hasTable, projectCardIds, projectCodeAliases, projectIdeaIds,
  type ProjectRow,
} from './projects.js'
import { RECENT_DONE_DAYS, approvalBelongs } from './workbench-overview.js'

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

/** A Workbench work item ("munkadarab"): not a kanban card, but real work the
 *  project holds -- the Kanban tab shows it, so the overview must count it. */
export interface OverviewWorkItem {
  id: string
  seq: number | null
  title: string
  /** draft / in_progress / review / done. */
  status: string
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
  /** The kanban card the request is about; `null` for a Workbench request that
   *  names the project (and usually a work item) instead of a card. */
  cardId: string | null
  cardTitle: string
  workItemId: string | null
  workItemSeq: number | null
  workItemTitle: string | null
  category: string
  description: string
  requestedAt: number
  agentId: string
}

export type ActivityKind = 'status' | 'comment' | 'approval' | 'idea' | 'code' | 'file' | 'card_created' | 'idea_created' | 'work'
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
  /** `work`: the work item that changed (`name` = its title, `to` = its status). */
  workItemId?: string | null
  seq?: number | null
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
  /** What the Kanban tab's Done column holds: the not archived done cards and
   *  the work items finished in the last RECENT_DONE_DAYS days. */
  done: number
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
  /** The project's open work items (draft / in progress / review), newest first. */
  workItems: OverviewWorkItem[]
  /** Work items finished in the last RECENT_DONE_DAYS days, newest first. */
  doneWorkItems: OverviewWorkItem[]
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

const OPEN_WORK_STATUSES = ['draft', 'in_progress', 'review']

/** Every live work item of the project, newest first -- the finished ones too:
 *  a project whose work is all done still has work to show. A fresh install has
 *  no table yet: that is "no work item", not an error. */
function loadWorkItems(projectId: string): OverviewWorkItem[] {
  if (!hasTable('work_items')) return []
  const rows = getDb().prepare(
    `SELECT id, seq, title, status, updated_at FROM work_items
      WHERE project_id = ? AND deleted_at IS NULL
      ORDER BY updated_at DESC`,
  ).all(projectId) as { id: string; seq: number | null; title: string; status: string; updated_at: number }[]
  return rows.map((r) => ({ id: r.id, seq: r.seq ?? null, title: r.title, status: r.status, updatedAt: toMs(r.updated_at) }))
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

/**
 * Melyik kodfeladat tartozik a projekthez -- SQL-feltetelkent (`t` = code_tasks).
 *
 *   1. Az EGYENKENT kotott feladat (`code_task`) oda tartozik, ahova kotottek --
 *      es SEHOVA mashova: ez erosebb a kartya-hivatkozasnal es az aliasnal is.
 *      Igy tud egy regi alias-feladat a tartalma szerint mas projektbe kerulni,
 *      mint amihez az alias a jovoben tartozik (kanban #321, migracio 2. pont).
 *   2. Kulonben: a projekt kartyajara hivatkozik, VAGY a projekthez kotott
 *      aliason fut -- az alias-kotes `since` idopontja utan (NULL = mindig).
 *
 * A kod-hid `created_at`-je ezredmasodperc, a kotes `since`-e masodperc.
 */
function codeTaskMembership(projectId: string, cardIds: string[]): { sql: string; params: unknown[] } {
  const params: unknown[] = [projectId]
  const loose: string[] = [
    `EXISTS (SELECT 1 FROM project_links a WHERE a.object_type = 'code_alias' AND a.project_id = ?
       AND a.object_id = t.project AND (a.since IS NULL OR t.created_at >= a.since * 1000))`,
  ]
  const looseParams: unknown[] = [projectId]
  if (cardIds.length) { loose.push(`t.card_ref IN (${placeholders(cardIds.length)})`); looseParams.push(...cardIds) }
  params.push(...looseParams)
  return {
    sql: `(EXISTS (SELECT 1 FROM project_links x WHERE x.object_type = 'code_task' AND x.object_id = t.id AND x.project_id = ?)
      OR (NOT EXISTS (SELECT 1 FROM project_links y WHERE y.object_type = 'code_task' AND y.object_id = t.id)
          AND (${loose.join(' OR ')})))`,
    params,
  }
}

function loadCodeTasks(projectId: string, cardIds: string[], where: string, limit: number): CodeTaskRef[] {
  if (!hasTable('code_tasks') || !hasTable('project_links')) return []
  const m = codeTaskMembership(projectId, cardIds)
  const rows = getDb().prepare(
    `SELECT t.id, t.status, t.project, t.card_ref, substr(t.prompt, 1, 160) AS excerpt, t.created_at, t.started_at, t.finished_at
       FROM code_tasks t WHERE ${m.sql} ${where}
       ORDER BY t.created_at DESC LIMIT ${limit}`,
  ).all(...m.params) as { id: string; status: string; project: string; card_ref: string | null; excerpt: string; created_at: number; started_at: number | null; finished_at: number | null }[]
  return rows.map((r) => ({
    id: r.id,
    status: r.status,
    alias: r.project,
    cardId: r.card_ref,
    excerpt: String(r.excerpt || '').replace(/\s+/g, ' ').trim(),
    at: toMs(r.finished_at || r.started_at || r.created_at),
  }))
}

/** The work item a Workbench request names in its payload (`workItem`), if any. */
function payloadWorkItemId(actionPayload: string | null): string | null {
  if (!actionPayload) return null
  try {
    const p = JSON.parse(actionPayload) as Record<string, unknown> | null
    return p && typeof p === 'object' && typeof p['workItem'] === 'string' ? p['workItem'] : null
  } catch {
    return null
  }
}

/**
 * The project's undecided approval requests. A request belongs here in one of
 * two ways: it is about one of the project's cards (`kanban_card_id`), or it is
 * the Workbench's own request and names the project itself (`project`, with
 * `project_id` as the older spelling). The decision is the Workbench strip's own
 * `approvalBelongs`, not a second copy of it, so the two cannot show a different
 * number for the same project.
 */
function loadApprovals(projectId: string, cards: OverviewCard[], items: OverviewWorkItem[]): ApprovalItem[] {
  if (!hasTable('approvals')) return []
  const ids = cards.map((c) => c.id)
  const itemById = new Map(items.map((w) => [w.id, w]))
  const rows = listPendingApprovals()
    .filter((a) => approvalBelongs(a, projectId, ids))
    .sort((a, b) => a.requested_at - b.requested_at)
  return rows.map((r) => {
    const ref = approvalCardId(r.action_payload, r.action_description || '')
    const card = ref ? cards.find((c) => c.id === ref || c.id.startsWith(ref)) : undefined
    const item = itemById.get(payloadWorkItemId(r.action_payload) ?? '')
    return {
      id: r.id,
      cardId: card ? card.id : null,
      cardTitle: card?.title ?? '',
      workItemId: item ? item.id : null,
      workItemSeq: item ? item.seq : null,
      workItemTitle: item ? item.title : null,
      category: r.category,
      description: String(r.action_description || '').slice(0, 300),
      requestedAt: toMs(r.requested_at),
      agentId: r.agent_id,
    }
  })
}

/** A mappa legutobb modositott fajljai, korlatos bejarassal (melyseg + darabszam),
 *  hogy egy nagy mappa se lassitsa a lapot. */
export function recentFiles(project: ProjectRow, limit: number): { state: FolderState; files: { rel: string; name: string; at: number }[] } {
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
    // Mounted folders (e.g. the git repos under GIT_REPOS) show here in the Explorer
    // but live elsewhere on disk: follow them, so the flat list matches the tree.
    for (const m of mountsInside(relDir ? `${project.folder_path}/${relDir}` : String(project.folder_path))) {
      const mAbs = resolveLifePath(m.rel)
      const name = m.rel.slice(m.rel.lastIndexOf('/') + 1)
      if (mAbs) walk(mAbs, relDir ? `${relDir}/${name}` : name, depth + 1)
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

function loadActivity(project: ProjectRow, cards: OverviewCard[], items: OverviewWorkItem[], files: { rel: string; name: string; at: number }[], limit: number): ActivityItem[] {
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
  for (const t of loadCodeTasks(project.id, allIds, '', per)) {
    out.push({ at: t.at, kind: 'code', cardId: t.cardId, cardTitle: t.cardId ? titles.get(t.cardId) ?? null : null, to: t.status, text: t.excerpt, actor: t.alias })
  }
  // A work item keeps no status history, only when it last changed: that moment
  // and the status it stands in now is what is measured, so that is what is shown.
  for (const w of items.slice(0, per)) {
    out.push({ at: w.updatedAt, kind: 'work', workItemId: w.id, seq: w.seq, name: w.title, to: w.status })
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
  const running = loadCodeTasks(project.id, cardIds, "AND t.status IN ('queued', 'running')", 50)

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

  const allWorkItems = loadWorkItems(project.id)
  const workItems = allWorkItems.filter((w) => OPEN_WORK_STATUSES.includes(w.status))
  // The same cut the Kanban tab's Done column makes (`listBoardWorkItems`).
  const doneCut = now - RECENT_DONE_DAYS * 86400_000
  const doneWorkItems = allWorkItems.filter((w) => w.status === 'done' && w.updatedAt >= doneCut)
  const approvals = loadApprovals(project.id, cards, allWorkItems)
  const open = cards.filter((c) => OPEN_STATUSES.includes(c.status))
  const next = sortNextSteps(open)
  const folderScan = recentFiles(project, 5)
  const activity = loadActivity(project, cards, allWorkItems, folderScan.files, opts.activityLimit ?? 25)

  // Van-e a projektnek fejlesztesi munkaja: kotott alias, VAGY barmely (akar
  // archivalt kartyan at, akar egyenkent kotott) kodfeladat.
  let hasDevWork = aliases.length > 0
  if (!hasDevWork && hasTable('code_tasks') && hasTable('project_links')) {
    const m = codeTaskMembership(project.id, projectCardIds(project.id, { includeArchived: true }))
    hasDevWork = !!getDb().prepare(`SELECT 1 FROM code_tasks t WHERE ${m.sql} LIMIT 1`).get(...m.params)
  }

  const staleCut = now - STALE_DAYS * 86400_000
  return {
    project,
    currentWork,
    approvals,
    nextSteps: next.slice(0, 10),
    nextStepsTotal: next.length,
    workItems,
    doneWorkItems,
    activity,
    folder: { state: folderScan.state, path: project.folder_path, recentFiles: folderScan.files.length },
    facts: {
      // Cards AND work items: the Kanban tab shows both, so the numbers must too.
      openCards: open.length + workItems.length,
      inProgress: cards.filter((c) => c.status === 'in_progress' || c.status === 'testing').length
        + workItems.filter((w) => w.status === 'in_progress').length,
      waiting: cards.filter((c) => c.status === 'waiting').length
        + workItems.filter((w) => w.status === 'review').length,
      overdue: open.filter((c) => c.dueAt != null && c.dueAt < now).length,
      pendingApprovals: approvals.length,
      done: cards.filter((c) => c.status === 'done').length + doneWorkItems.length,
      activeWork: currentWork.filter((w) => w.claims.length || w.codeTasks.length).length
        + workItems.filter((w) => w.status === 'in_progress').length,
      staleOpenCards: open.filter((c) => c.updatedAt > 0 && c.updatedAt < staleCut).length
        + workItems.filter((w) => w.updatedAt > 0 && w.updatedAt < staleCut).length,
    },
    hasDevWork,
    codeAliases: aliases,
  }
}
