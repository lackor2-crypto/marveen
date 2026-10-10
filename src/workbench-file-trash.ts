// #529 (Boss TG 8585): "Kitöröltem a kettő dokumentumot, és nincs itt a lomtár."
//
// A file deleted on the Workbench goes to the Life tree's Kuka (trashLife), and the
// work items that named it forget it (detachDeletedFileRefs). The Kuka alone keeps
// only Kuka/<stamp>/<name>: where the file came from, and which work item used it,
// was lost -- so the Workbench could neither list it in its own trash nor put it
// back. This module remembers both, per deleted file:
//   - recordFileTrash: called right after a Workbench delete; keeps the original
//     path, the Kuka path and the references that were taken off the file.
//   - listFileTrash: the project's deleted files that are still in the Kuka (an
//     entry whose Kuka copy is gone -- emptied, purged, dragged out -- is dropped).
//   - restoreFileTrash: moves the file back to its folder (a free name if the old
//     one is taken now) and gives the references back to whoever still lacks them.

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, renameSync, rmdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { getDb } from './db.js'
import { resolveLifePath, toLifeRel } from './life-explorer.js'
import { movePhysical } from './life-documents.js'
import { isInTrash, trashRelPath } from './life-tree.js'
import { writeBlockReason } from './git-guard.js'
import { APP_LANG } from './config.js'

/** What a delete took off a file: given back on restore, but only where nothing new took its place. */
export type FileTrashRefs = {
  items: string[]
  versions: string[]
  parts: string[]
  assets: Record<string, unknown>[]
  snapshotOff: string[]
}

export type FileTrashEntry = { id: string; name: string; orig_rel: string; folder: string; deleted_at: number }

function ensureTable(): void {
  getDb().exec(`CREATE TABLE IF NOT EXISTS wb_file_trash (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    orig_rel TEXT NOT NULL,
    trash_rel TEXT NOT NULL,
    name TEXT NOT NULL,
    deleted_at INTEGER NOT NULL,
    refs_json TEXT NOT NULL DEFAULT '{}'
  )`)
}

export const emptyFileTrashRefs = (): FileTrashRefs => ({ items: [], versions: [], parts: [], assets: [], snapshotOff: [] })

/** Read (before they are detached) the references the registry keeps to `rel`. */
export function captureFileRefs(rel: string): FileTrashRefs {
  const refs = emptyFileTrashRefs()
  const db = getDb()
  const ids = (sql: string): string[] => {
    try { return (db.prepare(sql).all(rel) as { id: string }[]).map((r) => r.id) } catch { return [] }
  }
  refs.items = ids('SELECT id FROM work_items WHERE source_path = ?')
  refs.versions = ids('SELECT id FROM work_item_versions WHERE source_path = ?')
  refs.parts = ids('SELECT id FROM work_item_parts WHERE asset_path = ?')
  try { refs.assets = db.prepare('SELECT * FROM work_item_assets WHERE path = ?').all(rel) as Record<string, unknown>[] } catch { /* no table yet */ }
  return refs
}

/** Remember one file the Workbench just sent to the Kuka; returns the entry's id ('' if it could not be kept). */
export function recordFileTrash(projectId: string, origRel: string, trashRel: string, refs: FileTrashRefs): string {
  try {
    ensureTable()
    const id = randomUUID()
    getDb().prepare('INSERT INTO wb_file_trash (id, project_id, orig_rel, trash_rel, name, deleted_at, refs_json) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, projectId, origRel, trashRel, basename(origRel), Math.floor(Date.now() / 1000), JSON.stringify(refs))
    return id
  } catch {
    // The file is in the Kuka either way; only the Workbench's list misses it.
    return ''
  }
}

type Row = { id: string; project_id: string; orig_rel: string; trash_rel: string; name: string; deleted_at: number; refs_json: string }

function stillInKuka(trashRel: string): boolean {
  if (!isInTrash(trashRel, APP_LANG)) return false
  const abs = resolveLifePath(trashRel)
  return !!abs && existsSync(abs)
}

/** The project's deleted files still lying in the Kuka, newest first. */
export function listFileTrash(projectId: string): FileTrashEntry[] {
  let rows: Row[] = []
  try {
    ensureTable()
    rows = getDb().prepare('SELECT * FROM wb_file_trash WHERE project_id = ? ORDER BY deleted_at DESC, rowid DESC').all(projectId) as Row[]
  } catch { return [] }
  const out: FileTrashEntry[] = []
  for (const r of rows) {
    if (!stillInKuka(r.trash_rel)) {
      try { getDb().prepare('DELETE FROM wb_file_trash WHERE id = ?').run(r.id) } catch { /* listed again next time, then dropped */ }
      continue
    }
    out.push({ id: r.id, name: r.name, orig_rel: r.orig_rel, folder: dirname(r.orig_rel), deleted_at: r.deleted_at })
  }
  return out
}

/** The Kuka's path in the Life tree (the Workbench links there for files deleted elsewhere). */
export function kukaRel(): string {
  return trashRelPath(APP_LANG)
}

function freeTarget(dir: string, name: string): string {
  let cand = join(dir, name)
  if (!existsSync(cand)) return cand
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  for (let i = 2; i < 1000; i++) {
    cand = join(dir, `${stem} (${i})${ext}`)
    if (!existsSync(cand)) return cand
  }
  return join(dir, `${stem} (${Date.now()})${ext}`)
}

export type RestoreFileResult =
  | { ok: true; rel: string; name: string; renamed: boolean }
  | { ok: false; code: 'file_trash_missing' | 'file_trash_gone' | 'file_trash_failed'; detail?: string }

/** Put a deleted file back where it was, and give its references back. */
export function restoreFileTrash(projectId: string, id: string): RestoreFileResult {
  let row: Row | undefined
  try {
    ensureTable()
    row = getDb().prepare('SELECT * FROM wb_file_trash WHERE id = ? AND project_id = ?').get(id, projectId) as Row | undefined
  } catch { row = undefined }
  if (!row) return { ok: false, code: 'file_trash_missing' }
  const src = resolveLifePath(row.trash_rel)
  if (!src || !isInTrash(row.trash_rel, APP_LANG) || !existsSync(src)) {
    try { getDb().prepare('DELETE FROM wb_file_trash WHERE id = ?').run(row.id) } catch { /* gone anyway */ }
    return { ok: false, code: 'file_trash_gone' }
  }
  const origAbs = resolveLifePath(row.orig_rel)
  if (!origAbs || isInTrash(row.orig_rel, APP_LANG) || writeBlockReason(row.orig_rel)) return { ok: false, code: 'file_trash_failed', detail: 'target outside the tree or write-blocked' }
  const target = freeTarget(dirname(origAbs), basename(origAbs))
  try {
    mkdirSync(dirname(target), { recursive: true })
    renameSync(src, target)
  } catch (err: any) {
    return { ok: false, code: 'file_trash_failed', detail: String(err?.code || err?.message || err) }
  }
  // The Kuka/<stamp> folder the delete made is empty now: it goes (never a folder with something in it).
  try { const d = dirname(src); if (isInTrash(toLifeRel(d), APP_LANG) && toLifeRel(d) !== kukaRel() && !readdirSync(d).length) rmdirSync(d) } catch { /* an empty folder in the Kuka is harmless */ }
  const newRel = toLifeRel(target)
  movePhysical(row.trash_rel, newRel)
  reattach(newRel, safeRefs(row.refs_json))
  try { getDb().prepare('DELETE FROM wb_file_trash WHERE id = ?').run(row.id) } catch { /* listed once more, then dropped as gone */ }
  return { ok: true, rel: newRel, name: basename(target), renamed: target !== origAbs }
}

export type PurgeFileResult = { ok: true; name: string } | { ok: false; code: 'file_trash_missing' }

/**
 * #548 (Boss TG 8665 / 8671): "Delete permanently" on a file row of the Workbench trash. It only makes the
 * Workbench forget the entry: the row (original place and the references that were taken off) goes. The file
 * itself is the Life tree's own, lying in its Kuka -- it is neither deleted nor moved here, and can still be put
 * back from the Kuka in the Explorer. Only a Kuka empty there removes it.
 */
export function purgeFileTrash(projectId: string, id: string): PurgeFileResult {
  try {
    ensureTable()
    const row = getDb().prepare('SELECT id, name FROM wb_file_trash WHERE id = ? AND project_id = ?').get(id, projectId) as { id: string; name: string } | undefined
    if (!row) return { ok: false, code: 'file_trash_missing' }
    getDb().prepare('DELETE FROM wb_file_trash WHERE id = ?').run(row.id)
    return { ok: true, name: row.name }
  } catch {
    return { ok: false, code: 'file_trash_missing' }
  }
}

function safeRefs(json: string): FileTrashRefs {
  try {
    const r = JSON.parse(json || '{}')
    const arr = (x: unknown): string[] => (Array.isArray(x) ? x.filter((s) => typeof s === 'string') : [])
    return {
      items: arr(r.items), versions: arr(r.versions), parts: arr(r.parts), snapshotOff: arr(r.snapshotOff),
      assets: Array.isArray(r.assets) ? r.assets.filter((a: unknown) => a && typeof a === 'object') : [],
    }
  } catch { return emptyFileTrashRefs() }
}

/** Point the references back at the restored file -- only those still empty (a new file chosen meanwhile stays). */
function reattach(rel: string, refs: FileTrashRefs): void {
  const db = getDb()
  const each = (sql: string, ids: string[]): void => {
    for (const id of ids) { try { db.prepare(sql).run(rel, id) } catch { /* a removed row stays removed */ } }
  }
  each('UPDATE work_items SET source_path = ? WHERE id = ? AND source_path IS NULL', refs.items)
  each('UPDATE work_item_versions SET source_path = ? WHERE id = ? AND source_path IS NULL', refs.versions)
  each('UPDATE work_item_parts SET asset_path = ? WHERE id = ? AND asset_path IS NULL', refs.parts)
  for (const a of refs.assets) {
    const cols = Object.keys(a).filter((k) => /^[a-z_]+$/.test(k))
    if (!cols.length) continue
    const vals = cols.map((k) => (k === 'path' ? rel : a[k] as any))
    try { db.prepare(`INSERT OR IGNORE INTO work_item_assets (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...vals) } catch { /* the asset list simply misses it */ }
  }
  for (const id of refs.snapshotOff) {
    try { db.prepare('DELETE FROM work_item_snapshot_off WHERE work_item_id = ?').run(id) } catch { /* the snapshot stays off */ }
  }
}
