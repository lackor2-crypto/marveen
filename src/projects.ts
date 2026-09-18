/**
 * PROJEKTEK -- a projekt mint elso osztalyu objektum (kanban #321, c17e3a2d).
 *
 * A terv egy mondatban: "Projekt = egy adatbazis-objektum + egy fizikai
 * projektmappa + a Marveen meglevo objektumainak szurt nezete." Ezert ez a
 * modul SZANDEKOSAN keves dolgot tarol:
 *
 *   - `projects`       -- a projekt maga (nev, leiras, kinek keszul, allapot,
 *                         a Raktar-beli mappa relativ utja, alapertelmezett
 *                         cimke, a kezzel kert osszefoglalo).
 *   - `project_links`  -- CSAK ott, ahol nincs termeszetes kapcsolat: onallo
 *                         otlet, kod-hid alias, vitaztatas, memoria. Egy objektum
 *                         egyszerre egy projekthez tartozik (PRIMARY KEY).
 *
 * A kanban-kartya NEM kap uj mezot: a meglevo `kanban_cards.project` a gerinc,
 * es a projekt `id`-jat tartalmazza. Ami ebbol levezetheto (jovahagyas a
 * kartyan at, otlet a `kanban_id`-n at, aktivitas, fajlok a mappabol), azt nem
 * tarolja semmi kulon -- igy nincs mit szinkronban tartani.
 *
 * A tabla a db.ts erintese nelkul jon letre (fork-barat: az upstream soha nem
 * nyul ehhez a fajlhoz), ugyanazzal a DB-peldanyhoz kotott "kesz vagyok"
 * jelzovel, mint a card-work-guard: egy ujrainicializalt (teszt-) adatbazis mas
 * peldany, es ott a tablat ujra meg kell csinalni.
 *
 * TORLES: a projekt torlese SOHA nem torol kartyat, otletet vagy fajlt -- csak
 * a kapcsolatot bontja (`kanban_cards.project` -> NULL, a `project_links` sorai
 * torlodnek). A mappa a lemezen marad.
 */
import { randomUUID } from 'node:crypto'
import { getDb } from './db.js'

export const PROJECT_STATUSES = ['active', 'paused', 'closed'] as const
export type ProjectStatus = typeof PROJECT_STATUSES[number]

/** A `project_links` ismert objektum-fajtai. Uj fajta felvetele: ide + a hasznalo. */
export const PROJECT_LINK_TYPES = ['idea', 'code_alias', 'debate', 'memory', 'schedule', 'skill'] as const
export type ProjectLinkType = typeof PROJECT_LINK_TYPES[number]

export interface ProjectRow {
  id: string
  slug: string
  name: string
  description: string | null
  client: string | null
  status: ProjectStatus
  /** A Raktar (depo) gyokerehez kepest relativ ut, per-jellel. NULL = nincs mappa. */
  folder_path: string | null
  default_label_id: string | null
  /** A kezzel kert AI-osszefoglalo. NEM generalodik megnyitaskor. */
  summary: string | null
  /** Mikor keszult az osszefoglalo (masodperc). */
  summary_at: number | null
  created_at: number
  updated_at: number
  archived_at: number | null
}

export interface ProjectWithStats extends ProjectRow {
  open_cards: number
  live_cards: number
  /** A legutobbi mert esemeny ideje (masodperc) -- projekt, kartya vagy komment. */
  last_activity_at: number
}

export interface ProjectLinkRow {
  project_id: string
  object_type: ProjectLinkType
  object_id: string
  created_at: number
  created_by: string | null
}

const nowSec = (): number => Math.floor(Date.now() / 1000)

let tablesDb: unknown = null

/** A projekt-tablak letrehozasa, ha meg nincsenek. Idempotens, olcso. */
export function ensureProjectTables(): void {
  const db = getDb()
  if (tablesDb === db) return
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT,
      client TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','closed')),
      folder_path TEXT,
      default_label_id TEXT,
      summary TEXT,
      summary_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      archived_at INTEGER
    )
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_links (
      project_id TEXT NOT NULL,
      object_type TEXT NOT NULL,
      object_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      created_by TEXT,
      PRIMARY KEY (object_type, object_id)
    )
  `)
  db.exec('CREATE INDEX IF NOT EXISTS idx_project_links_project ON project_links(project_id, object_type)')
  // A projekt-nezet minden lekerdezese ezen a mezon szur.
  if (hasTable('kanban_cards')) db.exec('CREATE INDEX IF NOT EXISTS idx_kanban_project ON kanban_cards(project)')
  tablesDb = db
}

/** Letezik-e a tabla. A projekt-nezet mas modulok tablaibol olvas (jovahagyas,
 *  kod-hid, foglalas), es ezek egy friss telepitesen meg nem feltetlenul
 *  jottek letre -- ilyenkor "nincs meg adat", nem hiba. */
export function hasTable(name: string): boolean {
  const row = getDb().prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(name)
  return !!row
}

/**
 * Rovid technikai nev a projekt nevebol: ekezet nelkul, kisbetus, kotojeles.
 * Ember-nyelvu nevbol gepi zona (naming-conventions): `Kovács weboldal` ->
 * `kovacs-weboldal`. Ures eredmenynel `project`.
 */
export function slugify(name: string): string {
  const s = String(name || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '')
  return s || 'project'
}

/** Egyedi slug: ha foglalt, `-2`, `-3`, ... utotaggal. `exceptId` a sajat sora. */
export function uniqueSlug(base: string, exceptId?: string): string {
  ensureProjectTables()
  const db = getDb()
  const taken = (s: string): boolean => {
    const row = db.prepare('SELECT id FROM projects WHERE slug = ?').get(s) as { id: string } | undefined
    return !!row && row.id !== exceptId
  }
  const root = slugify(base)
  if (!taken(root)) return root
  for (let i = 2; i < 1000; i++) {
    const cand = `${root.slice(0, 36)}-${i}`
    if (!taken(cand)) return cand
  }
  return `${root.slice(0, 30)}-${randomUUID().slice(0, 8)}`
}

function newProjectId(): string {
  const db = getDb()
  for (let i = 0; i < 20; i++) {
    const id = randomUUID().slice(0, 8)
    const clash = db.prepare('SELECT 1 FROM projects WHERE id = ?').get(id)
    if (!clash) return id
  }
  return randomUUID().replace(/-/g, '').slice(0, 12)
}

export function getProject(idOrSlug: string): ProjectRow | undefined {
  ensureProjectTables()
  const v = String(idOrSlug || '').trim()
  if (!v) return undefined
  const db = getDb()
  return (db.prepare('SELECT * FROM projects WHERE id = ?').get(v)
    ?? db.prepare('SELECT * FROM projects WHERE slug = ? COLLATE NOCASE').get(v)) as ProjectRow | undefined
}

/**
 * Egy kanban-kartya `project` mezojebe irt ertek feloldasa projekt-id-re.
 *
 * Az agensek es a regi kod szabad szoveget irnak ide (pl. a kartya-keszito
 * utasitasban szereplo rovid nevet). Ha ez EGYERTELMUEN egy projektre mutat --
 * az id-jara, a slug-jara vagy a pontos nevere --, akkor a projekt id-je kerul
 * a kartyara, es a kartya megjelenik a projektben. Ha nem, az ertek VALTOZATLAN
 * marad: egy ismeretlen szoveg nem veszhet el (terv 1.1).
 *
 * `undefined` = a hivo nem kuldte a mezot (nincs mit csinalni), `null`/ures =
 * a hivo kifejezetten torolte.
 */
export function resolveProjectRef(value: unknown): string | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  const v = String(value).trim()
  if (!v) return null
  ensureProjectTables()
  const db = getDb()
  const byId = db.prepare('SELECT id FROM projects WHERE id = ?').get(v) as { id: string } | undefined
  if (byId) return byId.id
  const bySlug = db.prepare('SELECT id FROM projects WHERE slug = ? COLLATE NOCASE').get(v) as { id: string } | undefined
  if (bySlug) return bySlug.id
  const byName = db.prepare('SELECT id FROM projects WHERE name = ? COLLATE NOCASE').all(v) as { id: string }[]
  if (byName.length === 1) return byName[0].id
  return v
}

/** A projekt-azonositok, amik a kanban projekt-szurojeben ALLANDOAN ott vannak
 *  (akkor is, ha a projektnek meg nincs kartyaja). Az archivaltak nem. */
export function listActiveProjectIds(): string[] {
  ensureProjectTables()
  return (getDb().prepare('SELECT id FROM projects WHERE archived_at IS NULL ORDER BY name COLLATE NOCASE').all() as { id: string }[])
    .map((r) => r.id)
}

/** id -> nev minden projektre (archivaltakra is): a kanban a kartyan ezt irja ki az id helyett. */
export function projectNameMap(): Record<string, { name: string; archived: boolean }> {
  ensureProjectTables()
  const out: Record<string, { name: string; archived: boolean }> = {}
  for (const r of getDb().prepare('SELECT id, name, archived_at FROM projects').all() as { id: string; name: string; archived_at: number | null }[]) {
    out[r.id] = { name: r.name, archived: r.archived_at != null }
  }
  return out
}

const STATUS_ORDER: Record<string, number> = { active: 0, paused: 1, closed: 2 }

export function listProjects(opts: { includeArchived?: boolean } = {}): ProjectWithStats[] {
  ensureProjectTables()
  const db = getDb()
  const hasKanban = hasTable('kanban_cards')
  const hasComments = hasTable('kanban_comments')
  const rows = db.prepare(
    `SELECT p.*,
       ${hasKanban ? `(SELECT COUNT(*) FROM kanban_cards k WHERE k.project = p.id AND k.archived_at IS NULL AND k.status != 'done')` : '0'} AS open_cards,
       ${hasKanban ? `(SELECT COUNT(*) FROM kanban_cards k WHERE k.project = p.id AND k.archived_at IS NULL)` : '0'} AS live_cards,
       ${hasKanban ? `(SELECT MAX(k.updated_at) FROM kanban_cards k WHERE k.project = p.id)` : 'NULL'} AS last_card_at,
       ${hasKanban && hasComments ? `(SELECT MAX(c.created_at) FROM kanban_comments c JOIN kanban_cards k ON k.id = c.card_id WHERE k.project = p.id)` : 'NULL'} AS last_comment_at
     FROM projects p
     ${opts.includeArchived ? '' : 'WHERE p.archived_at IS NULL'}`,
  ).all() as (ProjectRow & { open_cards: number; live_cards: number; last_card_at: number | null; last_comment_at: number | null })[]
  return rows
    .map(({ last_card_at, last_comment_at, ...r }) => ({
      ...r,
      last_activity_at: Math.max(r.updated_at || 0, last_card_at || 0, last_comment_at || 0),
    }))
    .sort((a, b) =>
      ((a.archived_at ? 1 : 0) - (b.archived_at ? 1 : 0))
      || ((STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9))
      || (b.last_activity_at - a.last_activity_at)
      || a.name.localeCompare(b.name))
}

export interface ProjectInput {
  name?: unknown
  slug?: unknown
  description?: unknown
  client?: unknown
  status?: unknown
  folder_path?: unknown
  default_label_id?: unknown
}

/** A szerver-oldali ellenorzes eredmenye: vagy a tiszta mezok, vagy egy hibakod
 *  (a felulet a kodhoz tartozo, forditott mondatot mutatja -- `projects.err.*`). */
export type ProjectValidation =
  | { ok: true; fields: Partial<Pick<ProjectRow, 'name' | 'slug' | 'description' | 'client' | 'status' | 'folder_path' | 'default_label_id'>> }
  | { ok: false; code: string }

function optText(v: unknown, max: number): string | null {
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  return s ? s.slice(0, max) : null
}

/** Normalizalja a relativ mappa-utat: per-jel, nincs vezeto/zaro per, nincs `..`. */
export function cleanFolderRel(v: unknown): string | null {
  if (v === null || v === undefined) return null
  const s = String(v).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/').trim()
  if (!s) return null
  if (s.split('/').some((seg) => seg === '..' || seg === '.')) return null
  return s
}

/**
 * A bejovo mezok ellenorzese. `partial` = szerkesztes (csak a kuldott mezok).
 * A mappa letezeset NEM itt nezzuk (az a depotol fugg, lasd a route-ot) --
 * itt csak a formajat.
 */
export function validateProjectInput(input: ProjectInput, partial: boolean): ProjectValidation {
  const fields: Partial<ProjectRow> = {}
  if (!partial || input.name !== undefined) {
    const name = optText(input.name, 120)
    if (!name) return { ok: false, code: 'name_required' }
    fields.name = name
  }
  if (input.slug !== undefined && input.slug !== null && String(input.slug).trim()) {
    fields.slug = slugify(String(input.slug))
  }
  if (input.description !== undefined) fields.description = optText(input.description, 2000)
  if (input.client !== undefined) fields.client = optText(input.client, 200)
  if (input.status !== undefined) {
    const st = String(input.status)
    if (!(PROJECT_STATUSES as readonly string[]).includes(st)) return { ok: false, code: 'bad_status' }
    fields.status = st as ProjectStatus
  }
  if (input.folder_path !== undefined) {
    if (input.folder_path === null || String(input.folder_path).trim() === '') fields.folder_path = null
    else {
      const rel = cleanFolderRel(input.folder_path)
      if (!rel) return { ok: false, code: 'bad_folder' }
      fields.folder_path = rel
    }
  }
  if (input.default_label_id !== undefined) {
    const lid = optText(input.default_label_id, 64)
    if (lid && hasTable('labels')) {
      const exists = getDb().prepare('SELECT 1 FROM labels WHERE id = ?').get(lid)
      if (!exists) return { ok: false, code: 'bad_label' }
    }
    fields.default_label_id = lid
  }
  return { ok: true, fields }
}

export function createProject(input: ProjectInput): { ok: true; project: ProjectRow } | { ok: false; code: string } {
  ensureProjectTables()
  const v = validateProjectInput(input, false)
  if (!v.ok) return v
  const f = v.fields
  const id = newProjectId()
  const slug = uniqueSlug(f.slug || f.name!, undefined)
  const now = nowSec()
  getDb().prepare(
    `INSERT INTO projects (id, slug, name, description, client, status, folder_path, default_label_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, slug, f.name!, f.description ?? null, f.client ?? null, f.status ?? 'active',
    f.folder_path ?? null, f.default_label_id ?? null, now, now)
  return { ok: true, project: getProject(id)! }
}

export function updateProject(id: string, input: ProjectInput): { ok: true; project: ProjectRow } | { ok: false; code: string } {
  ensureProjectTables()
  const current = getProject(id)
  if (!current || current.id !== id) return { ok: false, code: 'not_found' }
  const v = validateProjectInput(input, true)
  if (!v.ok) return v
  const f = { ...v.fields }
  if (f.slug !== undefined) f.slug = uniqueSlug(f.slug, id)
  const keys = Object.keys(f) as (keyof typeof f)[]
  if (!keys.length) return { ok: true, project: current }
  const sets = keys.map((k) => `${k} = ?`).join(', ')
  getDb().prepare(`UPDATE projects SET ${sets}, updated_at = ? WHERE id = ?`)
    .run(...keys.map((k) => f[k] ?? null), nowSec(), id)
  return { ok: true, project: getProject(id)! }
}

/** Archivalas / visszahozas. Az archivalt projekt nem latszik a listaban, de
 *  semmi nem torlodik: a kartyai tovabbra is hozza tartoznak. */
export function setProjectArchived(id: string, archived: boolean): boolean {
  ensureProjectTables()
  const now = nowSec()
  return getDb().prepare('UPDATE projects SET archived_at = ?, updated_at = ? WHERE id = ?')
    .run(archived ? now : null, now, id).changes > 0
}

export function setProjectSummary(id: string, summary: string): boolean {
  ensureProjectTables()
  const now = nowSec()
  return getDb().prepare('UPDATE projects SET summary = ?, summary_at = ?, updated_at = ? WHERE id = ?')
    .run(summary, now, now, id).changes > 0
}

// ---- project_links ----------------------------------------------------------

export function isLinkType(v: unknown): v is ProjectLinkType {
  return typeof v === 'string' && (PROJECT_LINK_TYPES as readonly string[]).includes(v)
}

/** Egy objektum projekthez kotese. Ha mar masik projekthez tartozott, ATKERUL
 *  (egy objektum egyszerre egy projekt). */
export function linkObject(projectId: string, type: ProjectLinkType, objectId: string, createdBy?: string | null): void {
  ensureProjectTables()
  getDb().prepare(
    `INSERT INTO project_links (project_id, object_type, object_id, created_at, created_by)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(object_type, object_id) DO UPDATE SET project_id = excluded.project_id,
       created_at = excluded.created_at, created_by = excluded.created_by`,
  ).run(projectId, type, String(objectId), nowSec(), createdBy ?? null)
}

export function unlinkObject(type: ProjectLinkType, objectId: string): boolean {
  ensureProjectTables()
  return getDb().prepare('DELETE FROM project_links WHERE object_type = ? AND object_id = ?')
    .run(type, String(objectId)).changes > 0
}

export function listProjectLinks(projectId: string, type?: ProjectLinkType): ProjectLinkRow[] {
  ensureProjectTables()
  return (type
    ? getDb().prepare('SELECT * FROM project_links WHERE project_id = ? AND object_type = ? ORDER BY created_at DESC').all(projectId, type)
    : getDb().prepare('SELECT * FROM project_links WHERE project_id = ? ORDER BY created_at DESC').all(projectId)) as ProjectLinkRow[]
}

export function projectForObject(type: ProjectLinkType, objectId: string): string | null {
  ensureProjectTables()
  const row = getDb().prepare('SELECT project_id FROM project_links WHERE object_type = ? AND object_id = ?')
    .get(type, String(objectId)) as { project_id: string } | undefined
  return row?.project_id ?? null
}

/** A projekt kod-hid aliasai (`code_tasks.project` / `code_sessions.project`). */
export function projectCodeAliases(projectId: string): string[] {
  return listProjectLinks(projectId, 'code_alias').map((l) => l.object_id)
}

// ---- torles -----------------------------------------------------------------

export interface DeletePreview {
  cards: number
  openCards: number
  archivedCards: number
  ideas: number
  codeAliases: string[]
  otherLinks: number
  folderPath: string | null
}

/** Mit erint a torles -- a felulet EZT mutatja meg, mielott a gombot megnyomjak. */
export function projectDeletePreview(id: string): DeletePreview | null {
  ensureProjectTables()
  const p = getProject(id)
  if (!p || p.id !== id) return null
  const db = getDb()
  let cards = 0, openCards = 0, archivedCards = 0
  if (hasTable('kanban_cards')) {
    const r = db.prepare(
      `SELECT COUNT(*) total,
         SUM(CASE WHEN archived_at IS NULL AND status != 'done' THEN 1 ELSE 0 END) open,
         SUM(CASE WHEN archived_at IS NOT NULL THEN 1 ELSE 0 END) archived
       FROM kanban_cards WHERE project = ?`,
    ).get(id) as { total: number; open: number | null; archived: number | null }
    cards = r.total; openCards = r.open ?? 0; archivedCards = r.archived ?? 0
  }
  const links = listProjectLinks(id)
  return {
    cards,
    openCards,
    archivedCards,
    ideas: projectIdeaIds(id).length,
    codeAliases: links.filter((l) => l.object_type === 'code_alias').map((l) => l.object_id),
    otherLinks: links.filter((l) => l.object_type !== 'code_alias' && l.object_type !== 'idea').length,
    folderPath: p.folder_path,
  }
}

/**
 * A projekt torlese = a KAPCSOLAT bontasa. A kartyak a projekt nelkul
 * megmaradnak (a `project` mezojuk ures lesz), az otletek, a vitaztatasok es a
 * memoriak is. A mappa a lemezen marad -- a fizikai torles kulon, kifejezett
 * muvelet az Intezoben.
 */
export function deleteProject(id: string): { ok: boolean; unlinkedCards: number; removedLinks: number } {
  ensureProjectTables()
  const db = getDb()
  const p = db.prepare('SELECT id FROM projects WHERE id = ?').get(id)
  if (!p) return { ok: false, unlinkedCards: 0, removedLinks: 0 }
  let unlinkedCards = 0
  let removedLinks = 0
  db.transaction(() => {
    if (hasTable('kanban_cards')) {
      unlinkedCards = db.prepare('UPDATE kanban_cards SET project = NULL WHERE project = ?').run(id).changes
    }
    removedLinks = db.prepare('DELETE FROM project_links WHERE project_id = ?').run(id).changes
    db.prepare('DELETE FROM projects WHERE id = ?').run(id)
  })()
  return { ok: true, unlinkedCards, removedLinks }
}

// ---- levezetett kapcsolatok ---------------------------------------------------

/** A projekt NEM archivalt kartyainak id-je. */
export function projectCardIds(projectId: string, opts: { includeArchived?: boolean } = {}): string[] {
  if (!hasTable('kanban_cards')) return []
  return (getDb().prepare(
    `SELECT id FROM kanban_cards WHERE project = ? ${opts.includeArchived ? '' : 'AND archived_at IS NULL'}`,
  ).all(projectId) as { id: string }[]).map((r) => r.id)
}

/**
 * A projekt otletei: (1) amik kifejezetten hozza vannak kotve (`project_links`),
 * (2) amikhez tartozo kartya (`idea_box.kanban_id`) a projekte. Az utobbi
 * LEVEZETETT kapcsolat -- nem tarolja semmi kulon.
 */
export function projectIdeaIds(projectId: string): string[] {
  ensureProjectTables()
  const ids = new Set(listProjectLinks(projectId, 'idea').map((l) => l.object_id))
  if (hasTable('idea_box') && hasTable('kanban_cards')) {
    const rows = getDb().prepare(
      `SELECT i.id FROM idea_box i JOIN kanban_cards k ON k.id = i.kanban_id WHERE k.project = ?`,
    ).all(projectId) as { id: string }[]
    for (const r of rows) {
      // Ha az otlet kifejezetten MASIK projekthez van kotve, az a kotes nyer.
      const explicit = projectForObject('idea', r.id)
      if (!explicit || explicit === projectId) ids.add(r.id)
    }
  }
  return [...ids]
}
