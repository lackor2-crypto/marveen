/**
 * AI MUNKAPAD -- tarolasi reteg (kanban #336, 740b432a, 1. fazis).
 *
 * A Munkapad a Projektek modul (#321) fole epul: NEM uj projekt-fogalom, hanem
 * a projekt munkavegzo nezete. Ez a modul csak a spec 14. szakaszanak elso ket
 * tablajat hozza, semmi tobbet:
 *
 *   - `work_items`          -- egy munkadarab (dokumentum, kep, grafika, video,
 *                              jegyzet) egy projekten belul;
 *   - `work_item_versions`  -- a munkadarab verzioi (v1, v2, ...). Letrehozaskor
 *                              magatol szuletik egy v1.
 *
 * A tobbi spec-tabla (`work_item_assets`, `agent_sessions`, `agent_messages`,
 * `agent_tool_calls`, `render_jobs`) KESOBBI fazisoke -- itt szandekosan nincs
 * belolük semmi.
 *
 * FORK-BARAT: a tablak a `src/db.ts` erintese nelkul jonnek letre, ugyanazzal a
 * DB-peldanyhoz kotott "kesz vagyok" jelzovel, mint a `projects.ts`. Egy
 * ujrainicializalt (teszt-) adatbazis mas peldany, ott a tablat ujra meg kell
 * csinalni. Friss telepitesen (ures store/, ures db) az elso hivas hozza letre
 * oket -- kulon migracios lepes nem kell.
 */
import { randomUUID } from 'node:crypto'
import { getDb } from './db.js'

/** Munkadarab-fajtak. A spec 3. szakasza a bal panelen Dokumentum / Kep /
 *  Grafika / Video kategoriakat sorol; a `note` a szoveges jegyzet, ami AI
 *  nelkul is ertelmes kezdopont. Uj fajta felvetele: ide + `EDITOR_BY_TYPE`. */
export const WORK_ITEM_TYPES = ['document', 'image', 'graphic', 'video', 'note'] as const
export type WorkItemType = typeof WORK_ITEM_TYPES[number]

/** Munkadarab-allapotok. Szandekosan keves: a kanban-statuszoktol fuggetlen,
 *  a munkadarab sajat eletciklusa. */
export const WORK_ITEM_STATUSES = ['draft', 'in_progress', 'review', 'done'] as const
export type WorkItemStatus = typeof WORK_ITEM_STATUSES[number]

/** Melyik szerkeszto/preview felulet tartozik a fajtahoz. A 3. fazis (preview)
 *  ezt olvassa; addig csak tarolodik. */
export const EDITOR_BY_TYPE: Record<WorkItemType, string> = {
  document: 'document',
  image: 'image',
  graphic: 'graphic',
  video: 'video',
  note: 'text',
}

export interface WorkItemRow {
  id: string
  project_id: string
  type: WorkItemType
  title: string
  status: WorkItemStatus
  /** A munkadarab fajlja a Raktarban, a projektmappahoz kepest. NULL = meg nincs. */
  source_path: string | null
  editor_type: string
  current_version_id: string | null
  created_at: number
  updated_at: number
  created_by: string | null
}

export interface WorkItemVersionRow {
  id: string
  work_item_id: string
  version_no: number
  parent_version_id: string | null
  manifest_path: string | null
  preview_path: string | null
  prompt: string | null
  created_by: string | null
  created_at: number
  metadata_json: string | null
}

const nowSec = (): number => Math.floor(Date.now() / 1000)

let tablesDb: unknown = null

/** A Munkapad tablainak letrehozasa, ha meg nincsenek. Idempotens, olcso. */
export function ensureWorkbenchTables(): void {
  const db = getDb()
  if (tablesDb === db) return
  db.exec(`
    CREATE TABLE IF NOT EXISTS work_items (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      source_path TEXT,
      editor_type TEXT NOT NULL DEFAULT 'text',
      current_version_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      created_by TEXT
    )
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS work_item_versions (
      id TEXT PRIMARY KEY,
      work_item_id TEXT NOT NULL,
      version_no INTEGER NOT NULL,
      parent_version_id TEXT,
      manifest_path TEXT,
      preview_path TEXT,
      prompt TEXT,
      created_by TEXT,
      created_at INTEGER NOT NULL,
      metadata_json TEXT
    )
  `)
  db.exec('CREATE INDEX IF NOT EXISTS idx_work_items_project ON work_items(project_id, updated_at DESC)')
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_work_item_versions_no ON work_item_versions(work_item_id, version_no)')
  tablesDb = db
}

export function isWorkItemType(v: unknown): v is WorkItemType {
  return typeof v === 'string' && (WORK_ITEM_TYPES as readonly string[]).includes(v)
}

export function isWorkItemStatus(v: unknown): v is WorkItemStatus {
  return typeof v === 'string' && (WORK_ITEM_STATUSES as readonly string[]).includes(v)
}

/** A cim felso hatara: egy sor, nem egy dokumentum. */
export const TITLE_MAX = 200

export interface CreateWorkItemInput {
  project_id: string
  type?: unknown
  title?: unknown
  status?: unknown
  source_path?: unknown
  created_by?: string | null
  /** A v1 verzio melle mentett keres (ha a felhasznalo irt ilyet). */
  prompt?: unknown
}

export type CreateWorkItemResult =
  | { ok: true; item: WorkItemRow; version: WorkItemVersionRow }
  | { ok: false; code: 'title_required' | 'title_too_long' | 'bad_type' | 'bad_status' }

function newWorkItemId(): string {
  const db = getDb()
  for (let i = 0; i < 20; i++) {
    const id = randomUUID().slice(0, 8)
    if (!db.prepare('SELECT 1 FROM work_items WHERE id = ?').get(id)) return id
  }
  return randomUUID().replace(/-/g, '').slice(0, 12)
}

/**
 * Uj munkadarab + a hozza tartozo v1 verzio. A ketto EGY tranzakcioban
 * keletkezik: nem maradhat verzio nelkuli munkadarab (a kozepso panel a
 * verziora epul), es nem maradhat gazdatlan verzio sem.
 */
export function createWorkItem(input: CreateWorkItemInput): CreateWorkItemResult {
  ensureWorkbenchTables()
  const title = String(input.title ?? '').trim()
  if (!title) return { ok: false, code: 'title_required' }
  if (title.length > TITLE_MAX) return { ok: false, code: 'title_too_long' }
  const rawType = input.type === undefined || input.type === null || input.type === '' ? 'note' : input.type
  if (!isWorkItemType(rawType)) return { ok: false, code: 'bad_type' }
  const type: WorkItemType = rawType
  const rawStatus = input.status === undefined || input.status === null || input.status === '' ? 'draft' : input.status
  if (!isWorkItemStatus(rawStatus)) return { ok: false, code: 'bad_status' }
  const status: WorkItemStatus = rawStatus

  const db = getDb()
  const ts = nowSec()
  const id = newWorkItemId()
  const versionId = randomUUID()
  const sourcePath = input.source_path === undefined || input.source_path === null
    ? null
    : (String(input.source_path).trim() || null)
  const prompt = input.prompt === undefined || input.prompt === null
    ? null
    : (String(input.prompt).trim() || null)
  const createdBy = input.created_by ?? null

  db.transaction(() => {
    db.prepare(`INSERT INTO work_items
      (id, project_id, type, title, status, source_path, editor_type, current_version_id, created_at, updated_at, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, input.project_id, type, title, status, sourcePath, EDITOR_BY_TYPE[type], versionId, ts, ts, createdBy)
    db.prepare(`INSERT INTO work_item_versions
      (id, work_item_id, version_no, parent_version_id, manifest_path, preview_path, prompt, created_by, created_at, metadata_json)
      VALUES (?, ?, 1, NULL, NULL, NULL, ?, ?, ?, NULL)`)
      .run(versionId, id, prompt, createdBy, ts)
  })()

  const item = getWorkItem(id)
  const version = getWorkItemVersion(versionId)
  // A ket sor most kelt, egy tranzakcioban -- ha megsem olvashato vissza, az
  // nem "ures lista", hanem hiba, es nem szabad elhallgatni.
  if (!item || !version) throw new Error('work item was created but could not be read back')
  return { ok: true, item, version }
}

export function getWorkItem(id: string): WorkItemRow | undefined {
  ensureWorkbenchTables()
  const v = String(id || '').trim()
  if (!v) return undefined
  return getDb().prepare('SELECT * FROM work_items WHERE id = ?').get(v) as WorkItemRow | undefined
}

export function getWorkItemVersion(id: string): WorkItemVersionRow | undefined {
  ensureWorkbenchTables()
  const v = String(id || '').trim()
  if (!v) return undefined
  return getDb().prepare('SELECT * FROM work_item_versions WHERE id = ?').get(v) as WorkItemVersionRow | undefined
}

/** Egy projekt munkadarabjai, a legutobb valtozott elol. Ismeretlen projektre
 *  ures lista -- a hivo dolga eldonteni, letezik-e a projekt. */
export function listWorkItems(projectId: string): WorkItemRow[] {
  ensureWorkbenchTables()
  const pid = String(projectId || '').trim()
  if (!pid) return []
  return getDb()
    .prepare('SELECT * FROM work_items WHERE project_id = ? ORDER BY updated_at DESC, created_at DESC')
    .all(pid) as WorkItemRow[]
}

/** Egy munkadarab verzioi, a legfrissebb elol. */
export function listWorkItemVersions(workItemId: string): WorkItemVersionRow[] {
  ensureWorkbenchTables()
  const id = String(workItemId || '').trim()
  if (!id) return []
  return getDb()
    .prepare('SELECT * FROM work_item_versions WHERE work_item_id = ? ORDER BY version_no DESC')
    .all(id) as WorkItemVersionRow[]
}

/** Hany munkadarab van a projektben (a belepesi pont szamlaloja). */
export function countWorkItems(projectId: string): number {
  ensureWorkbenchTables()
  const pid = String(projectId || '').trim()
  if (!pid) return 0
  const row = getDb().prepare('SELECT COUNT(*) AS n FROM work_items WHERE project_id = ?').get(pid) as { n: number }
  return row.n
}
