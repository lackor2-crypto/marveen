/**
 * A dokumentummodell "kulvilaga" (#441, 1/A): a projekt fajljai es a
 * tulajdonos chatuzenetei egy munkadarabnal. Kulon fajlban, hogy a modell
 * (workbench-docmodel.ts) a projekt- es chat-modulok nelkul is tesztelheto
 * legyen; a Munkapad utvonala es az agent ugyanezt hasznalja.
 */
import { realpathSync } from 'node:fs'
import { join, sep } from 'node:path'
import { getDb } from './db.js'
import type { ProjectRow } from './projects.js'
import { projectFileTarget } from './project-files.js'
import { ensureAgentTables } from './workbench-agent/sessions.js'
import type { SourceWorld } from './workbench-docmodel.js'

/** Egy projekt-relativ fajlut -> abszolut ut, csak a projekt mappajan BELUL (jelkapcsolat sem vihet ki). */
export function resolveProjectFile(project: ProjectRow, raw: string): { abs: string; name: string } | null {
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
