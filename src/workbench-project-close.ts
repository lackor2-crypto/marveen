// BEFORE A PROJECT IS CLOSED, AND THE PROJECTS IT BELONGS WITH (#530, phase 5).
//
// The owner's specification, chapter 23: "Projekt lezarasakor a Marvin ellenorizze: van
// vegleges kimenet? el lett kuldve? minden szukseges melleklet kapcsolva van? nincs hianyzo
// dokumentum? vannak nyitott feladatok? [...] Ha problema van, a Marvin jelezze." -- it
// REPORTS, it does not forbid: the owner may close a project with an open point, knowingly.
// Chapter 49: a project can be linked to other projects; no document is copied for that.
//
// Every number here is measured. A source that could not be asked is reported as unknown
// (`n: null`), never as zero.

import { getDb } from './db.js'
import { getProject, listProjects } from './projects.js'
import { ensureWorkbenchTables, getWorkItem } from './workbench.js'
import { finalState } from './workbench-docfinal.js'
import { listSent } from './workbench-docsent.js'
import { hasDocModel } from './workbench-docmodel.js'
import { listProjectDocs } from './workbench-doc-links.js'

export type CloseKey = 'finals' | 'stale_finals' | 'unsent' | 'unfiled' | 'missing_docs' | 'open_cards' | 'open_items'
export interface CloseItem { key: CloseKey; ok: boolean; n: number | null; total?: number }

function hasTable(name: string): boolean {
  return !!getDb().prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)
}

/** What is still open in the project. `ready`: nothing is; closing is allowed either way. */
export function projectCloseCheck(projectId: string): { items: CloseItem[]; ready: boolean } {
  ensureWorkbenchTables()
  const db = getDb()
  const items: CloseItem[] = []
  const rows = db.prepare('SELECT id, status FROM work_items WHERE project_id = ? AND deleted_at IS NULL').all(projectId) as { id: string; status: string }[]
  const docs = rows.filter((r) => hasDocModel(r.id))
  let finals = 0
  let stale = 0
  let unsent = 0
  let unfiled = 0
  for (const d of docs) {
    const item = getWorkItem(d.id)
    if (!item) continue
    const fin = finalState(item)
    if (!fin) continue
    if (fin.stale) { stale++; continue }
    finals++
    const sent = listSent(d.id).filter((s) => s.version_id === fin.version_id)
    if (!sent.length) unsent++
    unfiled += sent.filter((s) => !s.filed_rel).length
  }
  // Only said when the project has documents at all: a video project has no "final submission".
  if (docs.length) {
    items.push({ key: 'finals', ok: finals + stale === docs.length && stale === 0, n: finals, total: docs.length })
    if (stale) items.push({ key: 'stale_finals', ok: false, n: stale })
    items.push({ key: 'unsent', ok: unsent === 0, n: unsent })
    items.push({ key: 'unfiled', ok: unfiled === 0, n: unfiled })
  }
  const pd = listProjectDocs(projectId)
  const missing = pd.docs.filter((d) => !d.exists).length + pd.attachments.filter((a) => !a.exists).length
  items.push({ key: 'missing_docs', ok: missing === 0, n: missing })
  let openCards: number | null = 0
  try {
    if (hasTable('kanban_cards')) openCards = (db.prepare("SELECT COUNT(*) AS n FROM kanban_cards WHERE project = ? AND archived_at IS NULL AND status != 'done'").get(projectId) as { n: number }).n
  } catch { openCards = null }
  items.push({ key: 'open_cards', ok: openCards === 0, n: openCards })
  const openItems = rows.filter((r) => r.status !== 'done').length
  items.push({ key: 'open_items', ok: openItems === 0, n: openItems, total: rows.length })
  return { items, ready: items.every((i) => i.ok) }
}

// ---------------------------------------------------------------------------
// Related projects
// ---------------------------------------------------------------------------

let tablesDb: unknown = null
export function ensureProjectRelationTables(): void {
  const db = getDb()
  if (tablesDb === db) return
  // One row per pair, the smaller id first: "A is related to B" and "B to A" are the same fact.
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_relations (
      a TEXT NOT NULL,
      b TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      created_by TEXT,
      PRIMARY KEY (a, b)
    )
  `)
  tablesDb = db
}

export interface RelatedProject { id: string; name: string; status: string; archived: boolean }
export type RelResult = { ok: true } | { ok: false; code: 'same_project' | 'not_found' | 'duplicate' | 'too_many'; detail: string }
export const RELATED_MAX = 50

const pair = (x: string, y: string): [string, string] => (x < y ? [x, y] : [y, x])

/** The projects linked to this one. A linked project that was deleted since is not listed. */
export function listRelatedProjects(projectId: string): RelatedProject[] {
  ensureProjectRelationTables()
  const rows = getDb().prepare('SELECT a, b FROM project_relations WHERE a = ? OR b = ? ORDER BY created_at').all(projectId, projectId) as { a: string; b: string }[]
  const out: RelatedProject[] = []
  for (const r of rows) {
    const p = getProject(r.a === projectId ? r.b : r.a)
    if (p) out.push({ id: p.id, name: p.name, status: p.status, archived: p.archived_at != null })
  }
  return out
}

/** The projects that could be linked: every other one that is not linked yet (archived ones too -- an old matter can be related). */
export function relatableProjects(projectId: string): Array<{ id: string; name: string }> {
  const have = new Set(listRelatedProjects(projectId).map((p) => p.id))
  return listProjects({ includeArchived: true }).filter((p) => p.id !== projectId && !have.has(p.id)).map((p) => ({ id: p.id, name: p.name }))
}

export function addRelatedProject(projectId: string, otherId: string, by: string | null): RelResult {
  ensureProjectRelationTables()
  const other = String(otherId || '').trim()
  if (!other || other === projectId) return { ok: false, code: 'same_project', detail: 'a project cannot be related to itself' }
  if (!getProject(other)) return { ok: false, code: 'not_found', detail: 'the other project was not found' }
  const [a, b] = pair(projectId, other)
  const db = getDb()
  if (db.prepare('SELECT 1 FROM project_relations WHERE a = ? AND b = ?').get(a, b)) return { ok: false, code: 'duplicate', detail: 'these two projects are already related' }
  if (listRelatedProjects(projectId).length >= RELATED_MAX) return { ok: false, code: 'too_many', detail: `a project has at most ${RELATED_MAX} related projects` }
  db.prepare('INSERT INTO project_relations (a, b, created_at, created_by) VALUES (?, ?, ?, ?)').run(a, b, Math.floor(Date.now() / 1000), by)
  return { ok: true }
}

/** The link goes; neither project, nor any document, is touched. */
export function removeRelatedProject(projectId: string, otherId: string): RelResult {
  ensureProjectRelationTables()
  const [a, b] = pair(projectId, String(otherId || '').trim())
  const r = getDb().prepare('DELETE FROM project_relations WHERE a = ? AND b = ?').run(a, b)
  return r.changes ? { ok: true } : { ok: false, code: 'not_found', detail: 'these two projects are not related' }
}
