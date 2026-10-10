// A DOCUMENT OF THE LIFE TREE, USED BY A PROJECT WITHOUT A COPY (#530, phase 1).
//
// The owner's specification (Tudásbázis, "dokumentumkezelés implementációs
// specifikáció", chapters 12, 13, 27-30, 43, 44) and his condition (TG 8500):
// "egy iratot mellekletkent tobb munkadarabhoz is be lehessen csatolni [...] egy
// hivatal keri pld egy igazolast a nyugdijrol, ugyanakkor egy masik hivatal is
// ugyanezt a nyugdijigazolast keri."
//
// Until now an annex had to be a file INSIDE the project folder, so the same
// certificate was copied into every project that needed it. A linked annex
// holds the document's stable id (life-doc-ids.ts) instead: the file stays in
// its one place, any number of documents and projects refer to it, and a rename
// or a move does not lose it.
//
// This file is the glue between the annex list and the document ids:
//   - linking a Life-tree file (id made on demand, content hashed in the
//     background so a move done outside Marveen can be recognised later);
//   - keeping "where it was last seen" current, and looking for a file that is
//     no longer at its place -- in the background, never in the request;
//   - answering "where is this file used?" before it is put in the Bin.
//
// Nothing here moves, copies or deletes a file.

import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { getDb } from './db.js'
import { logger } from './logger.js'
import { resolveLifePath } from './life-explorer.js'
import { documentById, ensureDocumentId, ensureLifeDocTables, hashDocument, relocateDocument } from './life-doc-ids.js'
import { LINKED_PREFIX, linkAnnex, linkedAnnexRows, listAnnexes, rememberLinkedRel, type AnnexResult, type AnnexView, type FileResolver } from './workbench-docannex.js'
import { ensureWorkbenchTables } from './workbench.js'

const norm = (rel: string): string => String(rel || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')

/** Link the Life-tree file at `lifeRel` as an annex of this document. No copy is made. */
export async function linkLifeFileAsAnnex(
  itemId: string, lifeRel: string, input: { title?: unknown; position?: unknown }, resolve: FileResolver, by: string | null,
): Promise<AnnexResult<{ annex: AnnexView; rewritten: number }>> {
  const rel = norm(lifeRel)
  if (!rel || rel.split('/').includes('..')) return { ok: false, code: 'bad_input', detail: 'rel (a file of the Life tree) is required' }
  const abs = resolveLifePath(rel)
  if (!abs) return { ok: false, code: 'file_missing', detail: 'this place is not inside the Life tree' }
  try { if (!(await stat(abs)).isFile()) return { ok: false, code: 'bad_input', detail: 'a folder cannot be an annex' } } catch { return { ok: false, code: 'file_missing', detail: 'there is no such file' } }
  const docId = await ensureDocumentId(rel)
  if (!docId) return { ok: false, code: 'file_missing', detail: 'there is no such file' }
  const r = linkAnnex(itemId, { docId, lifeRel: rel, title: input.title, position: input.position }, resolve, by)
  // The content hash is what lets a file moved or renamed OUTSIDE Marveen be recognised again.
  // It reads the whole file from a possibly slow disk, so it does not hold the answer up.
  if (r.ok) void hashDocument(docId).catch((err) => logger.warn({ err: String(err?.message || err), docId }, '[doc-links] hashing a linked document failed'))
  return r
}

const looking = new Set<string>()

/**
 * After an annex list was read: keep the last-seen place of the linked files current, and start
 * looking (in the background) for the ones that are not at their place. Returns how many are
 * being looked for, so the page can say "looking" and ask again.
 */
export function tendLinkedAnnexes(itemId: string, resolve: FileResolver | undefined): number {
  if (!resolve) return 0
  let searching = 0
  for (const a of listAnnexes(itemId, resolve)) {
    if (!a.linked) continue
    const id = a.path.slice(LINKED_PREFIX.length)
    if (a.exists) {
      const doc = documentById(id)
      if (doc) rememberLinkedRel(a.id, doc.rel)
      continue
    }
    if (looking.has(id)) { searching++; continue }
    looking.add(id)
    searching++
    void relocateDocument(id)
      .then((to) => { if (to) logger.info({ id, to }, '[doc-links] a linked document was found at its new place') })
      .catch((err) => logger.warn({ err: String(err?.message || err), id }, '[doc-links] looking for a linked document failed'))
      // Not asked again for ten minutes: a walk of the tree on a slow disk is not free.
      .finally(() => { setTimeout(() => looking.delete(id), 10 * 60_000).unref() })
  }
  return searching
}

export interface LinkedUse { file: string; project: string; item: string; label: string }

/**
 * Which documents use, as an annex, the file at `rel` -- or any file below it when `rel` is a
 * folder. Asked before something goes to the Bin: the owner must know it is in use elsewhere.
 */
export function linkedUsesUnder(rel: string): LinkedUse[] {
  const key = norm(rel)
  if (!key) return []
  ensureLifeDocTables()
  ensureWorkbenchTables()
  const rows = linkedAnnexRows()
  const out: LinkedUse[] = []
  // Phase 2: a document a project holds in a role (source, reference, related) is in use too.
  for (const d of projectDocRowsUnder(key)) out.push({ file: d.rel, project: d.project, item: '', label: d.role })
  if (!rows.length) return out
  const numberOf = new Map<string, Map<string, string>>()
  for (const a of rows) {
    const doc = documentById(a.path.slice(LINKED_PREFIX.length))
    if (!doc || !(doc.rel === key || doc.rel.startsWith(key + '/'))) continue
    const w = getDb().prepare(`SELECT w.title AS item, p.name AS project FROM work_items w LEFT JOIN projects p ON p.id = w.project_id WHERE w.id = ? AND w.deleted_at IS NULL`).get(a.work_item_id) as { item: string; project: string | null } | undefined
    if (!w) continue
    let labels = numberOf.get(a.work_item_id)
    if (!labels) { labels = new Map(listAnnexes(a.work_item_id).map((v) => [v.id, v.label])); numberOf.set(a.work_item_id, labels) }
    out.push({ file: doc.rel, project: w.project || '', item: w.item, label: labels.get(a.id) || '' })
  }
  return out
}

// ---------------------------------------------------------------------------
// PHASE 2: A DOCUMENT'S ROLE IN A PROJECT (specification, chapters 10, 15, 28, 41, 42, 60)
// ---------------------------------------------------------------------------
//
// "Mely dokumentumokbol dolgozunk?" -- a project gathers the documents it works FROM
// (source), the ones it only refers to (reference), and the ones that merely belong to
// the matter (related), without copying any of them. An ATTACHMENT is not kept here: that
// is the annex list of a submission (above), and this view only shows it, read from there.
// Removing a row removes the link, never the file.

export const PROJECT_DOC_ROLES = ['source', 'reference', 'related'] as const
export type ProjectDocRole = typeof PROJECT_DOC_ROLES[number]
export const isProjectDocRole = (v: unknown): v is ProjectDocRole => typeof v === 'string' && (PROJECT_DOC_ROLES as readonly string[]).includes(v)
export const PROJECT_DOCS_MAX = 500
export const PROJECT_DOC_NOTE_MAX = 300

let pdTablesDb: unknown = null
export function ensureProjectDocTables(): void {
  const db = getDb()
  if (pdTablesDb === db) return
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_documents (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      document_id TEXT NOT NULL,
      role TEXT NOT NULL,
      life_rel TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      created_by TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_project_documents_one ON project_documents(project_id, document_id);
    CREATE INDEX IF NOT EXISTS idx_project_documents_doc ON project_documents(document_id);
  `)
  pdTablesDb = db
}

interface PdRow { id: string; project_id: string; document_id: string; role: string; life_rel: string; note: string; created_at: number; created_by: string | null }

/** `official`: the filed copy of something that was SENT (workbench-docsent.ts). Never chosen by hand, never changed into another role. */
export type ProjectDocAnyRole = ProjectDocRole | 'official'

export interface ProjectDocView {
  id: string
  role: ProjectDocAnyRole
  note: string
  /** The file's name and place as they are now; the last known ones when it cannot be found. */
  name: string
  life_rel: string
  /** false = not at its place (moved outside Marveen, or the disk is not there) -- never "deleted". */
  exists: boolean
  created_at: number
}

export interface ProjectAttachmentView { item_id: string; item: string; label: string; title: string; name: string; life_rel: string; exists: boolean }

export type PdResult<T> = ({ ok: true } & T) | { ok: false; code: 'bad_input' | 'bad_role' | 'file_missing' | 'duplicate' | 'too_many' | 'not_found'; detail: string }

const baseOf = (rel: string): string => rel.slice(rel.lastIndexOf('/') + 1)

function docNow(docId: string, lastRel: string): { rel: string; exists: boolean } {
  const doc = documentById(docId)
  const rel = doc ? doc.rel : lastRel
  const abs = resolveLifePath(rel)
  let exists = false
  if (abs) { try { exists = statSync(abs).isFile() } catch { exists = false } }
  return { rel, exists }
}

/** The documents the project holds in a role, and (read from the annex lists) the ones its submissions attach. */
export function listProjectDocs(projectId: string): { docs: ProjectDocView[]; attachments: ProjectAttachmentView[]; searching: number } {
  ensureProjectDocTables()
  ensureWorkbenchTables()
  const db = getDb()
  let searching = 0
  const lookFor = (docId: string): void => {
    searching++
    if (looking.has(docId)) return
    looking.add(docId)
    void relocateDocument(docId)
      .catch((err) => logger.warn({ err: String(err?.message || err), docId }, '[doc-links] looking for a project document failed'))
      .finally(() => { setTimeout(() => looking.delete(docId), 10 * 60_000).unref() })
  }
  const rows = db.prepare('SELECT * FROM project_documents WHERE project_id = ? ORDER BY role, created_at, id').all(projectId) as PdRow[]
  const docs = rows.map((r) => {
    const now = docNow(r.document_id, r.life_rel)
    if (now.exists && now.rel !== r.life_rel) db.prepare('UPDATE project_documents SET life_rel = ? WHERE id = ?').run(now.rel, r.id)
    if (!now.exists) lookFor(r.document_id)
    return { id: r.id, role: (r.role === 'official' ? 'official' : isProjectDocRole(r.role) ? r.role : 'related') as ProjectDocAnyRole, note: r.note, name: baseOf(now.rel), life_rel: now.rel, exists: now.exists, created_at: r.created_at }
  })
  const attachments: ProjectAttachmentView[] = []
  const items = db.prepare('SELECT id, title FROM work_items WHERE project_id = ? AND deleted_at IS NULL').all(projectId) as { id: string; title: string }[]
  for (const it of items) {
    for (const a of listAnnexes(it.id)) {
      if (!a.linked) continue
      const now = docNow(a.path.slice(LINKED_PREFIX.length), a.life_rel || '')
      attachments.push({ item_id: it.id, item: it.title, label: a.label, title: a.title, name: baseOf(now.rel), life_rel: now.rel, exists: now.exists })
    }
  }
  return { docs, attachments, searching }
}

/** Put a Life-tree file into the project in a role. No copy is made; one document has one role in one project. */
export async function addProjectDoc(projectId: string, lifeRel: string, input: { role?: unknown; note?: unknown }, by: string | null): Promise<PdResult<{ id: string }>> {
  ensureProjectDocTables()
  const role = input.role === undefined || input.role === null || input.role === '' ? 'source' : input.role
  if (!isProjectDocRole(role)) return { ok: false, code: 'bad_role', detail: `role must be one of ${PROJECT_DOC_ROLES.join(', ')}` }
  const note = String(input.note ?? '').trim()
  if (note.length > PROJECT_DOC_NOTE_MAX) return { ok: false, code: 'bad_input', detail: `the note is at most ${PROJECT_DOC_NOTE_MAX} characters` }
  const rel = norm(lifeRel)
  if (!rel || rel.split('/').includes('..')) return { ok: false, code: 'bad_input', detail: 'rel (a file of the Life tree) is required' }
  const abs = resolveLifePath(rel)
  if (!abs) return { ok: false, code: 'file_missing', detail: 'this place is not inside the Life tree' }
  try { if (!(await stat(abs)).isFile()) return { ok: false, code: 'bad_input', detail: 'a folder cannot be added, only a file' } } catch { return { ok: false, code: 'file_missing', detail: 'there is no such file' } }
  const docId = await ensureDocumentId(rel)
  if (!docId) return { ok: false, code: 'file_missing', detail: 'there is no such file' }
  const db = getDb()
  if (db.prepare('SELECT 1 FROM project_documents WHERE project_id = ? AND document_id = ?').get(projectId, docId)) return { ok: false, code: 'duplicate', detail: 'this document is already in the project' }
  const n = (db.prepare('SELECT COUNT(*) AS n FROM project_documents WHERE project_id = ?').get(projectId) as { n: number }).n
  if (n >= PROJECT_DOCS_MAX) return { ok: false, code: 'too_many', detail: `a project holds at most ${PROJECT_DOCS_MAX} documents` }
  const id = randomUUID().slice(0, 12)
  db.prepare('INSERT INTO project_documents (id, project_id, document_id, role, life_rel, note, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, projectId, docId, role, rel, note, Math.floor(Date.now() / 1000), by)
  void hashDocument(docId).catch((err) => logger.warn({ err: String(err?.message || err), docId }, '[doc-links] hashing a project document failed'))
  return { ok: true, id }
}

export function updateProjectDoc(projectId: string, id: string, patch: { role?: unknown; note?: unknown }): PdResult<object> {
  ensureProjectDocTables()
  const db = getDb()
  const row = db.prepare('SELECT * FROM project_documents WHERE id = ? AND project_id = ?').get(String(id || ''), projectId) as PdRow | undefined
  if (!row) return { ok: false, code: 'not_found', detail: 'no such document in this project' }
  let role = row.role
  let note = row.note
  if (patch.role !== undefined && patch.role !== null) {
    if (row.role === 'official') return { ok: false, code: 'bad_role', detail: 'an official (sent) document keeps its role' }
    if (!isProjectDocRole(patch.role)) return { ok: false, code: 'bad_role', detail: `role must be one of ${PROJECT_DOC_ROLES.join(', ')}` }
    role = patch.role
  }
  if (patch.note !== undefined && patch.note !== null) {
    note = String(patch.note).trim()
    if (note.length > PROJECT_DOC_NOTE_MAX) return { ok: false, code: 'bad_input', detail: `the note is at most ${PROJECT_DOC_NOTE_MAX} characters` }
  }
  db.prepare('UPDATE project_documents SET role = ?, note = ? WHERE id = ?').run(role, note, row.id)
  return { ok: true }
}

/** "Eltavolitas a projektbol": the link goes, the document stays where it is. */
export function removeProjectDoc(projectId: string, id: string): PdResult<object> {
  ensureProjectDocTables()
  const r = getDb().prepare('DELETE FROM project_documents WHERE id = ? AND project_id = ?').run(String(id || ''), projectId)
  return r.changes ? { ok: true } : { ok: false, code: 'not_found', detail: 'no such document in this project' }
}

/** The project documents at `key` or below it, for "where is this file used?". */
function projectDocRowsUnder(key: string): Array<{ rel: string; project: string; role: string }> {
  ensureProjectDocTables()
  const rows = getDb().prepare('SELECT d.document_id, d.life_rel, d.role, p.name AS project FROM project_documents d LEFT JOIN projects p ON p.id = d.project_id').all() as Array<{ document_id: string; life_rel: string; role: string; project: string | null }>
  const out: Array<{ rel: string; project: string; role: string }> = []
  for (const r of rows) {
    const doc = documentById(r.document_id)
    const rel = doc ? doc.rel : r.life_rel
    if (rel === key || rel.startsWith(key + '/')) out.push({ rel, project: r.project || '', role: r.role })
  }
  return out
}
