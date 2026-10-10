// THE PLACES IN THE LIFE TREE A PROJECT BELONGS TO (#530; the owner's specification, chapter 50).
//
// "A projekt rendelkezzen egy vagy tobb kapcsolodo eletfahellyel. [...] Ez segiti az automatikus
// navigaciot es a dokumentumok megtalalasat." -- e.g. the Jobcenter case points at
// "Korpas Laszlo > Hatosagok > Nemetorszag > Jobcenter". This is NOT the project's own folder
// (where its work items live): it is where the matter's documents are kept. Only a pointer --
// nothing is moved or copied, and removing it removes the pointer.
//
// A folder renamed or moved in the Explorer is followed (life-follow.ts calls
// moveProjectPlacesPrefix). This module knows the database only, so that life-follow can use it
// without pulling the Workbench in.

import { getDb } from './db.js'

export const PROJECT_PLACES_MAX = 20

let tablesDb: unknown = null
export function ensureProjectPlaceTables(): void {
  const db = getDb()
  if (tablesDb === db) return
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_places (
      project_id TEXT NOT NULL,
      rel TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      created_by TEXT,
      PRIMARY KEY (project_id, rel)
    )
  `)
  tablesDb = db
}

const norm = (rel: string): string => String(rel || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')

export type PlaceResult = { ok: true } | { ok: false; code: 'bad_input' | 'duplicate' | 'too_many' | 'not_found'; detail: string }

/** The project's places, in the order they were added. */
export function listProjectPlaces(projectId: string): string[] {
  ensureProjectPlaceTables()
  return (getDb().prepare('SELECT rel FROM project_places WHERE project_id = ? ORDER BY created_at, rel').all(projectId) as { rel: string }[]).map((r) => r.rel)
}

/** Remember a folder of the Life tree as a place of the project. The caller has checked that it is a folder of the tree. */
export function addProjectPlace(projectId: string, rel: string, by: string | null): PlaceResult {
  ensureProjectPlaceTables()
  const key = norm(rel)
  if (!key || key.split('/').includes('..')) return { ok: false, code: 'bad_input', detail: 'rel (a folder of the Life tree) is required' }
  const db = getDb()
  if (db.prepare('SELECT 1 FROM project_places WHERE project_id = ? AND rel = ?').get(projectId, key)) return { ok: false, code: 'duplicate', detail: 'this place is already linked to the project' }
  if (listProjectPlaces(projectId).length >= PROJECT_PLACES_MAX) return { ok: false, code: 'too_many', detail: `a project has at most ${PROJECT_PLACES_MAX} places` }
  db.prepare('INSERT INTO project_places (project_id, rel, created_at, created_by) VALUES (?, ?, ?, ?)').run(projectId, key, Math.floor(Date.now() / 1000), by)
  return { ok: true }
}

export function removeProjectPlace(projectId: string, rel: string): PlaceResult {
  ensureProjectPlaceTables()
  const r = getDb().prepare('DELETE FROM project_places WHERE project_id = ? AND rel = ?').run(projectId, norm(rel))
  return r.changes ? { ok: true } : { ok: false, code: 'not_found', detail: 'this place is not linked to the project' }
}

/**
 * A folder was renamed or moved in the Explorer: the places at it and below it follow. A place
 * that would land on one the project already has is dropped (the two became the same folder).
 */
export function moveProjectPlacesPrefix(fromRel: string, toRel: string): number {
  const from = norm(fromRel)
  const to = norm(toRel)
  if (!from || !to || from === to) return 0
  ensureProjectPlaceTables()
  const db = getDb()
  const rows = (db.prepare('SELECT project_id, rel FROM project_places').all() as { project_id: string; rel: string }[]).filter((r) => r.rel === from || r.rel.startsWith(from + '/'))
  if (!rows.length) return 0
  db.transaction(() => {
    for (const r of rows) {
      const next = to + r.rel.slice(from.length)
      if (db.prepare('SELECT 1 FROM project_places WHERE project_id = ? AND rel = ?').get(r.project_id, next)) db.prepare('DELETE FROM project_places WHERE project_id = ? AND rel = ?').run(r.project_id, r.rel)
      else db.prepare('UPDATE project_places SET rel = ? WHERE project_id = ? AND rel = ?').run(next, r.project_id, r.rel)
    }
  })()
  return rows.length
}
