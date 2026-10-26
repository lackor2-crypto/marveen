// A work item's TO-DO FILE (Boss TG 3462): "Teendő - <item name>.md" ("To do - ..." on an English install), next to the
// item's context file ("Kontextus - <item name>.md"). The to-dos themselves live in the database (workbench-todos.ts:
// the owner and the agent's workItem.addTodo write them, with due dates and ticks); this file is the READABLE COPY of
// that list, rebuilt from it, so the list sits beside the document like the context file does:
//    - [ ] something still to do (due 2026-10-20)
//    - [x] something done
// Like the context file there is ONE per work item whatever the language (a language version uses its original's), it
// carries the item's NAME and follows a rename. Nothing is read back from the file: edits belong in the Workbench.

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { getDb } from './db.js'
import { logger } from './logger.js'
import { ol } from './owner-lang.js'
import type { ProjectRow } from './projects.js'
import type { WorkItemRow } from './workbench.js'
import { listItemTodos, type TodoRow } from './workbench-todos.js'
import { contextOwner, ensureItemContext } from './workbench-item-context.js'
import { isDebateReportTitle } from './debate-report-title.js'
import { followDepotFolderMove } from './workbench-assets.js'
import { safeFileName } from './project-files.js'
import { writeBlockReason } from './git-guard.js'
import { resolveLifePath } from './life-explorer.js'

export const TODO_PREFIX_HU = 'Teendő'
export const TODO_PREFIX_EN = 'To do'

function ensureTable(): void {
  getDb().exec('CREATE TABLE IF NOT EXISTS work_item_todo_file (item_id TEXT PRIMARY KEY, rel TEXT NOT NULL)')
}

/** "Teendő - <name>.md": the name of the to-do file for an item title. */
export function todoFileName(title: string): string {
  const prefix = ol(TODO_PREFIX_HU, TODO_PREFIX_EN)
  const clean = (safeFileName(title) || 'munkadarab').replace(/\.md$/i, '').slice(0, 150)
  return `${prefix} - ${clean}.md`
}

/** Both language prefixes count when an existing to-do file is recognised. */
export function isTodoFileName(name: string): boolean {
  return new RegExp(`^(?:${TODO_PREFIX_HU}|${TODO_PREFIX_EN}) - .+\\.md$`, 'i').test(name)
}

/** The file's text for a title and its to-dos (open ones first, then the done ones, each in the order they were added). */
export function todoFileText(title: string, todos: Pick<TodoRow, 'text' | 'due_date' | 'done_at'>[]): string {
  const line = (t: Pick<TodoRow, 'text' | 'due_date' | 'done_at'>): string =>
    `- [${t.done_at != null ? 'x' : ' '}] ${t.text.replace(/\s+/g, ' ').trim()}${t.due_date ? ` (${ol('határidő', 'due')} ${t.due_date})` : ''}`
  const open = todos.filter((t) => t.done_at == null)
  const done = todos.filter((t) => t.done_at != null)
  return [
    `# ${ol('Teendők', 'To do')}: ${title}`,
    '',
    ol(
      '> Ezt a fájlt a Munkapad építi a munkadarab teendő-listájából. Szerkeszteni a Munkapadon kell: a fájlba írt változtatás felülíródik.',
      '> The Workbench builds this file from the work item\'s to-do list. Edit the list in the Workbench: changes made to this file are overwritten.',
    ),
    '',
    ...(todos.length ? [...open, ...done].map(line) : [ol('(még nincs teendő)', '(no to-do yet)')]),
    '',
  ].join('\n')
}

/**
 * Makes sure the to-do file exists next to the context file, carries the item's current name and shows the current
 * list. Returns its depot-relative path, or null when the item has no usable folder.
 */
export function ensureItemTodoFile(item: WorkItemRow, project: ProjectRow): string | null {
  ensureTable()
  if (isDebateReportTitle(item.title)) return null // #656: a finished report gets no to-do file
  const owner = contextOwner(item)
  if (owner.id !== item.id) return ensureItemTodoFile(owner, project)
  const ctx = ensureItemContext(item, project)
  if (!ctx.rel) return null
  const folder = dirname(ctx.rel)
  const expected = todoFileName(item.title)
  const db = getDb()
  const row = db.prepare('SELECT rel FROM work_item_todo_file WHERE item_id = ?').get(item.id) as { rel: string } | undefined
  let rel: string | null = null
  if (row && row.rel) {
    const abs = resolveLifePath(row.rel)
    if (abs && existsSync(abs)) rel = row.rel
  }
  // #794 (Boss TG 3512): after a folder rename / move the old file sits in the new folder under its old name: follow it.
  if (!rel && row && row.rel) {
    const abs = resolveLifePath(`${folder}/${basename(row.rel)}`)
    if (abs && existsSync(abs)) rel = `${folder}/${basename(row.rel)}`
  }
  if (!rel) {
    const abs = resolveLifePath(`${folder}/${expected}`)
    if (abs && existsSync(abs)) rel = `${folder}/${expected}`
  }
  if (rel && basename(rel) !== expected) {
    const oldAbs = resolveLifePath(rel)
    const newAbs = oldAbs ? join(dirname(oldAbs), expected) : null
    if (oldAbs && newAbs && !existsSync(newAbs) && !writeBlockReason(`${dirname(rel)}/${expected}`)) {
      try {
        renameSync(oldAbs, newAbs)
        const newRel = `${dirname(rel)}/${expected}`
        followDepotFolderMove(rel, newRel)
        rel = newRel
      } catch (err: any) {
        logger.warn({ item: item.id, err: String(err?.message || err) }, '[item-todos] the to-do file could not follow the new item name')
      }
    }
  }
  const text = todoFileText(item.title, listItemTodos(item.id))
  if (!rel) {
    const relNew = `${folder}/${expected}`
    if (writeBlockReason(relNew)) return null
    const ctxAbs = resolveLifePath(ctx.rel)
    if (!ctxAbs) return null
    try {
      writeFileSync(join(dirname(ctxAbs), expected), text, { flag: 'wx' })
      rel = relNew
    } catch (err: any) {
      if (err?.code === 'EEXIST') rel = relNew
      else {
        logger.warn({ item: item.id, err: String(err?.message || err) }, '[item-todos] the to-do file could not be created')
        return null
      }
    }
  }
  const abs = resolveLifePath(rel)
  if (abs) {
    let cur: string | null = null
    try { cur = readFileSync(abs, 'utf8') } catch { cur = null }
    if (cur !== text && !writeBlockReason(rel)) {
      try { writeFileSync(abs, text) } catch { /* locked or read-only: the next pass tries again */ }
    }
  }
  db.prepare('INSERT INTO work_item_todo_file (item_id, rel) VALUES (?, ?) ON CONFLICT(item_id) DO UPDATE SET rel = excluded.rel').run(item.id, rel)
  return rel
}
