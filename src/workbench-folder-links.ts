// #809 (Boss TG 4506/4532, "Vitaztatas mappaban csak link legyen"): a work item can be LINKED into a folder it does not live in.
//
// A debate report is stored once, in the project's shared Debate folder (the main place for debates). The Debate folder of the
// work item the debate was started from holds only a link row that opens the same report. The link is not a copy and not a file:
// it is one row here, shown in the tree with a link mark; deleting the report (trash) hides every link to it, and removing the
// link never touches the report.

import { getDb } from './db.js'
import { getWorkItem } from './workbench.js'

let ensuredDb: unknown = null
function ensureTable(): void {
  const db = getDb()
  if (ensuredDb === db) return
  db.exec(`
    CREATE TABLE IF NOT EXISTS work_item_folder_links (
      item_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      folder TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (item_id, folder)
    );
    CREATE INDEX IF NOT EXISTS idx_wi_folder_links_project ON work_item_folder_links(project_id);
  `)
  ensuredDb = db
}

/** Links `itemId` into `folder` (a project-relative folder). Returns false when the item is missing or already lives there. */
export function addFolderLink(itemId: string, folder: string): boolean {
  const item = getWorkItem(itemId)
  const f = String(folder ?? '').trim().replace(/\/+$/, '')
  if (!item || !f) return false
  if ((item.folder ?? item.container_folder ?? '') === f) return false
  ensureTable()
  getDb().prepare('INSERT OR IGNORE INTO work_item_folder_links (item_id, project_id, folder, created_at) VALUES (?, ?, ?, ?)')
    .run(itemId, item.project_id, f, Date.now())
  return true
}

export function removeFolderLink(itemId: string, folder: string): boolean {
  ensureTable()
  return getDb().prepare('DELETE FROM work_item_folder_links WHERE item_id = ? AND folder = ?').run(itemId, String(folder ?? '').trim().replace(/\/+$/, '')).changes > 0
}

/** folder -> ids of the linked work items of the project (items in the trash are left out). */
export function listFolderLinks(projectId: string): Record<string, string[]> {
  ensureTable()
  const rows = getDb().prepare(
    `SELECT l.folder AS folder, l.item_id AS item_id FROM work_item_folder_links l
       JOIN work_items w ON w.id = l.item_id
      WHERE l.project_id = ? AND w.deleted_at IS NULL ORDER BY l.created_at`,
  ).all(projectId) as { folder: string; item_id: string }[]
  const out: Record<string, string[]> = {}
  for (const r of rows) (out[r.folder] ??= []).push(r.item_id)
  return out
}

/** The folders a work item is linked into. */
export function foldersLinkedTo(itemId: string): string[] {
  ensureTable()
  return (getDb().prepare('SELECT folder FROM work_item_folder_links WHERE item_id = ?').all(itemId) as { folder: string }[]).map((r) => r.folder)
}
