// "ELKULDVE" IS NOT "VEGLEGES", AND THE SENT COPY BELONGS IN THE ARCHIVE (#530, phase 3).
//
// The owner's specification, chapters 24-26: "A Veglegesites muvelet nem azonos az
// Elkuldve allapottal. Vegleges: a dokumentum tartalmilag elkeszult. Elkuldve: a
// dokumentum tenylegesen eljutott a cimzetthez." And: once it was sent, the official
// copy is placed in the authority's folder of the Life tree (".../Jobcenter/Kimeno"),
// and the project keeps pointing at it.
//
// So a FINAL version can be marked as sent -- when, to whom, how, with what
// reference -- any number of times (the same submission may go to two authorities).
// And each sending can have its official copy FILED: the final PDF is copied into a
// Life-tree folder the owner picks, under a free name (nothing is ever overwritten),
// gets a stable document id, and shows in the project as an "official" document.
//
// What this deliberately does NOT do:
//   - it does not send anything. It records what the owner says happened;
//   - it does not mark a draft or a stale final as sent: only the current final;
//   - it does not move the annexes: those stay where they have always been (chapter 27).

import { randomUUID } from 'node:crypto'
import { constants, statSync } from 'node:fs'
import { copyFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { getDb } from './db.js'
import { clearContentCache, resolveLifePath } from './life-explorer.js'
import { writeBlockReason } from './git-guard.js'
import { ensureDocumentId, hashDocument, documentById } from './life-doc-ids.js'
import { freeFileName } from './project-files.js'
import { logger } from './logger.js'
import { fileStem, finalState, listFinals, resolverFor } from './workbench-docfinal.js'
import { ensureProjectDocTables } from './workbench-doc-links.js'
import type { WorkItemRow } from './workbench.js'

export const SENT_METHODS = ['email', 'post', 'registered_post', 'in_person', 'portal', 'fax', 'other'] as const
export type SentMethod = typeof SENT_METHODS[number]
export const isSentMethod = (v: unknown): v is SentMethod => typeof v === 'string' && (SENT_METHODS as readonly string[]).includes(v)
export const SENT_TEXT_MAX = 300
export const SENT_MAX_PER_ITEM = 100

let tablesDb: unknown = null
export function ensureDocSentTables(): void {
  const db = getDb()
  if (tablesDb === db) return
  db.exec(`
    CREATE TABLE IF NOT EXISTS wb_doc_sent (
      id TEXT PRIMARY KEY,
      work_item_id TEXT NOT NULL,
      version_id TEXT NOT NULL,
      sent_date TEXT NOT NULL,
      sent_time TEXT NOT NULL DEFAULT '',
      recipient TEXT NOT NULL,
      method TEXT NOT NULL,
      reference TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      filed_doc_id TEXT,
      filed_rel TEXT,
      created_at INTEGER NOT NULL,
      created_by TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_wb_doc_sent_item ON wb_doc_sent(work_item_id, created_at);
  `)
  tablesDb = db
}

interface SentRow {
  id: string; work_item_id: string; version_id: string; sent_date: string; sent_time: string; recipient: string
  method: string; reference: string; note: string; filed_doc_id: string | null; filed_rel: string | null; created_at: number; created_by: string | null
}

export interface SentView {
  id: string
  version_id: string
  /** The label of the final it was sent as ("Végleges – 2026-10-08"); '' when that version is gone. */
  final_label: string
  sent_date: string
  sent_time: string
  recipient: string
  method: SentMethod
  reference: string
  note: string
  /** Where the official copy is filed in the Life tree; null = not filed (yet). */
  filed_rel: string | null
  /** false = filed, but the file is not at its place now. null when not filed. */
  filed_exists: boolean | null
  created_at: number
  created_by: string | null
}

export type SentCode = 'no_final' | 'final_stale' | 'bad_input' | 'too_many' | 'not_found' | 'already_filed' | 'folder_missing' | 'git_repo' | 'final_file_missing' | 'copy_failed'
export type SentResult<T> = ({ ok: true } & T) | { ok: false; code: SentCode; detail: string }

const clean = (v: unknown): string => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
const norm = (rel: string): string => String(rel || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')

function validDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!m) return false
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3])
}

function filedNow(r: SentRow): { rel: string | null; exists: boolean | null } {
  if (!r.filed_doc_id) return { rel: null, exists: null }
  const doc = documentById(r.filed_doc_id)
  const rel = doc ? doc.rel : r.filed_rel
  if (!rel) return { rel: null, exists: null }
  const abs = resolveLifePath(rel)
  if (!abs) return { rel, exists: false }
  // Looked at with the cheap, synchronous call the annex list uses too: one stat per sending.
  try { return { rel, exists: statSync(abs).isFile() } } catch { return { rel, exists: false } }
}

/** The sendings of a document, the newest first. */
export function listSent(itemId: string): SentView[] {
  ensureDocSentTables()
  const labels = new Map(listFinals(itemId).map((f) => [f.version_id, f.label]))
  const rows = getDb().prepare('SELECT * FROM wb_doc_sent WHERE work_item_id = ? ORDER BY created_at DESC, id').all(itemId) as SentRow[]
  return rows.map((r) => {
    const f = filedNow(r)
    return {
      id: r.id, version_id: r.version_id, final_label: labels.get(r.version_id) || '',
      sent_date: r.sent_date, sent_time: r.sent_time, recipient: r.recipient,
      method: (isSentMethod(r.method) ? r.method : 'other') as SentMethod, reference: r.reference, note: r.note,
      filed_rel: f.rel, filed_exists: f.exists, created_at: r.created_at, created_by: r.created_by,
    }
  })
}

/** Mark the CURRENT final as sent. A draft, or a final the document has changed since, cannot be. */
export function recordSent(item: WorkItemRow, input: { date?: unknown; time?: unknown; recipient?: unknown; method?: unknown; reference?: unknown; note?: unknown }, by: string | null): SentResult<{ id: string }> {
  ensureDocSentTables()
  const fin = finalState(item)
  if (!fin) return { ok: false, code: 'no_final', detail: 'the document has no final version yet' }
  if (fin.stale) return { ok: false, code: 'final_stale', detail: 'the document changed since it was finalised' }
  const date = clean(input.date)
  if (!validDate(date)) return { ok: false, code: 'bad_input', detail: 'date must be a real day as YYYY-MM-DD' }
  const time = clean(input.time)
  if (time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return { ok: false, code: 'bad_input', detail: 'time must be HH:MM' }
  const recipient = clean(input.recipient)
  if (!recipient) return { ok: false, code: 'bad_input', detail: 'recipient is required' }
  const method = input.method === undefined || input.method === null || input.method === '' ? 'other' : input.method
  if (!isSentMethod(method)) return { ok: false, code: 'bad_input', detail: `method must be one of ${SENT_METHODS.join(', ')}` }
  const reference = clean(input.reference)
  const note = clean(input.note)
  if (recipient.length > SENT_TEXT_MAX || reference.length > SENT_TEXT_MAX || note.length > SENT_TEXT_MAX) return { ok: false, code: 'bad_input', detail: `each text is at most ${SENT_TEXT_MAX} characters` }
  const db = getDb()
  const n = (db.prepare('SELECT COUNT(*) AS n FROM wb_doc_sent WHERE work_item_id = ?').get(item.id) as { n: number }).n
  if (n >= SENT_MAX_PER_ITEM) return { ok: false, code: 'too_many', detail: `a document has at most ${SENT_MAX_PER_ITEM} sendings` }
  const id = randomUUID().slice(0, 12)
  db.prepare('INSERT INTO wb_doc_sent (id, work_item_id, version_id, sent_date, sent_time, recipient, method, reference, note, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, item.id, fin.version_id, date, time, recipient, method, reference, note, Math.floor(Date.now() / 1000), by)
  return { ok: true, id }
}

/** A sending recorded by mistake is taken back. The filed copy, if there is one, is NOT touched. */
export function removeSent(itemId: string, id: string): SentResult<object> {
  ensureDocSentTables()
  const r = getDb().prepare('DELETE FROM wb_doc_sent WHERE id = ? AND work_item_id = ?').run(String(id || ''), itemId)
  return r.changes ? { ok: true } : { ok: false, code: 'not_found', detail: 'no such sending for this document' }
}

/**
 * File the official copy of a sending: the final PDF (the submission itself, or the merged
 * bundle) is COPIED into the Life-tree folder the owner picked, under a free name, and the
 * project gets an "official" document pointing at it. One filed copy per sending.
 */
export async function fileOfficialCopy(item: WorkItemRow, sentId: string, folderRel: string, by: string | null): Promise<SentResult<{ rel: string }>> {
  ensureDocSentTables()
  const db = getDb()
  const row = db.prepare('SELECT * FROM wb_doc_sent WHERE id = ? AND work_item_id = ?').get(String(sentId || ''), item.id) as SentRow | undefined
  if (!row) return { ok: false, code: 'not_found', detail: 'no such sending for this document' }
  if (row.filed_doc_id) return { ok: false, code: 'already_filed', detail: row.filed_rel || '' }
  const fin = listFinals(item.id).find((f) => f.version_id === row.version_id)
  if (!fin) return { ok: false, code: 'final_file_missing', detail: 'the final version this was sent as is gone' }
  const main = (fin.files || []).find((x) => x.role === 'main' || x.role === 'bundle') || { path: fin.pdf_path, name: fin.pdf_name }
  const resolve = resolverFor(item)
  const src = resolve ? resolve(main.path) : null
  if (!src) return { ok: false, code: 'final_file_missing', detail: main.path }
  const folder = norm(folderRel)
  if (!folder || folder.split('/').includes('..')) return { ok: false, code: 'bad_input', detail: 'folder (a folder of the Life tree) is required' }
  const blocked = writeBlockReason(folder)
  if (blocked) return { ok: false, code: 'git_repo', detail: blocked }
  const dirAbs = resolveLifePath(folder)
  if (!dirAbs) return { ok: false, code: 'folder_missing', detail: 'this place is not inside the Life tree' }
  try { if (!(await stat(dirAbs)).isDirectory()) return { ok: false, code: 'folder_missing', detail: 'this is not a folder' } } catch { return { ok: false, code: 'folder_missing', detail: 'there is no such folder' } }
  // "<title> – <date sent>.pdf": the archive is read by a person, years later.
  const name = freeFileName(dirAbs, `${fileStem(item.title)} – ${row.sent_date}.pdf`)
  try {
    // COPYFILE_EXCL: if the name got taken between the check and the copy, fail instead of overwriting.
    await copyFile(src.abs, join(dirAbs, name), constants.COPYFILE_EXCL)
  } catch (err: any) {
    return { ok: false, code: 'copy_failed', detail: String(err?.code || err?.message || err) }
  }
  clearContentCache()
  const rel = `${folder}/${name}`
  const docId = await ensureDocumentId(rel)
  if (!docId) return { ok: false, code: 'copy_failed', detail: 'the copy was written but could not be registered' }
  db.prepare('UPDATE wb_doc_sent SET filed_doc_id = ?, filed_rel = ? WHERE id = ?').run(docId, rel, row.id)
  // The project keeps pointing at it (chapter 26): an "official" project document, made only here.
  ensureProjectDocTables()
  try {
    db.prepare('INSERT INTO project_documents (id, project_id, document_id, role, life_rel, note, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(randomUUID().slice(0, 12), item.project_id, docId, 'official', rel, `${row.recipient} · ${row.sent_date}`, Math.floor(Date.now() / 1000), by)
  } catch (err: any) {
    logger.warn({ err: String(err?.message || err), docId }, '[docsent] the official copy was filed but not listed in the project')
  }
  void hashDocument(docId).catch((err) => logger.warn({ err: String(err?.message || err), docId }, '[docsent] hashing the official copy failed'))
  return { ok: true, rel }
}
