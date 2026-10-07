/**
 * Moving things between projects, merging a project into another, and deleting a
 * project WITH its contents (Boss TG 2547, 2549).
 *
 * Cards live in `kanban_cards.project`; ideas, debates, research, memories, schedules, skills and code
 * aliases are `project_links` rows. A project's Workbench items are real files in its folder: a merge carries
 * them (folders included) into the target project (#509, Boss TG 2914 A); a delete WITH contents still refuses
 * while live work items remain, and says why.
 */
import { getDb } from './db.js'
import { deleteKanbanCard, deleteIdea } from './db.js'
import { moveProjectWorkItems } from './workbench-assets.js'
import { ensureProjectTables, hasTable, getProject, linkObject, listProjectLinks, projectIdeaIds, projectCardIds, isLinkType } from './projects.js'

export const MOVABLE_TYPES = ['card', 'idea', 'debate', 'research', 'memory', 'schedule', 'skill'] as const
export type MovableType = typeof MOVABLE_TYPES[number]
export interface MoveItem { type: MovableType; id: string }

export type MoveResult =
  | { ok: true; moved: number; skipped: number }
  | { ok: false; code: 'same_project' | 'target_missing' | 'source_missing' | 'target_archived' | 'bad_items' }

const isMovable = (v: unknown): v is MovableType => typeof v === 'string' && (MOVABLE_TYPES as readonly string[]).includes(v)

export function parseMoveItems(raw: unknown): MoveItem[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 2000) return null
  const out: MoveItem[] = []
  for (const r of raw) {
    const o = r as { type?: unknown; id?: unknown }
    const id = String(o?.id ?? '').trim()
    if (!isMovable(o?.type) || !id) return null
    out.push({ type: o.type, id })
  }
  return out
}

/** Move the listed items from one project to another. Cards change `project`; everything else is re-linked. */
export function moveItemsBetweenProjects(
  sourceId: string,
  targetId: string,
  items: MoveItem[],
  /** The project a research file / debate belongs to WITHOUT an explicit link (file header mark, debate log). */
  derivedOwner?: (type: MovableType, id: string) => string | null,
): MoveResult {
  ensureProjectTables()
  if (sourceId === targetId) return { ok: false, code: 'same_project' }
  if (!getProject(sourceId)) return { ok: false, code: 'source_missing' }
  const target = getProject(targetId)
  if (!target) return { ok: false, code: 'target_missing' }
  if (target.archived_at) return { ok: false, code: 'target_archived' }
  const db = getDb()
  let moved = 0, skipped = 0
  db.transaction(() => {
    const cardIds = new Set(projectCardIds(sourceId, { includeArchived: true }))
    const ideaIds = new Set(projectIdeaIds(sourceId))
    for (const it of items) {
      if (it.type === 'card') {
        if (!cardIds.has(it.id)) { skipped++; continue }
        db.prepare('UPDATE kanban_cards SET project = ? WHERE id = ? AND project = ?').run(targetId, it.id, sourceId)
        moved++
      } else {
        // An idea may belong to the project only through its card (derived link): the explicit link wins.
        // Research and debates may belong through their file mark / log instead of a link: the new explicit link wins over it.
        const owned = it.type === 'idea' ? ideaIds.has(it.id)
          : listProjectLinks(sourceId, it.type).some((l) => l.object_id === it.id)
            || ((it.type === 'research' || it.type === 'debate') && derivedOwner?.(it.type, it.id) === sourceId)
        if (!owned || !isLinkType(it.type)) { skipped++; continue }
        linkObject(targetId, it.type, it.id, 'dashboard-move')
        moved++
      }
    }
  })()
  return { ok: true, moved, skipped }
}

export interface ProjectContents {
  cards: number
  ideas: number
  links: Record<string, number>
  workItems: number
}

export function projectContents(id: string): ProjectContents {
  ensureProjectTables()
  const db = getDb()
  const links: Record<string, number> = {}
  for (const l of listProjectLinks(id)) links[l.object_type] = (links[l.object_type] ?? 0) + 1
  const workItems = hasTable('work_items')
    ? (db.prepare('SELECT COUNT(*) n FROM work_items WHERE project_id = ? AND deleted_at IS NULL').get(id) as { n: number }).n
    : 0
  return { cards: projectCardIds(id, { includeArchived: true }).length, ideas: projectIdeaIds(id).length, links, workItems }
}

export type EmptyingResult =
  | { ok: true; cards: number; ideas: number; links: number; workItems?: number }
  | { ok: false; code: 'source_missing' | 'target_missing' | 'target_archived' | 'same_project' | 'has_work_items' | 'work_items_move_failed'; workItems?: number; moved?: number; message?: string }

/**
 * Merge: the Workbench items move first (their folders go into the target's work items box, every path
 * follows), then every card and link goes to the target, and the (now empty) source project is deleted.
 * If an item cannot be moved, nothing else changes and the source project stays (a retry continues).
 */
export function mergeProjectInto(sourceId: string, targetId: string): EmptyingResult {
  ensureProjectTables()
  if (sourceId === targetId) return { ok: false, code: 'same_project' }
  if (!getProject(sourceId)) return { ok: false, code: 'source_missing' }
  const target = getProject(targetId)
  if (!target) return { ok: false, code: 'target_missing' }
  if (target.archived_at) return { ok: false, code: 'target_archived' }
  const c = projectContents(sourceId)
  let workItems = 0
  if (hasTable('work_items') && (getDb().prepare('SELECT 1 FROM work_items WHERE project_id = ? LIMIT 1').get(sourceId))) {
    const wm = moveProjectWorkItems(getProject(sourceId)!, target)
    if (!wm.ok) return { ok: false, code: 'work_items_move_failed', workItems: c.workItems, moved: wm.moved, ...(wm.message ? { message: wm.message } : {}) }
    workItems = wm.moved
  }
  const db = getDb()
  let cards = 0, links = 0
  db.transaction(() => {
    if (hasTable('work_folder_ids')) db.prepare('DELETE FROM work_folder_ids WHERE project_id = ?').run(sourceId)
    // Ideas that belong only through their card travel with the card; explicit links are re-pointed here.
    if (hasTable('kanban_cards')) cards = db.prepare('UPDATE kanban_cards SET project = ? WHERE project = ?').run(targetId, sourceId).changes
    links = db.prepare('UPDATE project_links SET project_id = ? WHERE project_id = ?').run(targetId, sourceId).changes
    db.prepare('DELETE FROM projects WHERE id = ?').run(sourceId)
  })()
  return { ok: true, cards, ideas: c.ideas, links, workItems }
}

/** Delete the project AND what is in it: its cards and ideas are removed, other links are cut (the objects stay). */
export function deleteProjectWithContents(id: string): EmptyingResult {
  ensureProjectTables()
  if (!getProject(id)) return { ok: false, code: 'source_missing' }
  const c = projectContents(id)
  if (c.workItems > 0) return { ok: false, code: 'has_work_items', workItems: c.workItems }
  const db = getDb()
  const cardIds = projectCardIds(id, { includeArchived: true })
  const ideaIds = projectIdeaIds(id)
  let links = 0
  for (const cid of cardIds) deleteKanbanCard(cid)
  for (const iid of ideaIds) deleteIdea(iid)
  db.transaction(() => {
    links = db.prepare('DELETE FROM project_links WHERE project_id = ?').run(id).changes
    db.prepare('DELETE FROM projects WHERE id = ?').run(id)
  })()
  return { ok: true, cards: cardIds.length, ideas: ideaIds.length, links }
}
