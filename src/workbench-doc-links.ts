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
  if (!rows.length) return []
  const out: LinkedUse[] = []
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
