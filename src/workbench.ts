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
 *   - `work_item_parts`     -- a munkadarab RESZEI (3. fazis): szoveg-blokk es
 *                              kep egy munkadarabon belul, sorrendben.
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
 *  nelkul is ertelmes kezdopont. Uj fajta felvetele: ide + `EDITOR_BY_TYPE`.
 *
 *  A `composite` a VEGYES munkadarab (Boss, 2026-09-21: "egy munkadarabban
 *  lehet egyszerre kep ES szoveg, pl. Facebook-poszt"). A jovahagyott irany
 *  (komment 1222/1223) szerint a fajta CSAK CIMKE, nem korlat: RESZEKET
 *  (`work_item_parts`) barmelyik fajta alá lehet tenni -- a `composite` csak
 *  azt mondja, hogy eleve vegyes tartalomnak indult. */
export const WORK_ITEM_TYPES = ['document', 'image', 'graphic', 'video', 'note', 'composite'] as const
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
  composite: 'composite',
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
  /** Kituzve (csillag) ekkor; NULL = nincs kituzve. A kituzottek a lista
   *  tetejen allnak, a kituzes sorrendjeben (#406, 21bcb1f4). */
  pinned_at: number | null
}

export interface WorkItemVersionRow {
  id: string
  work_item_id: string
  version_no: number
  parent_version_id: string | null
  manifest_path: string | null
  preview_path: string | null
  /** Melyik fajlra mutatott a munkadarab EBBEN a verzioban. NULL = nem mutatott. */
  source_path: string | null
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
  db.exec(`
    CREATE TABLE IF NOT EXISTS work_item_parts (
      id TEXT PRIMARY KEY,
      work_item_id TEXT NOT NULL,
      version_id TEXT,
      position INTEGER NOT NULL,
      kind TEXT NOT NULL,
      text TEXT,
      asset_path TEXT,
      mime_type TEXT,
      size INTEGER,
      caption TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      created_by TEXT
    )
  `)
  // Kesobb felvett oszlop: a mar letezo tablaba is bekerul. A verzio igy tudja,
  // MELYIK fajlra mutatott a munkadarab akkor -- e nelkul a visszaallitas csak
  // a reszeket hozna vissza, a forrasfajlt nem.
  const vCols = new Set((db.prepare('PRAGMA table_info(work_item_versions)').all() as { name: string }[]).map((c) => c.name))
  if (!vCols.has('source_path')) db.exec('ALTER TABLE work_item_versions ADD COLUMN source_path TEXT')
  const iCols = new Set((db.prepare('PRAGMA table_info(work_items)').all() as { name: string }[]).map((c) => c.name))
  if (!iCols.has('pinned_at')) db.exec('ALTER TABLE work_items ADD COLUMN pinned_at INTEGER')
  db.exec('CREATE INDEX IF NOT EXISTS idx_work_items_project ON work_items(project_id, updated_at DESC)')
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_work_item_versions_no ON work_item_versions(work_item_id, version_no)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_work_item_parts_item ON work_item_parts(work_item_id, position)')
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
      (id, work_item_id, version_no, parent_version_id, manifest_path, preview_path, source_path, prompt, created_by, created_at, metadata_json)
      VALUES (?, ?, 1, NULL, NULL, NULL, ?, ?, ?, ?, NULL)`)
      .run(versionId, id, sourcePath, prompt, createdBy, ts)
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

/** Egy projekt munkadarabjai: elol a kituzottek (a legutobb kituzott elol, hogy
 *  egy szerkesztes ne ugraltassa oket), utana a legutobb valtozott elol.
 *  Ismeretlen projektre ures lista -- a hivo dolga eldonteni, letezik-e a projekt. */
export function listWorkItems(projectId: string): WorkItemRow[] {
  ensureWorkbenchTables()
  const pid = String(projectId || '').trim()
  if (!pid) return []
  return getDb()
    .prepare('SELECT * FROM work_items WHERE project_id = ? ORDER BY (pinned_at IS NULL), pinned_at DESC, updated_at DESC, created_at DESC')
    .all(pid) as WorkItemRow[]
}

/**
 * Kituzes / levetel (csillag). A munkadarab `updated_at`-jet SZANDEKOSAN nem
 * erinti: a csillag nem szerkesztes, es ha az lenne, a levett darab a lista
 * tetejere ugrana. Ismetelt kituzes nem modositja az eredeti idopontot, igy a
 * kituzottek sorrendje stabil marad.
 */
export function setWorkItemPinned(id: string, pinned: boolean, now: number = Date.now()): WorkItemRow | undefined {
  const item = getWorkItem(id)
  if (!item) return undefined
  if (pinned && item.pinned_at == null) {
    getDb().prepare('UPDATE work_items SET pinned_at = ? WHERE id = ?').run(Math.floor(now), item.id)
  } else if (!pinned && item.pinned_at != null) {
    getDb().prepare('UPDATE work_items SET pinned_at = NULL WHERE id = ?').run(item.id)
  }
  return getWorkItem(item.id)
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

/** A verziok UGY, ahogy a felulet latja: a "melyik verziobol allt vissza" a
 *  `metadata_json`-ben all, de a kepernyore szamkent kell. Rosszul tarolt JSON
 *  nem dobhat hibat -- olyankor egyszeruen nincs ilyen adat (nem "nulla"). */
export interface WorkItemVersionView extends WorkItemVersionRow {
  restored_from: string | null
  restored_from_no: number | null
}

export function listWorkItemVersionsView(workItemId: string): WorkItemVersionView[] {
  return listWorkItemVersions(workItemId).map((v) => {
    let from: string | null = null
    let fromNo: number | null = null
    if (v.metadata_json) {
      try {
        const meta = JSON.parse(v.metadata_json) as Record<string, unknown>
        if (typeof meta['restored_from'] === 'string') from = meta['restored_from']
        if (typeof meta['restored_from_no'] === 'number') fromNo = meta['restored_from_no']
      } catch { /* rossz JSON: nincs adat, nem hiba */ }
    }
    return { ...v, restored_from: from, restored_from_no: fromNo }
  })
}

/** Hany munkadarab van a projektben (a belepesi pont szamlaloja). */
export function countWorkItems(projectId: string): number {
  ensureWorkbenchTables()
  const pid = String(projectId || '').trim()
  if (!pid) return 0
  const row = getDb().prepare('SELECT COUNT(*) AS n FROM work_items WHERE project_id = ?').get(pid) as { n: number }
  return row.n
}

// ---------------------------------------------------------------------------
// VEGYES (KOMPOZIT) MUNKADARAB -- reszek (kanban #336, 3. fazis)
//
// Boss, 2026-09-21: "egy munkadarabban lehet egyszerre kep ES szoveg (pl.
// Facebook-poszt: foto + iras)". A jovahagyott irany a szakma szerinti
// KOMPOZIT / modularis modell: a munkadarab KONTENER, ami tobb reszt tart --
// szoveg-blokkot es kepet --, mindegyiket sajat sorrenddel es felirattal.
//
// Ket dolgot szandekosan NEM csinalunk:
//   - nem korlatozzuk fajtara: reszt BARMELYIK munkadarab alá lehet tenni (a
//     fajta cimke, nem korlat);
//   - nem masoljuk be a kep bajtjait az adatbazisba: a kep a projekt mappajaban
//     marad, es a resz csak a Raktaron beluli UTJAT (`asset_path`) orzi. Igy a
//     fajl ott van, ahol a felhasznalo keresi, es a mentes is viszi.
// ---------------------------------------------------------------------------

/** Egy resz fajtaja. `text` = szoveg-blokk, `image` = kep a projekt mappajabol. */
export const WORK_ITEM_PART_KINDS = ['text', 'image'] as const
export type WorkItemPartKind = typeof WORK_ITEM_PART_KINDS[number]

/** Egy szoveg-blokk felso hatara. Egy poszt, nem egy konyv. */
export const PART_TEXT_MAX = 20_000
/** A felirat egy sor. */
export const PART_CAPTION_MAX = 500

export interface WorkItemPartRow {
  id: string
  work_item_id: string
  version_id: string | null
  position: number
  kind: WorkItemPartKind
  text: string | null
  /** A kep utja a Raktaron belul (ugyanaz a fajta ut, amit az Intezo hasznal). */
  asset_path: string | null
  mime_type: string | null
  size: number | null
  caption: string | null
  created_at: number
  updated_at: number
  created_by: string | null
}

export function isWorkItemPartKind(v: unknown): v is WorkItemPartKind {
  return typeof v === 'string' && (WORK_ITEM_PART_KINDS as readonly string[]).includes(v)
}

/** Egy munkadarab reszei, sorrendben. Ismeretlen munkadarabra ures lista -- a
 *  hivo dolga eldonteni, letezik-e a munkadarab (a NULLA ket dolgot jelenthet).
 *
 *  `versionId` nelkul az ELO reszek jonnek (a jelenlegi verzioe); megadva egy
 *  REGEBBI verzio pillanatkepe. Igy a regi verzio valoban valtozatlan marad:
 *  minden verzionak sajat resz-sorai vannak. A `version_id IS NULL` sorok a
 *  verziozas elott keletkezett adatot fogjak -- azok is elok. */
export function listWorkItemParts(workItemId: string, versionId?: string | null): WorkItemPartRow[] {
  ensureWorkbenchTables()
  const id = String(workItemId || '').trim()
  if (!id) return []
  const db = getDb()
  const wanted = String(versionId ?? '').trim()
  if (wanted) {
    return db.prepare('SELECT * FROM work_item_parts WHERE work_item_id = ? AND version_id = ? ORDER BY position ASC, created_at ASC')
      .all(id, wanted) as WorkItemPartRow[]
  }
  const item = getWorkItem(id)
  const cur = item ? item.current_version_id : null
  return db.prepare(`SELECT * FROM work_item_parts
      WHERE work_item_id = ? AND (version_id IS NULL OR version_id = ?)
      ORDER BY position ASC, created_at ASC`)
    .all(id, cur) as WorkItemPartRow[]
}

export function getWorkItemPart(id: string): WorkItemPartRow | undefined {
  ensureWorkbenchTables()
  const v = String(id || '').trim()
  if (!v) return undefined
  return getDb().prepare('SELECT * FROM work_item_parts WHERE id = ?').get(v) as WorkItemPartRow | undefined
}

/**
 * Egy SZERKESZTHETO resz: az adott munkadarabe (ha meg van adva) es ELO
 * (a jelenlegi verzioe, vagy verziozas elotti). Egy regebbi verzio
 * pillanatkepe SOSE irhato at, es egy masik munkadarab resze sem erheto el
 * egy idegen munkadarab URL-jen at -- az megkerulte az archiv-vedelmet es a
 * verzio-tortenetet is.
 */
function editablePart(id: string, workItemId?: string): WorkItemPartRow | undefined {
  const part = getWorkItemPart(id)
  if (!part) return undefined
  if (workItemId !== undefined && part.work_item_id !== workItemId) return undefined
  if (part.version_id != null) {
    const item = getWorkItem(part.work_item_id)
    if (!item || item.current_version_id !== part.version_id) return undefined
  }
  return part
}

export interface AddWorkItemPartInput {
  work_item_id: string
  kind?: unknown
  text?: unknown
  asset_path?: unknown
  mime_type?: unknown
  size?: unknown
  caption?: unknown
  created_by?: string | null
}

export type PartErrorCode =
  | 'bad_kind' | 'text_required' | 'text_too_long' | 'asset_required' | 'caption_too_long' | 'part_not_found'

export type AddWorkItemPartResult =
  | { ok: true; part: WorkItemPartRow }
  | { ok: false; code: PartErrorCode }

function touchWorkItem(id: string, ts: number): void {
  getDb().prepare('UPDATE work_items SET updated_at = ? WHERE id = ?').run(ts, id)
}

/** Uj resz a munkadarab vegere. A hivo mar ellenorizte, hogy a munkadarab letezik. */
export function addWorkItemPart(input: AddWorkItemPartInput): AddWorkItemPartResult {
  ensureWorkbenchTables()
  const rawKind = input.kind === undefined || input.kind === null || input.kind === '' ? 'text' : input.kind
  if (!isWorkItemPartKind(rawKind)) return { ok: false, code: 'bad_kind' }
  const kind: WorkItemPartKind = rawKind
  const text = input.text === undefined || input.text === null ? '' : String(input.text)
  const caption = String(input.caption ?? '').trim()
  if (caption.length > PART_CAPTION_MAX) return { ok: false, code: 'caption_too_long' }
  const assetPath = String(input.asset_path ?? '').trim()
  if (kind === 'text') {
    if (!text.trim()) return { ok: false, code: 'text_required' }
    if (text.length > PART_TEXT_MAX) return { ok: false, code: 'text_too_long' }
  } else if (!assetPath) {
    return { ok: false, code: 'asset_required' }
  }

  const db = getDb()
  const ts = nowSec()
  const id = randomUUID()
  const item = getWorkItem(input.work_item_id)
  const row = db.prepare('SELECT COALESCE(MAX(position), 0) AS p FROM work_item_parts WHERE work_item_id = ?')
    .get(input.work_item_id) as { p: number }
  const size = Number.isFinite(Number(input.size)) && Number(input.size) >= 0 ? Math.floor(Number(input.size)) : null
  db.transaction(() => {
    db.prepare(`INSERT INTO work_item_parts
      (id, work_item_id, version_id, position, kind, text, asset_path, mime_type, size, caption, created_at, updated_at, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        id, input.work_item_id, item ? item.current_version_id : null, row.p + 1, kind,
        kind === 'text' ? text : (text.trim() || null),
        kind === 'image' ? assetPath : (assetPath || null),
        String(input.mime_type ?? '').trim() || null,
        size, caption || null, ts, ts, input.created_by ?? null,
      )
    touchWorkItem(input.work_item_id, ts)
  })()
  const part = getWorkItemPart(id)
  // A sor most kelt: ha megsem olvashato vissza, az nem "ures", hanem hiba.
  if (!part) throw new Error('work item part was created but could not be read back')
  return { ok: true, part }
}

export interface UpdateWorkItemPartInput {
  text?: unknown
  caption?: unknown
}

export type UpdateWorkItemPartResult =
  | { ok: true; part: WorkItemPartRow }
  | { ok: false; code: PartErrorCode }

/** Egy resz szovegenek vagy feliratanak javitasa. Ami nincs a bemenetben, az
 *  valtozatlan marad (az ures mezo "nem valtozott", nem "torold"). */
export function updateWorkItemPart(id: string, input: UpdateWorkItemPartInput, workItemId?: string): UpdateWorkItemPartResult {
  ensureWorkbenchTables()
  const part = editablePart(id, workItemId)
  if (!part) return { ok: false, code: 'part_not_found' }
  let text = part.text
  if (input.text !== undefined) {
    const v = String(input.text ?? '')
    if (part.kind === 'text' && !v.trim()) return { ok: false, code: 'text_required' }
    if (v.length > PART_TEXT_MAX) return { ok: false, code: 'text_too_long' }
    text = part.kind === 'text' ? v : (v.trim() || null)
  }
  let caption = part.caption
  if (input.caption !== undefined) {
    const v = String(input.caption ?? '').trim()
    if (v.length > PART_CAPTION_MAX) return { ok: false, code: 'caption_too_long' }
    caption = v || null
  }
  const ts = nowSec()
  const db = getDb()
  db.transaction(() => {
    db.prepare('UPDATE work_item_parts SET text = ?, caption = ?, updated_at = ? WHERE id = ?').run(text, caption, ts, id)
    touchWorkItem(part.work_item_id, ts)
  })()
  const after = getWorkItemPart(id)
  if (!after) throw new Error('work item part vanished while it was being updated')
  return { ok: true, part: after }
}

/** Egy resz elmozgatasa fel/le. A sorszamok utana 1..n-ig folytonosak. */
export function moveWorkItemPart(id: string, dir: 'up' | 'down', workItemId?: string): { ok: true; parts: WorkItemPartRow[] } | { ok: false; code: PartErrorCode } {
  ensureWorkbenchTables()
  const part = editablePart(id, workItemId)
  if (!part) return { ok: false, code: 'part_not_found' }
  const parts = listWorkItemParts(part.work_item_id)
  const at = parts.findIndex((p) => p.id === part.id)
  const to = dir === 'up' ? at - 1 : at + 1
  if (at >= 0 && to >= 0 && to < parts.length) {
    const reordered = parts.slice()
    reordered.splice(to, 0, reordered.splice(at, 1)[0])
    const ts = nowSec()
    const db = getDb()
    db.transaction(() => {
      reordered.forEach((p, i) => {
        db.prepare('UPDATE work_item_parts SET position = ?, updated_at = ? WHERE id = ?').run(i + 1, ts, p.id)
      })
      touchWorkItem(part.work_item_id, ts)
    })()
  }
  return { ok: true, parts: listWorkItemParts(part.work_item_id) }
}

/**
 * Egy resz eltavolitasa a munkadarabbol.
 *
 * A KEP FAJLJAT NEM torli: az a projekt mappajaban marad, ahol a felhasznalo
 * keresi. Egy resz kivetele a munkadarabbol nem ugyanaz, mint egy fajl
 * torlese a gepen -- az utobbi visszafordithatatlan, es nem a Munkapad dolga.
 */
export function removeWorkItemPart(id: string, workItemId?: string): { ok: true; part: WorkItemPartRow } | { ok: false; code: PartErrorCode } {
  ensureWorkbenchTables()
  const part = editablePart(id, workItemId)
  if (!part) return { ok: false, code: 'part_not_found' }
  const ts = nowSec()
  const db = getDb()
  db.transaction(() => {
    db.prepare('DELETE FROM work_item_parts WHERE id = ?').run(id)
    listWorkItemParts(part.work_item_id).forEach((p, i) => {
      db.prepare('UPDATE work_item_parts SET position = ? WHERE id = ?').run(i + 1, p.id)
    })
    touchWorkItem(part.work_item_id, ts)
  })()
  return { ok: true, part }
}

/** Hany resz van a munkadarabban (a lista-sor jelolesehez). */
export function countWorkItemParts(workItemId: string): number {
  ensureWorkbenchTables()
  const id = String(workItemId || '').trim()
  if (!id) return 0
  // Csak az ELO reszek szamitanak: a regi verziok pillanatkepei nem duplaznak.
  const item = getWorkItem(id)
  const cur = item ? item.current_version_id : null
  const row = getDb().prepare(
    'SELECT COUNT(*) AS n FROM work_item_parts WHERE work_item_id = ? AND (version_id IS NULL OR version_id = ?)',
  ).get(id, cur) as { n: number }
  return row.n
}

// --- VERZIOZAS (kanban #336, 5. fazis; spec 12) ------------------------------
//
// "Minden jelentos modositas uj verzio. Az eredeti automatikusan nem irhato
// felul. Restore v2 -> v5 = v2 allapotanak UJ verzioja. A kesobbi verziok nem
// torlodnek."
//
// Ezert: egy verzio PILLANATKEP. Minden verzionak sajat resz-sorai vannak, a
// munkadarab `source_path`-ja is beleirodik -- igy a visszaallitas nem csak a
// szoveget/kepeket hozza vissza, hanem azt is, MELYIK fajlra mutatott akkor.
// Torles SEHOL nincs: a visszaallitas is UJ verziot ir, a regieket nem bantja.

export interface CreateWorkItemVersionInput {
  prompt?: unknown
  created_by?: string | null
  /** Ha megadod, a munkadarab forrasfajlja is EZ lesz mostantol. */
  source_path?: unknown
  manifest_path?: unknown
  preview_path?: unknown
  metadata_json?: unknown
}

export type VersionErrorCode = 'item_not_found' | 'version_not_found' | 'version_mismatch'

export type CreateWorkItemVersionResult =
  | { ok: true; item: WorkItemRow; version: WorkItemVersionRow }
  | { ok: false; code: VersionErrorCode }

/** A verzio-sorok ES a hozzajuk tartozo resz-masolatok egy helyen: ezt hasznalja
 *  az "uj verzio" es a "visszaallitas" is, hogy ne lehessen ketfele viselkedes. */
function insertVersion(
  itemId: string,
  from: { parent: string | null; source_path: string | null; manifest_path: string | null; preview_path: string | null },
  copyPartsOfVersion: string | null,
  extra: { prompt: string | null; created_by: string | null; metadata_json: string | null },
): WorkItemVersionRow {
  const db = getDb()
  const ts = nowSec()
  const versionId = randomUUID()
  const noRow = db.prepare('SELECT COALESCE(MAX(version_no), 0) AS n FROM work_item_versions WHERE work_item_id = ?')
    .get(itemId) as { n: number }
  db.transaction(() => {
    db.prepare(`INSERT INTO work_item_versions
      (id, work_item_id, version_no, parent_version_id, manifest_path, preview_path, source_path, prompt, created_by, created_at, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        versionId, itemId, noRow.n + 1, from.parent, from.manifest_path, from.preview_path,
        from.source_path, extra.prompt, extra.created_by, ts, extra.metadata_json,
      )
    // A reszek MASOLODNAK: a regi verzio sorai erintetlenul maradnak.
    const source = copyPartsOfVersion === null
      ? db.prepare(`SELECT * FROM work_item_parts WHERE work_item_id = ? AND version_id IS NULL ORDER BY position ASC, created_at ASC`).all(itemId)
      : db.prepare(`SELECT * FROM work_item_parts WHERE work_item_id = ? AND version_id = ? ORDER BY position ASC, created_at ASC`).all(itemId, copyPartsOfVersion)
    const ins = db.prepare(`INSERT INTO work_item_parts
      (id, work_item_id, version_id, position, kind, text, asset_path, mime_type, size, caption, created_at, updated_at, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    for (const raw of source as WorkItemPartRow[]) {
      ins.run(
        randomUUID(), itemId, versionId, raw.position, raw.kind, raw.text, raw.asset_path,
        raw.mime_type, raw.size, raw.caption, ts, ts, raw.created_by,
      )
    }
    db.prepare('UPDATE work_items SET current_version_id = ?, source_path = ?, updated_at = ? WHERE id = ?')
      .run(versionId, from.source_path, ts, itemId)
  })()
  const version = getWorkItemVersion(versionId)
  if (!version) throw new Error('work item version was created but could not be read back')
  return version
}

/** Uj verzio a munkadarab MOSTANI allapotarol. A regi verzio valtozatlan marad. */
export function createWorkItemVersion(workItemId: string, input: CreateWorkItemVersionInput = {}): CreateWorkItemVersionResult {
  ensureWorkbenchTables()
  const item = getWorkItem(workItemId)
  if (!item) return { ok: false, code: 'item_not_found' }
  const sourcePath = input.source_path === undefined
    ? item.source_path
    : (String(input.source_path ?? '').trim() || null)
  const version = insertVersion(
    item.id,
    {
      parent: item.current_version_id,
      source_path: sourcePath,
      manifest_path: String(input.manifest_path ?? '').trim() || null,
      preview_path: String(input.preview_path ?? '').trim() || null,
    },
    item.current_version_id,
    {
      prompt: String(input.prompt ?? '').trim() || null,
      created_by: input.created_by ?? null,
      metadata_json: input.metadata_json === undefined || input.metadata_json === null
        ? null
        : String(input.metadata_json),
    },
  )
  const fresh = getWorkItem(item.id)
  if (!fresh) throw new Error('work item disappeared while creating a version')
  return { ok: true, item: fresh, version }
}

/** Egy REGI verzio visszaallitasa. Nem ir felul semmit: UJ verzio keletkezik,
 *  aminek a tartalma a regie -- a kozben keletkezett verziok megmaradnak. */
export function restoreWorkItemVersion(
  versionId: string,
  opts: { created_by?: string | null; work_item_id?: string } = {},
): CreateWorkItemVersionResult {
  ensureWorkbenchTables()
  const target = getWorkItemVersion(versionId)
  if (!target) return { ok: false, code: 'version_not_found' }
  // A hivo megmondhatja, MELYIK munkadarabrol beszel -- ha nem egyezik, az nem
  // "nem talalom", hanem osszekeveres, es kulon valaszt erdemel.
  if (opts.work_item_id && opts.work_item_id !== target.work_item_id) return { ok: false, code: 'version_mismatch' }
  const item = getWorkItem(target.work_item_id)
  if (!item) return { ok: false, code: 'item_not_found' }
  const version = insertVersion(
    item.id,
    {
      parent: target.id,
      source_path: target.source_path,
      manifest_path: target.manifest_path,
      preview_path: target.preview_path,
    },
    target.id,
    {
      prompt: target.prompt,
      created_by: opts.created_by ?? null,
      metadata_json: JSON.stringify({ restored_from: target.id, restored_from_no: target.version_no }),
    },
  )
  const fresh = getWorkItem(item.id)
  if (!fresh) throw new Error('work item disappeared while restoring a version')
  return { ok: true, item: fresh, version }
}
