/**
 * VIRTUALIS MAPPAK A PROJEKT OTLETLADA / VITAZTATAS / HATTERANYAG FULEIN
 * (kanban #359).
 *
 * A tulajdonos dontese (2026-09-24, 1A/2A): a harom ful elemei mappakba
 * rendezhetok -- pl. "Tozsdei fejlesztesi otletek", "Marvin fejlesztesi
 * otletek", vagy a vitaknal "Bunteto", "Valoper", "Gyerek". A mappa VIRTUALIS:
 * csak a projekt adatbazisaban el, a lemezen semmi nem mozdul, egy elem
 * atsorolasa nem nyul az elemhez magahoz (az otlet, a vita, a hatteranyag-fajl
 * ugyanaz marad). Egy elem egy projekten belul legfeljebb EGY mappaban van;
 * ami sehol, az "Nincs mappaban".
 *
 * A mappak projektenkent kulonallnak (a 3. kerdesnel a dontes rank maradt): a
 * Tozsde projekt mappai nem jelennek meg a Marveen projektben.
 *
 * A besorolasi JAVASLAT (2A) csak javasol: a modell a meg mappa nelkuli elemek
 * cimet kapja, meglevo mappat vagy uj mappanevet ad, es a felulet elonezetben
 * mutatja. Csak a tulajdonos altal kipipalt sorok kerulnek at
 * (`applyVFolderPlan`). Fizetos API soha: ugyanaz a lanc, mint az iktatasnal
 * (sajat Claude-elofizetes, aztan helyi modell).
 */
import { randomUUID } from 'node:crypto'
import { getDb } from './db.js'
import { askAiJson } from './life-inbox-ai.js'

export const VFOLDER_KINDS = ['idea', 'debate', 'research'] as const
export type VFolderKind = typeof VFOLDER_KINDS[number]

export const VFOLDER_NAME_MAX = 60
export const VFOLDER_MAX_PER_KIND = 100
/** Egy javaslatkeresben legfeljebb ennyi elem megy a modellnek. */
export const SUGGEST_MAX_ITEMS = 60

export interface VFolder { id: string; name: string; sort: number; created_at: number }
export interface VFolderState { folders: VFolder[]; items: Record<string, string> }

export function isVFolderKind(v: unknown): v is VFolderKind {
  return typeof v === 'string' && (VFOLDER_KINDS as readonly string[]).includes(v)
}

let tablesDb: unknown = null
function ensureTables(): void {
  const db = getDb()
  if (tablesDb === db) return
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_vfolders (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      name_key TEXT NOT NULL,
      sort INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_project_vfolders_name ON project_vfolders(project_id, kind, name_key);
    CREATE TABLE IF NOT EXISTS project_vfolder_items (
      project_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      object_id TEXT NOT NULL,
      folder_id TEXT NOT NULL,
      assigned_by TEXT NOT NULL DEFAULT 'owner',
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (project_id, kind, object_id)
    );
    CREATE INDEX IF NOT EXISTS idx_project_vfolder_items_folder ON project_vfolder_items(folder_id);
  `)
  tablesDb = db
}

/** A mappanev tisztitasa: szokozok osszehuzva, vezerlokarakter es perjel nelkul. */
export function cleanVFolderName(v: unknown): string {
  if (typeof v !== 'string') return ''
  return v.replace(/[\u0000-\u001f\u007f/\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, VFOLDER_NAME_MAX).trim()
}

export function listVFolders(projectId: string, kind: VFolderKind): VFolderState {
  ensureTables()
  const db = getDb()
  const folders = db.prepare(
    'SELECT id, name, sort, created_at FROM project_vfolders WHERE project_id = ? AND kind = ? ORDER BY sort, name_key',
  ).all(projectId, kind) as VFolder[]
  const rows = db.prepare('SELECT object_id, folder_id FROM project_vfolder_items WHERE project_id = ? AND kind = ?')
    .all(projectId, kind) as { object_id: string; folder_id: string }[]
  const items: Record<string, string> = {}
  for (const r of rows) items[r.object_id] = r.folder_id
  return { folders, items }
}

export type VFolderOutcome<T = {}> = ({ ok: true } & T) | { ok: false; code: 'vfolder_name_required' | 'vfolder_exists' | 'vfolder_missing' | 'vfolder_limit' }

/** Az egyediseg kulcsa: az SQLite NOCASE csak ASCII-t hasonlit, az "Ő"/"ő"-t
 *  nem -- ezert a kis-nagybetu nelkuli kulcsot a kod kepzi. */
export function vfolderKey(name: string): string {
  return name.toLocaleLowerCase('hu').normalize('NFC')
}

function findByName(projectId: string, kind: VFolderKind, name: string): VFolder | undefined {
  return getDb().prepare('SELECT id, name, sort, created_at FROM project_vfolders WHERE project_id = ? AND kind = ? AND name_key = ?')
    .get(projectId, kind, vfolderKey(name)) as VFolder | undefined
}

function folderOf(projectId: string, kind: VFolderKind, folderId: string): VFolder | undefined {
  return getDb().prepare('SELECT id, name, sort, created_at FROM project_vfolders WHERE id = ? AND project_id = ? AND kind = ?')
    .get(folderId, projectId, kind) as VFolder | undefined
}

export function createVFolder(projectId: string, kind: VFolderKind, rawName: unknown): VFolderOutcome<{ folder: VFolder }> {
  ensureTables()
  const name = cleanVFolderName(rawName)
  if (!name) return { ok: false, code: 'vfolder_name_required' }
  if (findByName(projectId, kind, name)) return { ok: false, code: 'vfolder_exists' }
  const db = getDb()
  const n = (db.prepare('SELECT COUNT(*) AS n FROM project_vfolders WHERE project_id = ? AND kind = ?').get(projectId, kind) as { n: number }).n
  if (n >= VFOLDER_MAX_PER_KIND) return { ok: false, code: 'vfolder_limit' }
  const folder: VFolder = { id: randomUUID().slice(0, 8), name, sort: 0, created_at: Math.floor(Date.now() / 1000) }
  db.prepare('INSERT INTO project_vfolders (id, project_id, kind, name, name_key, sort, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(folder.id, projectId, kind, folder.name, vfolderKey(folder.name), folder.sort, folder.created_at)
  return { ok: true, folder }
}

export function renameVFolder(projectId: string, kind: VFolderKind, folderId: string, rawName: unknown): VFolderOutcome {
  ensureTables()
  const name = cleanVFolderName(rawName)
  if (!name) return { ok: false, code: 'vfolder_name_required' }
  if (!folderOf(projectId, kind, folderId)) return { ok: false, code: 'vfolder_missing' }
  const clash = findByName(projectId, kind, name)
  if (clash && clash.id !== folderId) return { ok: false, code: 'vfolder_exists' }
  getDb().prepare('UPDATE project_vfolders SET name = ?, name_key = ? WHERE id = ?').run(name, vfolderKey(name), folderId)
  return { ok: true }
}

/** A mappa torlese. Az elemek NEM torlodnek: "Nincs mappaban" lesznek. */
export function deleteVFolder(projectId: string, kind: VFolderKind, folderId: string): VFolderOutcome<{ released: number }> {
  ensureTables()
  if (!folderOf(projectId, kind, folderId)) return { ok: false, code: 'vfolder_missing' }
  const db = getDb()
  let released = 0
  db.transaction(() => {
    released = db.prepare('DELETE FROM project_vfolder_items WHERE folder_id = ?').run(folderId).changes
    db.prepare('DELETE FROM project_vfolders WHERE id = ?').run(folderId)
  })()
  return { ok: true, released }
}

/** Egy elem athelyezese. `folderId` null = "Nincs mappaban". */
export function assignVFolder(projectId: string, kind: VFolderKind, objectId: string, folderId: string | null, by = 'owner'): VFolderOutcome {
  ensureTables()
  const db = getDb()
  if (folderId === null) {
    db.prepare('DELETE FROM project_vfolder_items WHERE project_id = ? AND kind = ? AND object_id = ?').run(projectId, kind, objectId)
    return { ok: true }
  }
  if (!folderOf(projectId, kind, folderId)) return { ok: false, code: 'vfolder_missing' }
  db.prepare(
    `INSERT INTO project_vfolder_items (project_id, kind, object_id, folder_id, assigned_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_id, kind, object_id) DO UPDATE SET folder_id = excluded.folder_id, assigned_by = excluded.assigned_by, updated_at = excluded.updated_at`,
  ).run(projectId, kind, objectId, folderId, by, Math.floor(Date.now() / 1000))
  return { ok: true }
}

/** A projekt torlesekor: a projekt sajat mappai eltunnek (az elemek nem). */
export function forgetProjectVFolders(projectId: string): void {
  ensureTables()
  const db = getDb()
  db.transaction(() => {
    db.prepare('DELETE FROM project_vfolder_items WHERE project_id = ?').run(projectId)
    db.prepare('DELETE FROM project_vfolders WHERE project_id = ?').run(projectId)
  })()
}

// ---- Besorolasi javaslat (2A) ----------------------------------------------

export interface SuggestItem { id: string; title: string; hint?: string }
export interface PlanRow { id: string; folder: string; isNew: boolean; reason: string }

const SYSTEM = `You sort the items of one project into folders, like a tidy person sorts papers.
You get the folders that already exist and a list of items that are in no folder yet.
Put each item into an existing folder when it fits. When several items share a clear topic that no existing folder covers, propose ONE short new folder name for them (1-4 words, in the requested language, no numbering, no emoji).
Do not make a folder for a single item unless the topic is obviously distinct. Prefer few, clear folders over many.
If you are not sure where an item belongs, answer null for it -- it stays unsorted and the owner decides.
Never invent item ids. Answer with ONLY a JSON object, no prose, no code fence:
{"items":[{"id":"<item id>","folder":"<existing or new folder name, or null>","reason":"<max 10 words, in the requested language>"}]}`

const KIND_WORD: Record<VFolderKind, string> = { idea: 'ideas', debate: 'debates (a question discussed by several AI models)', research: 'background research documents' }

export function suggestPrompt(kind: VFolderKind, projectName: string, folders: string[], items: SuggestItem[], lang: 'hu' | 'en'): string {
  const L: string[] = []
  L.push(`Answer language for folder names and "reason": ${lang === 'en' ? 'English' : 'Hungarian'}`)
  L.push(`Project: "${projectName.slice(0, 120)}". The items are ${KIND_WORD[kind]}.`)
  L.push('')
  L.push('EXISTING FOLDERS:')
  L.push(folders.length ? folders.map((f) => `- "${f}"`).join('\n') : '(none yet)')
  L.push('')
  L.push('ITEMS TO SORT:')
  for (const it of items) L.push(`- id ${it.id}: "${it.title.slice(0, 160)}"${it.hint ? ` -- ${it.hint.slice(0, 240)}` : ''}`)
  return L.join('\n')
}

/** A valasz ellenorzese: csak a kerdezett elemek; a mappanev tisztitva; a
 *  meglevo mappara (kis-nagybetu nelkul) a meglevo nevet irja vissza. */
export function parseSuggestAnswer(json: any, itemIds: Set<string>, folders: string[]): PlanRow[] | null {
  const items = json && Array.isArray(json.items) ? json.items : null
  if (!items) return null
  const existing = new Map(folders.map((f) => [vfolderKey(f), f]))
  const out: PlanRow[] = []
  const seen = new Set<string>()
  for (const it of items) {
    const id = typeof it?.id === 'string' ? it.id.trim() : ''
    if (!itemIds.has(id) || seen.has(id)) continue
    seen.add(id)
    const name = cleanVFolderName(it.folder)
    if (!name) continue
    const known = existing.get(vfolderKey(name))
    out.push({
      id,
      folder: known ?? name,
      isNew: !known,
      reason: typeof it.reason === 'string' ? it.reason.replace(/\s+/g, ' ').trim().slice(0, 120) : '',
    })
  }
  return out
}

export type SuggestOutcome =
  | { ok: true; plan: PlanRow[]; engine: string }
  | { ok: false; code: 'nothing_to_sort' | 'no_ai' | 'no_answer' }

/** Javaslat a MEG MAPPA NELKULI elemekre. Semmit nem ment. */
export async function suggestVFolders(projectId: string, projectName: string, kind: VFolderKind, rawItems: SuggestItem[], lang: 'hu' | 'en'): Promise<SuggestOutcome> {
  const state = listVFolders(projectId, kind)
  const known = new Set(state.folders.map((f) => f.id))
  const items = rawItems.filter((it) => !(state.items[it.id] && known.has(state.items[it.id]))).slice(0, SUGGEST_MAX_ITEMS)
  if (!items.length) return { ok: false, code: 'nothing_to_sort' }
  const names = state.folders.map((f) => f.name)
  const ids = new Set(items.map((i) => i.id))
  const ask = await askAiJson(SYSTEM, suggestPrompt(kind, projectName, names, items, lang), (j) => parseSuggestAnswer(j, ids, names))
  if (ask.engine === 'none' || !ask.value) return { ok: false, code: ask.reason === 'no_ai' ? 'no_ai' : 'no_answer' }
  return { ok: true, plan: ask.value, engine: `${ask.engine}:${ask.model}` }
}

/** A tulajdonos altal kipipalt sorok vegrehajtasa: a hianyzo mappak
 *  letrejonnek, az elemek atkerulnek. Egy tranzakcioban. */
export function applyVFolderPlan(projectId: string, kind: VFolderKind, rows: { id: string; folder: string }[]): { ok: true; moved: number; created: number } {
  ensureTables()
  const db = getDb()
  let moved = 0
  let created = 0
  db.transaction(() => {
    for (const r of rows) {
      const objectId = typeof r?.id === 'string' ? r.id.trim() : ''
      const name = cleanVFolderName(r?.folder)
      if (!objectId || !name) continue
      let folder = findByName(projectId, kind, name)
      if (!folder) {
        const made = createVFolder(projectId, kind, name)
        if (!made.ok) continue
        folder = made.folder
        created++
      }
      if (assignVFolder(projectId, kind, objectId, folder.id, 'ai').ok) moved++
    }
  })()
  return { ok: true, moved, created }
}

export function _resetVFolderTablesForTests(): void { tablesDb = null }
