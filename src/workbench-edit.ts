/**
 * MUNKAPAD: KOZVETLEN SZERKESZTES, MINDEN MENTES UJ VERZIO (kanban #406, 4. pont).
 *
 * A spec 12 elve ("minden jelentos modositas uj verzio, az eredeti nem irhato
 * felul") eddig csak a kimondott "Mentes uj verziokent" gombnal ervenyesult: a
 * reszek szerkesztese HELYBEN irta at az aktualis verziot. Most a felulet
 * minden mentese -- szoveg javitasa, uj resz, kivetel, atrendezes, egy
 * szovegfajl atirasa -- ELOBB uj verziot nyit, es a valtoztatas abba kerul. Igy
 * az elozo allapot mindig visszaallithato, egy kattintassal.
 *
 * Az UJ verzio es a valtoztatas EGY tranzakcio: ha a valtoztatas elbukik (pl.
 * ures szoveg), a verzio sem marad meg -- nincs "ures" verzio a listaban.
 *
 * A szovegfajl atirasa sem ir felul fajlt: az uj tartalom UJ fajlba kerul a
 * projekt mappajaban (`jegyzet (2).md`), es az uj verzio arra mutat. A regi
 * verzio a regi fajlra mutat tovabb.
 */
import { dirname, basename } from 'node:path'
import { getDb } from './db.js'
import type { ProjectRow } from './projects.js'
import { writeProjectFile, type WriteOutcome } from './project-files.js'
import {
  createWorkItemVersion, listWorkItemParts, getWorkItem,
  type WorkItemRow, type WorkItemVersionRow,
} from './workbench.js'

/** A tranzakcio visszagorgetese egy mar kesz (hibas) eredmennyel. */
class Rollback<T> extends Error {
  constructor(public readonly result: T) { super('rollback') }
}

export type VersionedResult<R> =
  | (R & { ok: true; version: WorkItemVersionRow; item: WorkItemRow })
  | { ok: false; code: string; detail?: string | null }

/**
 * Uj verzio a munkadarab MOSTANI allapotarol, majd a valtoztatas abban.
 *
 * `partId`: ha a valtoztatas egy MEGLEVO reszre szol, az a regi verzio resze
 * -- az uj verzioban a MASOLATA a szerkesztheto. A masolatot a sorrendbeli
 * helye alapjan talaljuk meg (a verzio a reszeket helyuk szerint masolja).
 */
export function editAsNewVersion<R extends { ok: boolean }>(
  itemId: string,
  opts: { created_by?: string | null; prompt?: unknown; kind: string },
  partId: string | null,
  fn: (mappedPartId: string | null) => R,
): VersionedResult<R> {
  const item = getWorkItem(itemId)
  if (!item) return { ok: false, code: 'not_found' }
  const before = listWorkItemParts(item.id)
  const at = partId ? before.findIndex((p) => p.id === partId) : -1
  if (partId && at < 0) return { ok: false, code: 'part_not_found' }
  const db = getDb()
  try {
    return db.transaction(() => {
      // A verziozas ELOTTI (version_id NULL) reszek az aktualis verziohoz
      // tartoznak: most ezt ki is mondjuk, kulonben a masolasbol kimaradnanak,
      // es az uj verzio mellett is "elonek" latszanak (duplan).
      if (item.current_version_id) {
        db.prepare('UPDATE work_item_parts SET version_id = ? WHERE work_item_id = ? AND version_id IS NULL')
          .run(item.current_version_id, item.id)
      }
      const v = createWorkItemVersion(item.id, {
        created_by: opts.created_by ?? null,
        prompt: opts.prompt,
        metadata_json: JSON.stringify({ edit: opts.kind }),
      })
      if (!v.ok) throw new Rollback({ ok: false as const, code: v.code })
      let mapped: string | null = null
      if (partId) {
        const after = listWorkItemParts(item.id)
        mapped = after[at] ? after[at].id : null
        if (!mapped) throw new Rollback({ ok: false as const, code: 'part_not_found' })
      }
      const r = fn(mapped)
      if (!r.ok) throw new Rollback(r as unknown as { ok: false; code: string })
      const fresh = getWorkItem(item.id)
      if (!fresh) throw new Error('work item disappeared while saving a version')
      return { ...r, ok: true as const, version: v.version, item: fresh }
    })()
  } catch (e) {
    if (e instanceof Rollback) return e.result as VersionedResult<R>
    throw e
  }
}

/** Egy szovegfajl uj tartalmanak felso hatara (egy jegyzet, nem egy adatbazis). */
export const TEXT_SOURCE_MAX = 1_000_000

/** A regi " (3)" jelzest levesszuk, hogy a kovetkezo mentes ne
 *  "jegyzet (3) (2).md" legyen, hanem "jegyzet (4).md". */
export function baseNameForNextVersion(name: string): string {
  return basename(String(name || '')).replace(/ \(\d+\)(\.[^.]+)?$/, '$1')
}

/** A projekt mappajan beluli almappa, ahol a regi fajl allt (vagy ''). */
export function subFolderOf(project: ProjectRow, rel: string): string {
  const root = String(project.folder_path || '').replace(/\/+$/, '')
  const dir = dirname(String(rel || ''))
  if (!root || dir === root || dir === '.') return ''
  return dir.startsWith(root + '/') ? dir.slice(root.length + 1) : ''
}

export type TextSaveResult =
  | { ok: true; item: WorkItemRow; version: WorkItemVersionRow; file: Extract<WriteOutcome, { ok: true }> }
  | { ok: false; code: string; detail?: string | null }

/** Egy szovegfajl-forrasu munkadarab uj tartalma: UJ fajl + UJ verzio. */
export function saveTextSourceAsNewVersion(
  item: WorkItemRow, project: ProjectRow, rel: string, text: string,
  opts: { created_by?: string | null; prompt?: unknown } = {},
): TextSaveResult {
  if (text.length > TEXT_SOURCE_MAX) return { ok: false, code: 'text_source_too_long' }
  const out = writeProjectFile(project, subFolderOf(project, rel), baseNameForNextVersion(rel), Buffer.from(text, 'utf-8'))
  if (!out.ok) return { ok: false, code: out.code, detail: out.message || null }
  const v = createWorkItemVersion(item.id, {
    source_path: out.rel,
    created_by: opts.created_by ?? null,
    prompt: opts.prompt,
    metadata_json: JSON.stringify({ edit: 'text_source' }),
  })
  if (!v.ok) return { ok: false, code: v.code }
  return { ok: true, item: v.item, version: v.version, file: out }
}
