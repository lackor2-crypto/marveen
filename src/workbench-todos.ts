/**
 * KIS TEENDOK HATARIDOVEL (kanban #406, 14. pont).
 *
 * "Apro feladatok egy munkadarabon belul, peldaul: szoveget atnezni pentekig,
 * amelyek a naptarban is megjelennek." -- nem kanban-kartya (az egy egesz
 * projekt), hanem egy munkadarabhoz tartozo pipalhato sor, opcionalis
 * hataridovel.
 *
 * Naptar: minden teendo (es a projekt osszes nyitott, hataridos teendoje
 * egyben) letoltheto szabvanyos naptarfajlkent (.ics, RFC 5545). Ezt barmely
 * naptar (Google, Outlook, Apple, telefon) egy kattintassal felveszi. Semmi nem
 * megy ki a geprol magatol, es nem kell hozza Google-fiok -- tehat friss
 * telepitesen is mukodik.
 *
 * A hatarido NAP (YYYY-MM-DD), nem idopont: "pentekig" egy nap, es igy a
 * nyari/teli idoatallas sem csusztatja el.
 */
import { randomUUID } from 'node:crypto'
import { getDb } from './db.js'
import { getWorkItem, ensureWorkbenchTables } from './workbench.js'

export const TODO_TEXT_MAX = 300
/** Egy munkadarabon ennyi teendo lehet -- ennel tobb mar nem "kis teendo". */
export const TODOS_PER_ITEM_MAX = 100

export interface TodoRow {
  id: string
  work_item_id: string
  project_id: string
  text: string
  /** YYYY-MM-DD vagy null (nincs hatarido). */
  due_date: string | null
  done_at: number | null
  created_by: string | null
  source: 'owner' | 'agent'
  created_at: number
  updated_at: number
}

/** A projekt-listaban a munkadarab cime is kell (arra kattintva nyilik meg). */
export interface ProjectTodoRow extends TodoRow {
  item_title: string
}

export type TodoCode = 'text_required' | 'text_too_long' | 'bad_due_date' | 'too_many' | 'not_found' | 'item_not_found'

export type TodoResult = { ok: true; todo: TodoRow } | { ok: false; code: TodoCode }

let tablesDb: unknown = null

export function ensureTodoTable(): void {
  const db = getDb()
  if (tablesDb === db) return
  db.exec(`
    CREATE TABLE IF NOT EXISTS work_item_todos (
      id TEXT PRIMARY KEY,
      work_item_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      text TEXT NOT NULL,
      due_date TEXT,
      done_at INTEGER,
      created_by TEXT,
      source TEXT NOT NULL DEFAULT 'owner',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_work_item_todos_item ON work_item_todos(work_item_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_work_item_todos_project ON work_item_todos(project_id, due_date);
  `)
  tablesDb = db
}

const now = (): number => Math.floor(Date.now() / 1000)

function cleanText(v: unknown): { ok: true; text: string } | { ok: false; code: TodoCode } {
  const text = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : ''
  if (!text) return { ok: false, code: 'text_required' }
  if (text.length > TODO_TEXT_MAX) return { ok: false, code: 'text_too_long' }
  return { ok: true, text }
}

/**
 * Hatarido: ures -> nincs; kulonben VALODI naptari nap YYYY-MM-DD alakban
 * (a 2026-02-30 nem az). `undefined` = "nem valtozik" (PATCH).
 */
export function cleanDueDate(v: unknown): { ok: true; due: string | null } | { ok: false } {
  if (v === null || v === undefined || v === '') return { ok: true, due: null }
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v.trim())) return { ok: false }
  const s = v.trim()
  const [y, m, d] = s.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return { ok: false }
  if (y < 2000 || y > 2200) return { ok: false }
  return { ok: true, due: s }
}

export function getTodo(id: string): TodoRow | undefined {
  ensureTodoTable()
  return getDb().prepare('SELECT * FROM work_item_todos WHERE id = ?').get(id) as TodoRow | undefined
}

/** Egy munkadarab teendoi: elol a nyitottak hatarido szerint (a hatarido nelkuliek utanuk), aztan a keszek. */
export function listItemTodos(itemId: string): TodoRow[] {
  ensureTodoTable()
  return getDb().prepare(`SELECT * FROM work_item_todos WHERE work_item_id = ?
    ORDER BY (done_at IS NOT NULL), (due_date IS NULL), due_date, created_at, rowid`).all(itemId) as TodoRow[]
}

/** A projekt osszes teendoje a munkadarab cimevel. A torolt munkadarab teendoi nem latszanak. */
export function listProjectTodos(projectId: string): ProjectTodoRow[] {
  ensureTodoTable()
  ensureWorkbenchTables()
  return getDb().prepare(`SELECT t.*, w.title AS item_title FROM work_item_todos t
    JOIN work_items w ON w.id = t.work_item_id
    WHERE t.project_id = ?
    ORDER BY (t.done_at IS NOT NULL), (t.due_date IS NULL), t.due_date, t.created_at, t.rowid`).all(projectId) as ProjectTodoRow[]
}

export function addTodo(input: {
  work_item_id: string
  text: unknown
  due_date?: unknown
  by?: string | null
  source?: 'owner' | 'agent'
}): TodoResult {
  const c = cleanText(input.text)
  if (!c.ok) return c
  const d = cleanDueDate(input.due_date)
  if (!d.ok) return { ok: false, code: 'bad_due_date' }
  const item = getWorkItem(input.work_item_id)
  if (!item) return { ok: false, code: 'item_not_found' }
  ensureTodoTable()
  const n = (getDb().prepare('SELECT COUNT(*) AS n FROM work_item_todos WHERE work_item_id = ?').get(item.id) as { n: number }).n
  if (n >= TODOS_PER_ITEM_MAX) return { ok: false, code: 'too_many' }
  const t = now()
  const row: TodoRow = {
    id: randomUUID(),
    work_item_id: item.id,
    project_id: item.project_id,
    text: c.text,
    due_date: d.due,
    done_at: null,
    created_by: input.by ?? null,
    source: input.source === 'agent' ? 'agent' : 'owner',
    created_at: t,
    updated_at: t,
  }
  getDb().prepare(`INSERT INTO work_item_todos
    (id, work_item_id, project_id, text, due_date, done_at, created_by, source, created_at, updated_at)
    VALUES (@id, @work_item_id, @project_id, @text, @due_date, @done_at, @created_by, @source, @created_at, @updated_at)`).run(row)
  return { ok: true, todo: row }
}

/** Szoveg, hatarido vagy kesz-allapot valtoztatasa; a meg nem adott mezo marad. */
export function updateTodo(id: string, patch: { text?: unknown; due_date?: unknown; done?: unknown }): TodoResult {
  const cur = getTodo(id)
  if (!cur) return { ok: false, code: 'not_found' }
  const next = { ...cur }
  if (patch.text !== undefined) {
    const c = cleanText(patch.text)
    if (!c.ok) return c
    next.text = c.text
  }
  if (patch.due_date !== undefined) {
    const d = cleanDueDate(patch.due_date)
    if (!d.ok) return { ok: false, code: 'bad_due_date' }
    next.due_date = d.due
  }
  if (patch.done !== undefined) next.done_at = patch.done ? (cur.done_at ?? now()) : null
  next.updated_at = now()
  getDb().prepare('UPDATE work_item_todos SET text = ?, due_date = ?, done_at = ?, updated_at = ? WHERE id = ?')
    .run(next.text, next.due_date, next.done_at, next.updated_at, id)
  return { ok: true, todo: next }
}

export function deleteTodo(id: string): boolean {
  ensureTodoTable()
  return getDb().prepare('DELETE FROM work_item_todos WHERE id = ?').run(id).changes > 0
}

// -- naptarfajl (RFC 5545) -----------------------------------------------------

function icsEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n')
}

/** 75 oktettnel hosszabb sort a szabvany szerint tordelunk (UTF-8 karaktert nem vagunk ketté). */
function fold(line: string): string {
  const out: string[] = []
  let cur = ''
  let bytes = 0
  for (const ch of line) {
    const b = Buffer.byteLength(ch)
    const limit = out.length ? 74 : 75
    if (bytes + b > limit) { out.push(cur); cur = ''; bytes = 0 }
    cur += ch
    bytes += b
  }
  out.push(cur)
  return out.join('\r\n ')
}

function icsStamp(sec: number): string {
  return new Date(sec * 1000).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
}

function nextDay(due: string): string {
  const [y, m, d] = due.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10)
}

/**
 * Naptarfajl a megadott (hataridos) teendokbol: egesz napos esemenyek, a
 * hatarido napjan reggel 9-kor emlekeztetovel. A hatarido nelkuli teendo nem
 * kerul bele (nincs mikor megjelennie).
 */
export function todosToIcs(
  todos: { id: string; text: string; due_date: string | null; item_title: string }[],
  projectName: string,
  lang: 'hu' | 'en',
  stampSec = now(),
): string {
  const L = (hu: string, en: string): string => (lang === 'en' ? en : hu)
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Marveen//Workbench//' + lang.toUpperCase(),
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
  ]
  for (const td of todos) {
    if (!td.due_date) continue
    lines.push(
      'BEGIN:VEVENT',
      'UID:' + td.id + '@marveen-workbench',
      'DTSTAMP:' + icsStamp(stampSec),
      'DTSTART;VALUE=DATE:' + td.due_date.replace(/-/g, ''),
      'DTEND;VALUE=DATE:' + nextDay(td.due_date).replace(/-/g, ''),
      'SUMMARY:' + icsEscape(td.text),
      'DESCRIPTION:' + icsEscape(L('Projekt: ', 'Project: ') + projectName + '\n' + L('Munkadarab: ', 'Work item: ') + td.item_title),
      'TRANSP:TRANSPARENT',
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      'DESCRIPTION:' + icsEscape(td.text),
      'TRIGGER:PT9H',
      'END:VALARM',
      'END:VEVENT',
    )
  }
  lines.push('END:VCALENDAR')
  return lines.map(fold).join('\r\n') + '\r\n'
}

const WEEKDAYS: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
  vasarnap: 0, hetfo: 1, kedd: 2, szerda: 3, csutortok: 4, pentek: 5, szombat: 6,
}

function localDay(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * Az agens hataridoje: pontos nap (YYYY-MM-DD), a het egy napja ("friday",
 * "pentek" -- a legkozelebbi ilyen nap, a mai is), vagy "hany nap mulva".
 * Az agens nem tudja a mai datumot, ezert ezt a szerver szamolja ki.
 */
export function resolveAgentDue(input: { due?: unknown; dueWeekday?: unknown; dueInDays?: unknown }, now = new Date()): { ok: true; due: string | null } | { ok: false } {
  if (input.due !== undefined && input.due !== null && input.due !== '') return cleanDueDate(input.due)
  if (typeof input.dueWeekday === 'string' && input.dueWeekday.trim()) {
    const key = input.dueWeekday.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    const wd = WEEKDAYS[key]
    if (wd === undefined) return { ok: false }
    const add = (wd - now.getDay() + 7) % 7
    return { ok: true, due: localDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() + add)) }
  }
  if (input.dueInDays !== undefined && input.dueInDays !== null && input.dueInDays !== '') {
    const n = Number(input.dueInDays)
    if (!Number.isInteger(n) || n < 0 || n > 3650) return { ok: false }
    return { ok: true, due: localDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() + n)) }
  }
  return { ok: true, due: null }
}
