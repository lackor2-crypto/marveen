// Per-item marks for the Workbench tree (#825, owner TG 4183/4189): "sent" (empty circle / green tick) and the
// nearest open deadline (calm / soon / today-or-overdue). One place computes them, the tree, the item header and the
// trigger-document row only draw what this says.
//
// "Urgent" is the same rule as the project card badge (#813): an open to-do that is overdue, due today, or due within
// 7 days. A sent item shows no deadline: sending it answered the trigger document.

import { getDb } from './db.js'
import { sentStatus } from './workbench-docsent.js'
import { ensureTodoTable } from './workbench-todos.js'
import { listWorkItems } from './workbench.js'
import { ensureDocLangTables } from './workbench-doclang.js'

export type DueLevel = 'overdue' | 'today' | 'soon' | 'later'
export interface ItemDue { date: string; days: number; level: DueLevel }
export interface ItemMark { /** one WORK in several languages counts as one: any language version sent = all of them sent (owner TG 4219) */ sent: boolean; /** sent AND some language version of the work is finalized: the hide switch treats the whole group as finished */ finished: boolean; /** YYYY-MM-DD the owner gave (or marked), when known */ sent_on: string | null; due: ItemDue | null }

export const SOON_DAYS = 7

export function dueLevel(days: number): DueLevel {
  if (days < 0) return 'overdue'
  if (days === 0) return 'today'
  return days <= SOON_DAYS ? 'soon' : 'later'
}

/** Whole days from `now`'s local calendar day to `date` (YYYY-MM-DD); negative = already past. NaN-safe: null on a bad date. */
export function daysUntil(date: string, now: Date = new Date()): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ''))
  if (!m) return null
  const due = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())
  return Math.round((due - today) / 86400000)
}

function sentDate(itemId: string): string | null {
  const db = getDb()
  const rec = db.prepare('SELECT sent_date FROM wb_doc_sent WHERE work_item_id = ? ORDER BY created_at DESC, id LIMIT 1').get(itemId) as { sent_date: string } | undefined
  if (rec && /^\d{4}-\d{2}-\d{2}/.test(rec.sent_date)) return rec.sent_date.slice(0, 10)
  const man = db.prepare('SELECT marked_at FROM wb_item_sent_mark WHERE work_item_id = ?').get(itemId) as { marked_at: number } | undefined
  if (man && man.marked_at > 0) { const d = new Date(man.marked_at * 1000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
  return null
}

export function itemMarks(projectId: string, now: Date = new Date()): Record<string, ItemMark> {
  ensureTodoTable()
  const items = listWorkItems(projectId)
  const nearest = new Map<string, string>()
  const rows = getDb().prepare(
    'SELECT work_item_id AS id, MIN(due_date) AS due FROM work_item_todos WHERE project_id = ? AND done_at IS NULL AND due_date IS NOT NULL GROUP BY work_item_id',
  ).all(projectId) as { id: string; due: string }[]
  for (const r of rows) nearest.set(r.id, r.due)
  // Language versions: the original and its live versions are ONE work (owner TG 4216/4219). Group key = the original's id.
  ensureDocLangTables()
  const live = new Set(items.map((w) => w.id))
  const groupOf = new Map<string, string>()
  for (const v of getDb().prepare('SELECT work_item_id, source_item_id FROM wb_doc_variants').all() as { work_item_id: string; source_item_id: string }[]) {
    if (live.has(v.work_item_id) && live.has(v.source_item_id)) groupOf.set(v.work_item_id, v.source_item_id)
  }
  const key = (id: string): string => groupOf.get(id) ?? id
  const ownSent = new Map<string, { sent: boolean; on: string | null }>()
  const groupSent = new Map<string, { id: string; on: string | null }>()
  const groupDone = new Set<string>()
  for (const w of items) {
    let sent = false
    try { sent = sentStatus(w.id).sent } catch { sent = false }
    const on = sent ? sentDate(w.id) : null
    ownSent.set(w.id, { sent, on })
    const k = key(w.id)
    if (sent && (!groupSent.has(k) || (on && !groupSent.get(k)!.on) || (on && groupSent.get(k)!.on && on > (groupSent.get(k)!.on as string)))) groupSent.set(k, { id: w.id, on })
    if (w.status === 'done') groupDone.add(k)
  }
  const out: Record<string, ItemMark> = {}
  for (const w of items) {
    const k = key(w.id)
    const g = groupSent.get(k)
    const sent = !!g
    const sentOn = g ? (ownSent.get(w.id)?.sent ? ownSent.get(w.id)!.on : g.on) : null
    let due: ItemDue | null = null
    const d = nearest.get(w.id)
    if (d && !sent) {
      const days = daysUntil(d, now)
      if (days != null) due = { date: d, days, level: dueLevel(days) }
    }
    out[w.id] = { sent, finished: sent && groupDone.has(k), sent_on: sentOn, due }
  }
  return out
}
