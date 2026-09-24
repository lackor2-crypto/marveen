// ARCHIVING IN PLACE: a closed item stays where it is, it is only MARKED.
//
// The owner (2026-09-24): "nem az a legjobb, hogyha minden a helyén marad?
// ... Hol a faszomba keresem, ha keresek valamit?" -- a separate `Archív`
// branch means every search and every browse has two places to look. So the
// life tree has no archive branch any more; instead any file or folder can be
// switched to "archived": it keeps its place on disk, the list shows it grey
// and puts it at the END of its group, and switching it back restores it.
//
// The mark is host DATA (like life-labels.json), keyed by the tree path, so it
// lives in store/ and has to follow moves and renames (`moveArchivedPrefix`).
// Fresh install: no file -> nothing archived -> every list looks as before.
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { STORE_DIR } from './config.js'
import { logger } from './logger.js'

const STORE_PATH = join(STORE_DIR, 'life-archived.json')

/** rel (slash-separated, root-relative) -> ISO time it was archived. */
type ArchivedMap = Record<string, string>

let cache: ArchivedMap | null = null
let cacheMtimeMs = -1

function normRel(rel: string): string {
  return String(rel || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
}

function load(): ArchivedMap {
  let mtimeMs = -1
  try { mtimeMs = existsSync(STORE_PATH) ? statSync(STORE_PATH).mtimeMs : -1 } catch { mtimeMs = -1 }
  if (cache !== null && mtimeMs === cacheMtimeMs) return cache
  if (mtimeMs === -1) { cache = {}; cacheMtimeMs = -1; return cache }
  try {
    const raw = JSON.parse(readFileSync(STORE_PATH, 'utf8'))
    const src = raw && typeof raw.archived === 'object' && raw.archived ? raw.archived : {}
    const out: ArchivedMap = {}
    for (const [k, v] of Object.entries(src)) {
      const key = normRel(k)
      if (key) out[key] = typeof v === 'string' ? v : new Date(0).toISOString()
    }
    cache = out; cacheMtimeMs = mtimeMs
    return out
  } catch (err: any) {
    // A broken file must not stop the explorer: without marks every item just
    // shows normally. Writes are refused (see `corrupt`) so the file is not
    // overwritten with an empty map and the marks lost for good.
    logger.warn({ err: err?.message }, '[eletfa] serult life-archived.json, archiv-jelolesek nelkul')
    cache = {}; cacheMtimeMs = mtimeMs
    return cache
  }
}

function corrupt(): boolean {
  if (!existsSync(STORE_PATH)) return false
  try { JSON.parse(readFileSync(STORE_PATH, 'utf8')); return false } catch { return true }
}

function save(map: ArchivedMap): void {
  mkdirSync(STORE_DIR, { recursive: true })
  const tmp = `${STORE_PATH}.tmp`
  writeFileSync(tmp, JSON.stringify({ archived: map }, null, 2), 'utf8')
  renameSync(tmp, STORE_PATH)
  cache = null; cacheMtimeMs = -1
}

/** Is this exact item marked archived? (A folder's mark does not grey its children.) */
export function isArchived(rel: string): boolean {
  const key = normRel(rel)
  return !!key && key in load()
}

/** ISO time the item was archived, or null. */
export function archivedAt(rel: string): string | null {
  const key = normRel(rel)
  return key ? load()[key] ?? null : null
}

export interface SetArchivedResult { ok: boolean; code?: string; archived: boolean }

/** Switch the mark on or off. The caller has already checked that `rel` is inside the tree. */
export function setArchived(rel: string, archived: boolean): SetArchivedResult {
  const key = normRel(rel)
  if (!key) return { ok: false, code: 'no_rel', archived: false }
  if (corrupt()) return { ok: false, code: 'store_corrupt', archived: isArchived(key) }
  const map = { ...load() }
  if (archived) {
    if (!(key in map)) { map[key] = new Date().toISOString(); save(map) }
  } else if (key in map) {
    delete map[key]
    save(map)
  }
  return { ok: true, archived }
}

/**
 * An item moved or was renamed: its mark -- and the marks of everything under
 * it -- follow it. Without this a moved archived folder would silently come
 * back as "active", and a stale mark would wait on the old path for the next
 * item that happens to get the same name. Returns how many marks moved.
 */
export function moveArchivedPrefix(fromRel: string, toRel: string): number {
  const from = normRel(fromRel)
  const to = normRel(toRel)
  if (!from || !to || from === to || corrupt()) return 0
  const map = { ...load() }
  let moved = 0
  for (const key of Object.keys(map)) {
    if (key !== from && !key.startsWith(from + '/')) continue
    map[to + key.slice(from.length)] = map[key]
    delete map[key]
    moved++
  }
  if (moved) save(map)
  return moved
}

/** The item went to the trash: its marks go too (a new item with the same name starts clean). */
export function dropArchivedPrefix(rel: string): number {
  const key = normRel(rel)
  if (!key || corrupt()) return 0
  const map = { ...load() }
  let n = 0
  for (const k of Object.keys(map)) {
    if (k === key || k.startsWith(key + '/')) { delete map[k]; n++ }
  }
  if (n) save(map)
  return n
}
