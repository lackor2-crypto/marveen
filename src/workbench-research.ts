/**
 * A MUNKADARAB KUTATASAI (kanban #757; Boss TG 4390, "A" a TG 4394-re).
 *
 * A tulajdonos: a tudasanyag a projekt Kutatas fulere valo, a munkadarabba az
 * implementacios terv -- de a munkadarabban is lassa (Kutatas gomb), es az
 * asszisztens is hasznalja, ne menjen ki ujra a netre azert, amit egyszer mar
 * osszegyujtottunk.
 *
 * Egy kutatas (research/*.md, `<agens>/<fajlnev>`) a PROJEKTHEZ tartozik
 * (project-scope.ts), es emellett egy vagy tobb munkadarabhoz KOTHETO. A
 * munkadarabbol nezve harom csoport van:
 *   - item:   ehhez a munkadarabhoz kotott;
 *   - folder: ugyanabban a mappaban allo masik munkadarabhoz kotott;
 *   - others: a projekt tobbi kutatasa.
 * A projekt Kutatas fulen tovabbra is az osszes latszik; a kotes semmit nem
 * mozgat, nem masol.
 */
import { posix } from 'node:path'
import { readFileSync } from 'node:fs'
import { getDb } from './db.js'
import { listWorkItems, type WorkItemRow } from './workbench.js'
import { listResearchDocs, researchFilePath } from './web/routes/research.js'

/** Ennyi karaktert ad vissza egy olvasas; a tobbi `offset`-tel kerheto. */
export const RESEARCH_READ_MAX_CHARS = 30_000
/** Az asszisztens kontextusaba ennyi kotott kutatas cime kerul. */
export const RESEARCH_IN_CONTEXT = 15

export interface ItemResearchDoc {
  /** `<agent>/<name>` -- ugyanaz az azonosito, mint a projekt-kotesben. */
  id: string
  agent: string
  name: string
  title: string
  updated: string
  /** A munkadarabok (id), amelyekhez kotve van. */
  items: string[]
}

export interface ItemResearch {
  item: ItemResearchDoc[]
  folder: ItemResearchDoc[]
  others: ItemResearchDoc[]
}

let tablesDb: unknown = null

export function ensureResearchLinkTable(): void {
  const db = getDb()
  if (tablesDb === db) return
  db.exec(`
    CREATE TABLE IF NOT EXISTS workbench_research_links (
      work_item_id TEXT NOT NULL,
      research_id TEXT NOT NULL,
      created_by TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (work_item_id, research_id)
    )
  `)
  tablesDb = db
}

/** `agent/name` -> a ket resz; rossz alaknal null. A nev maga is tartalmazhat `/`-t (almappa). */
export function splitResearchId(id: string): { agent: string; name: string } | null {
  const i = id.indexOf('/')
  if (i <= 0 || i === id.length - 1) return null
  return { agent: id.slice(0, i), name: id.slice(i + 1) }
}

/** A munkadarab mappaja a projektben (ahol a fan all): a sajat mappajanak szuloje. */
export function itemContainer(item: Pick<WorkItemRow, 'folder' | 'container_folder'>): string | null {
  if (item.folder) {
    const d = posix.dirname(item.folder)
    return d && d !== '.' ? d : null
  }
  return item.container_folder || null
}

function linksFor(itemIds: string[]): Map<string, string[]> {
  ensureResearchLinkTable()
  const out = new Map<string, string[]>()
  if (!itemIds.length) return out
  const rows = getDb().prepare(
    `SELECT work_item_id, research_id FROM workbench_research_links
      WHERE work_item_id IN (${itemIds.map(() => '?').join(',')}) ORDER BY created_at`,
  ).all(...itemIds) as { work_item_id: string; research_id: string }[]
  for (const r of rows) {
    const list = out.get(r.research_id) || []
    list.push(r.work_item_id)
    out.set(r.research_id, list)
  }
  return out
}

/** A projekt kutatasai, a munkadarabbol nezve harom csoportban (lasd a fejlecet). */
export function researchForItem(projectId: string, item: WorkItemRow | null): ItemResearch {
  const docs = listResearchDocs(projectId).flatMap((a) => a.docs.map((d) => ({ ...d, agent: a.agent })))
    .sort((x, y) => (y.ms - x.ms) || x.name.localeCompare(y.name))
  const items = listWorkItems(projectId)
  const links = linksFor(items.map((i) => i.id))
  const box = item ? itemContainer(item) : null
  const siblings = new Set(box ? items.filter((i) => i.id !== item!.id && itemContainer(i) === box).map((i) => i.id) : [])
  const out: ItemResearch = { item: [], folder: [], others: [] }
  for (const d of docs) {
    const id = `${d.agent}/${d.name}`
    const on = links.get(id) || []
    const row: ItemResearchDoc = { id, agent: d.agent, name: d.name, title: d.title, updated: d.updated, items: on }
    if (item && on.includes(item.id)) out.item.push(row)
    else if (on.some((x) => siblings.has(x))) out.folder.push(row)
    else out.others.push(row)
  }
  return out
}

export type ResearchLinkCode = 'not_found' | 'other_project'

/** A kutatas a projekte-e (es letezik-e)? A kotes csak a projekt sajat kutatasara mehet. */
function projectHasResearch(projectId: string, id: string): boolean {
  return listResearchDocs(projectId).some((a) => a.docs.some((d) => `${a.agent}/${d.name}` === id))
}

export function linkResearch(item: WorkItemRow, id: string, by: string | null): { ok: true } | { ok: false; code: ResearchLinkCode } {
  const p = splitResearchId(id)
  if (!p || !researchFilePath(p.agent, p.name)) return { ok: false, code: 'not_found' }
  if (!projectHasResearch(item.project_id, id)) return { ok: false, code: 'other_project' }
  ensureResearchLinkTable()
  getDb().prepare(
    `INSERT OR IGNORE INTO workbench_research_links (work_item_id, research_id, created_by, created_at) VALUES (?, ?, ?, ?)`,
  ).run(item.id, id, by, Date.now())
  return { ok: true }
}

/** A kotes bontasa: a kutatas maga megmarad (a projekt Kutatas fulen). */
export function unlinkResearch(itemId: string, id: string): boolean {
  ensureResearchLinkTable()
  return getDb().prepare(`DELETE FROM workbench_research_links WHERE work_item_id = ? AND research_id = ?`).run(itemId, id).changes > 0
}

export interface ResearchText { id: string; title: string; text: string; total: number; offset: number; more: boolean }

/** Egy kutatas szovege (szeletben). Csak a projekt sajat kutatasa olvashato innen. */
export function readProjectResearch(projectId: string, id: string, offset = 0): { ok: true; doc: ResearchText } | { ok: false; code: ResearchLinkCode } {
  const p = splitResearchId(id)
  const file = p ? researchFilePath(p.agent, p.name) : null
  if (!p || !file) return { ok: false, code: 'not_found' }
  if (!projectHasResearch(projectId, id)) return { ok: false, code: 'other_project' }
  const content = readFileSync(file, 'utf-8')
  const m = content.match(/^#\s+(.+)$/m)
  const from = Math.max(0, Math.min(Math.floor(offset) || 0, content.length))
  const text = content.slice(from, from + RESEARCH_READ_MAX_CHARS)
  return { ok: true, doc: { id, title: m ? m[1].trim() : p.name, text, total: content.length, offset: from, more: from + text.length < content.length } }
}

/** Az asszisztens kontextus-blokkja: a kotott kutatasok cime, hogy tudjon roluk, mielott kimenne a netre. */
export function researchForContext(projectId: string, item: WorkItemRow | null): string {
  const r = researchForItem(projectId, item)
  const total = r.item.length + r.folder.length + r.others.length
  if (!total) return 'Research of this project (the Research page): none yet (the list was read and it is empty).'
  const line = (d: ItemResearchDoc) => `- ${d.id} "${d.title}" (${d.updated})`
  const out = [`Research of this project (the Research page): ${total} document(s). Read one with research.read BEFORE you search the web for the same topic; list them all with research.list.`]
  if (item) {
    out.push(r.item.length ? `Linked to THIS work item (${r.item.length}):` : 'Linked to THIS work item: none.')
    out.push(...r.item.slice(0, RESEARCH_IN_CONTEXT).map(line))
    if (r.folder.length) {
      out.push(`Linked to other work items in the same folder (${r.folder.length}):`)
      out.push(...r.folder.slice(0, RESEARCH_IN_CONTEXT).map(line))
    }
    if (r.others.length) out.push(`${r.others.length} more in the project (research.list shows them).`)
  } else {
    out.push(...[...r.item, ...r.folder, ...r.others].slice(0, RESEARCH_IN_CONTEXT).map(line))
    if (total > RESEARCH_IN_CONTEXT) out.push(`(+${total - RESEARCH_IN_CONTEXT} more, research.list shows them)`)
  }
  return out.join('\n')
}
