// Kanban #821 (owner, TG 3885): the assistant conversation belongs to the CASE (the folder the work items live in),
// not to one work item. Every work item of the same folder shows the same chat and the same history.
//
// How: nothing is moved or merged. Each document family keeps its own session (so a tool call, an approval or a
// code-bridge task still knows exactly which document it worked on). What changes is the READ side and the keys:
//   - the chat shown (and given to the model as history) is the UNION of the sessions of the case, in time order;
//   - the turn lock and the page's chat key are the key of the CASE, so one answer runs at a time in one chat.
// A work item that is moved to another folder takes its own messages with it; nothing is lost either way.
import { getDb } from './db.js'

/** Same value as PROJECT_ROOT_PLACE in workbench-assets.ts (not imported: that module imports workbench.ts). */
export const CHAT_CASE_PROJECT_ROOT = '@project'

export interface ChatCaseRow {
  id: string
  project_id: string
  folder?: string | null
  container_folder?: string | null
  created_at?: number | null
  deleted_at?: number | null
}

/** The folder a work item lives in: its own folder, else the folder it was put into. '' = no folder (project root). */
export function chatCasePlace(r: ChatCaseRow): string {
  const own = String(r.folder ?? '').trim()
  if (own) return own
  const c = String(r.container_folder ?? '').trim()
  return c && c !== CHAT_CASE_PROJECT_ROOT ? c : ''
}

/** language version -> its original. Empty when the table is not there yet (fresh install). */
function variantSources(): Map<string, string> {
  const m = new Map<string, string>()
  try {
    for (const r of getDb().prepare('SELECT work_item_id, source_item_id FROM wb_doc_variants').all() as { work_item_id: string; source_item_id: string }[]) {
      m.set(r.work_item_id, r.source_item_id)
    }
  } catch { /* no variants table yet */ }
  return m
}

/**
 * The chat key of every row: the id of the OLDEST document family of the folder. Rows of one folder (in one project)
 * get the same key; a row without a folder keeps the key of its own family. Pure: the rows and the variant map in.
 */
export function chatCaseKeys(rows: ChatCaseRow[], variants: Map<string, string>): Map<string, string> {
  const live = rows.filter((r) => r.deleted_at == null)
  const byId = new Map(live.map((r) => [r.id, r]))
  const family = (id: string): string => {
    const src = variants.get(id)
    return src && byId.has(src) ? src : id
  }
  const groupOf = (r: ChatCaseRow): string => {
    const root = byId.get(family(r.id)) ?? r
    const place = chatCasePlace(root)
    return place ? `${root.project_id}\u0000${place}` : ''
  }
  const first = new Map<string, ChatCaseRow>()
  for (const r of live) {
    if (family(r.id) !== r.id) continue // only an original can name the case
    const g = groupOf(r)
    if (!g) continue
    const cur = first.get(g)
    const older = !cur || (Number(r.created_at ?? 0) < Number(cur.created_at ?? 0))
      || (Number(r.created_at ?? 0) === Number(cur.created_at ?? 0) && r.id < cur.id)
    if (older) first.set(g, r)
  }
  const out = new Map<string, string>()
  for (const r of live) {
    const g = groupOf(r)
    out.set(r.id, (g && first.get(g)?.id) || family(r.id))
  }
  return out
}

function projectRows(projectId: string): ChatCaseRow[] {
  return getDb().prepare('SELECT id, project_id, folder, container_folder, created_at, deleted_at FROM work_items WHERE project_id = ? AND deleted_at IS NULL')
    .all(projectId) as ChatCaseRow[]
}

/** The chat key of one work item (see chatCaseKeys). An unknown id, a project key, or a failed read stays itself. */
export function chatCaseKey(workItemId: string): string {
  const id = String(workItemId || '')
  if (!id || id.startsWith('project:')) return id
  try {
    const row = getDb().prepare('SELECT project_id FROM work_items WHERE id = ?').get(id) as { project_id: string } | undefined
    if (!row) return variantSources().get(id) || id
    return chatCaseKeys(projectRows(row.project_id), variantSources()).get(id) || variantSources().get(id) || id
  } catch { return id }
}

/** The document families (ids of originals) that share the chat of this work item, itself included. */
export function chatCaseFamilies(workItemId: string): string[] {
  const id = String(workItemId || '')
  if (!id || id.startsWith('project:')) return [id]
  try {
    const row = getDb().prepare('SELECT project_id FROM work_items WHERE id = ?').get(id) as { project_id: string } | undefined
    const variants = variantSources()
    const self = variants.get(id) || id
    if (!row) return [self]
    const keys = chatCaseKeys(projectRows(row.project_id), variants)
    const mine = keys.get(id)
    if (!mine) return [self]
    const out = new Set<string>([self])
    for (const [other, k] of keys) if (k === mine) out.add(variants.get(other) && keys.has(variants.get(other)!) ? variants.get(other)! : other)
    return [...out]
  } catch { return [id] }
}

/** Adds `chat_key` to listed rows, so the page keys its chat exactly as the server does. */
export function withChatKeys<T extends ChatCaseRow>(rows: T[]): (T & { chat_key?: string })[] {
  if (!rows.length) return rows
  try {
    const keys = chatCaseKeys(rows, variantSources())
    return rows.map((r) => Object.assign(r, { chat_key: keys.get(r.id) || r.id }))
  } catch { return rows }
}
