// WHAT THE CLOUD FOLDER HELD THE LAST TIME WE LOOKED (#511).
//
// The owner (TG 2494): what is deleted in the cloud must not just vanish from
// the page -- it stays visible, marked "deleted in the cloud". Drive can be
// asked for its trash; MEGA cannot (rclone's mega backend has no way to list
// the rubbish bin). So for a cloud that cannot say what was deleted, the page
// REMEMBERS what a folder held: an item that was there on an earlier, complete
// listing and is missing from this one is returned as "gone" until the owner
// dismisses it.
//
// What "gone" does and does not claim: the item is no longer AT THIS PLACE in
// the cloud. Deleted, renamed or moved up there look the same from here, and
// the page says so. What the owner does on this page (rename, move, trash) is
// forgotten right away (`forgetSeen`), so his own action never comes back as
// "deleted in the cloud".
//
// Nothing here touches a file. One small JSON under the store, written only
// when something changed, replaced atomically.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { STORE_DIR } from './config.js'
import { logger } from './logger.js'

export interface SeenItem {
  isDir: boolean
  size: number | null
  /** When a listing last contained it (ISO). */
  seenAt: string
  /** When a listing first did NOT contain it any more (ISO). Absent = still there. */
  goneAt?: string
}

export interface GoneItem {
  name: string
  /** Path inside the account, `/` separated. */
  path: string
  isDir: boolean
  size: number | null
  seenAt: string
  goneAt: string
}

/** account key -> folder path -> item name -> what we saw */
type SeenStore = Record<string, Record<string, Record<string, SeenItem>>>

function seenFile(): string { return join(STORE_DIR, 'cloud-seen.json') }

function readStore(): SeenStore {
  try {
    const j = JSON.parse(readFileSync(seenFile(), 'utf8'))
    return j && typeof j === 'object' && !Array.isArray(j) ? j as SeenStore : {}
  } catch { return {} }
}

function writeStore(s: SeenStore): void {
  try {
    if (!existsSync(STORE_DIR)) mkdirSync(STORE_DIR, { recursive: true })
    const tmp = seenFile() + '.tmp'
    writeFileSync(tmp, JSON.stringify(s), 'utf8')
    renameSync(tmp, seenFile())
  } catch (err) {
    // The memory is a convenience: a listing must never fail because of it.
    logger.warn({ err: String(err) }, '[cloud-seen] could not save what the cloud folder held')
  }
}

const key = (kind: string, account: string): string => `${kind}:${account}`
const join2 = (folder: string, name: string): string => (folder ? folder + '/' + name : name)

/**
 * The pure step: the remembered folder + a COMPLETE listing -> the new
 * remembered folder, what is gone, and whether anything changed.
 */
export function reconcileFolder(
  before: Record<string, SeenItem>,
  items: Array<{ name: string; isDir: boolean; size: number | null }>,
  nowIso: string,
): { after: Record<string, SeenItem>; gone: Array<{ name: string } & SeenItem & { goneAt: string }>; changed: boolean } {
  const after: Record<string, SeenItem> = {}
  let changed = false
  const present = new Set<string>()
  for (const it of items) {
    if (!it || typeof it.name !== 'string' || !it.name) continue
    present.add(it.name)
    const old = before[it.name]
    // `seenAt` is NOT refreshed on every look: it would rewrite the file on
    // each page load. It moves when the item is new, came back, or changed.
    if (old && !old.goneAt && old.isDir === it.isDir && old.size === it.size) { after[it.name] = old; continue }
    after[it.name] = { isDir: it.isDir, size: it.size, seenAt: nowIso }
    changed = true
  }
  const gone: Array<{ name: string } & SeenItem & { goneAt: string }> = []
  for (const [name, old] of Object.entries(before)) {
    if (present.has(name)) continue
    const goneAt = old.goneAt || nowIso
    if (!old.goneAt) changed = true
    after[name] = { ...old, goneAt }
    gone.push({ name, ...old, goneAt })
  }
  gone.sort((a, b) => a.name.localeCompare(b.name))
  return { after, gone, changed }
}

/**
 * Called with a COMPLETE, successful listing of one folder. Returns what was
 * there before and is not now. A failed or partial listing must never get
 * here: "could not look" is not "deleted".
 */
export function rememberListing(
  kind: string, account: string, folder: string,
  items: Array<{ name: string; isDir: boolean; size: number | null }>,
  now: Date = new Date(),
): GoneItem[] {
  const store = readStore()
  const k = key(kind, account)
  const acc = store[k] || {}
  const r = reconcileFolder(acc[folder] || {}, items, now.toISOString())
  if (r.changed) {
    if (Object.keys(r.after).length) acc[folder] = r.after
    else delete acc[folder]
    store[k] = acc
    writeStore(store)
  }
  return r.gone.map((g) => ({ name: g.name, path: join2(folder, g.name), isDir: g.isDir, size: g.size, seenAt: g.seenAt, goneAt: g.goneAt }))
}

/**
 * Forget one item (and, for a folder, everything remembered beneath it): the
 * owner dismissed it, or he himself renamed / moved / trashed it on this page.
 * Returns whether anything was remembered.
 */
export function forgetSeen(kind: string, account: string, path: string): boolean {
  const clean = String(path || '').split('/').filter(Boolean).join('/')
  if (!clean) return false
  const store = readStore()
  const acc = store[key(kind, account)]
  if (!acc) return false
  const cut = clean.lastIndexOf('/')
  const folder = cut < 0 ? '' : clean.slice(0, cut)
  const name = cut < 0 ? clean : clean.slice(cut + 1)
  let hit = false
  if (acc[folder] && acc[folder][name]) {
    delete acc[folder][name]
    if (!Object.keys(acc[folder]).length) delete acc[folder]
    hit = true
  }
  for (const f of Object.keys(acc)) {
    if (f === clean || f.startsWith(clean + '/')) { delete acc[f]; hit = true }
  }
  if (hit) writeStore(store)
  return hit
}

/** An account was taken off: its memory goes with it. */
export function forgetAccount(kind: string, account: string): void {
  const store = readStore()
  if (store[key(kind, account)]) { delete store[key(kind, account)]; writeStore(store) }
}
