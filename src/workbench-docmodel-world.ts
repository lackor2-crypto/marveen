/**
 * A dokumentummodell "kulvilaga" (#441, 1/A): a projekt fajljai es a
 * tulajdonos chatuzenetei egy munkadarabnal. Kulon fajlban, hogy a modell
 * (workbench-docmodel.ts) a projekt- es chat-modulok nelkul is tesztelheto
 * legyen; a Munkapad utvonala es az agent ugyanezt hasznalja.
 */
import { realpathSync, statSync } from 'node:fs'
import { join, sep } from 'node:path'
import { getDb } from './db.js'
import type { ProjectRow } from './projects.js'
import { projectFileTarget } from './project-files.js'
import { ensureAgentTables } from './workbench-agent/sessions.js'
import type { SourceWorld } from './workbench-docmodel.js'
import { documentById } from './life-doc-ids.js'
import { resolveLifePath } from './life-explorer.js'

/** A path of this shape is not a file of the project folder: it names a document of the Life tree by its stable id (#530). */
export const LINKED_DOC_PREFIX = 'doc:'
export function isLinkedDocPath(raw: unknown): boolean { return typeof raw === 'string' && raw.startsWith(LINKED_DOC_PREFIX) }
export function linkedDocId(raw: string): string { return String(raw || '').slice(LINKED_DOC_PREFIX.length) }

/**
 * A LINKED document (#530): the file stays where it is in the Life tree, the
 * project only refers to it. Found through the document's id, so a rename or a
 * move in the tree does not lose it. `null` = the file is not where its record
 * says (moved outside Marveen, or the disk is not there) -- never "deleted".
 */
export function resolveLinkedDoc(raw: string): { abs: string; name: string; rel: string } | null {
  const doc = documentById(linkedDocId(raw))
  if (!doc) return null
  const abs = resolveLifePath(doc.rel)
  if (!abs) return null
  try { if (!statSync(abs).isFile()) return null } catch { return null }
  return { abs, name: doc.rel.slice(doc.rel.lastIndexOf('/') + 1), rel: doc.rel }
}

/**
 * Egy projekt-relativ fajlut -> abszolut ut, csak a projekt mappajan BELUL (jelkapcsolat sem vihet ki).
 * A `doc:<id>` alaku ut egy KAPCSOLT irat az Eletfabol (#530): az a sajat helyerol oldodik fel.
 */
export function resolveProjectFile(project: ProjectRow, raw: string): { abs: string; name: string } | null {
  if (isLinkedDocPath(raw)) { const d = resolveLinkedDoc(raw); return d ? { abs: d.abs, name: d.name } : null }
  const parts = String(raw || '').replace(/\\/g, '/').split('/').filter(Boolean)
  const name = parts.pop() || ''
  if (!name || name === '.' || name === '..') return null
  const target = projectFileTarget(project, parts.join('/'))
  if (!target.ok) return null
  const root = projectFileTarget(project, '')
  if (!root.ok) return null
  try {
    const real = realpathSync(join(target.dirAbs, name))
    const base = realpathSync(root.dirAbs)
    if (!real.startsWith(base + sep)) return null
    return { abs: real, name }
  } catch { return null }
}

/** A tulajdonos uzenetei a Munkapad chatjeben ennel a munkadarabnal (a legutobbi 500). */
export function ownerMessagesFor(itemId: string): { id: string; content: string; created_at: number }[] {
  ensureAgentTables()
  return getDb().prepare(`SELECT m.id, m.content, m.created_at FROM workbench_agent_messages m
    JOIN workbench_agent_sessions s ON s.id = m.session_id
    WHERE s.work_item_id = ? AND m.role = 'user' ORDER BY m.created_at DESC LIMIT 500`).all(itemId) as { id: string; content: string; created_at: number }[]
}

export function sourceWorldFor(project: ProjectRow, itemId: string): SourceWorld {
  return {
    resolveFile: (p) => resolveProjectFile(project, p),
    ownerMessages: () => ownerMessagesFor(itemId),
  }
}
