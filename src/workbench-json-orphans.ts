// #625 (Boss TG 3564, 3567 "B"): finds drawing / deck JSON files that no work item uses any more, so the owner can
// clear them out. It NEVER deletes by itself: the owner sees the list and approves, and an approved file goes to the
// Trash (recoverable), not away. marveen-item.json is never a candidate: it is the work item's own backup.

import { readdir, stat } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { join } from 'node:path'
import { getDb } from './db.js'
import { listProjects } from './projects.js'
import { resolveLifePath, toLifeRel, trashLife } from './life-explorer.js'

const ORPHAN_NAME = /\.(canvas|deck)(?: \(\d+\))?\.json$/i
// The budget is PER PROJECT folder: a huge tree (a MetaTrader / repo folder) must not use it up and leave the other
// projects unscanned -- the shared budget of the first version made the live scan list nothing at all.
const MAX_ENTRIES = 100000
const MAX_DEPTH = 8

function referencedPaths(): Set<string> {
  const db = getDb()
  const used = new Set<string>()
  const take = (sql: string): void => {
    try { for (const r of db.prepare(sql).all() as { p: string | null }[]) if (r.p) used.add(r.p) } catch { /* a table that is not there uses nothing */ }
  }
  take('SELECT source_path AS p FROM work_items')
  take('SELECT source_path AS p FROM work_item_versions')
  take('SELECT path AS p FROM work_item_assets WHERE removed_at IS NULL')
  take('SELECT asset_path AS p FROM work_item_parts')
  return used
}

export interface OrphanJson { rel: string; name: string; bytes: number }

/** Async and parallel per folder: a big tree on a Windows drive takes seconds, and must not freeze the dashboard. */
export async function findOrphanJsons(maxEntries = MAX_ENTRIES): Promise<{ files: OrphanJson[]; truncated: boolean }> {
  const used = referencedPaths()
  const files: OrphanJson[] = []
  const walked = new Set<string>()
  let truncated = false
  const scan = async (root: string): Promise<void> => {
    let seen = 0
    let cut = false
    const walk = async (abs: string, depth: number): Promise<void> => {
      if (cut || depth > MAX_DEPTH || walked.has(abs)) return
      walked.add(abs)
      let entries: Dirent[] = []
      try { entries = await readdir(abs, { withFileTypes: true }) } catch { return }
      const subs: Promise<void>[] = []
      for (const e of entries) {
        if (++seen > maxEntries) { cut = true; break }
        if (e.name.startsWith('.')) continue
        const p = join(abs, e.name)
        if (e.isDirectory()) { subs.push(walk(p, depth + 1)); continue }
        if (!e.isFile() || !ORPHAN_NAME.test(e.name)) continue
        subs.push((async () => {
          let st
          try { st = await stat(p) } catch { return }
          const rel = toLifeRel(p)
          if (rel && !used.has(rel)) files.push({ rel, name: e.name, bytes: st.size })
        })())
      }
      await Promise.all(subs)
    }
    await walk(root, 0)
    if (cut) truncated = true
  }
  const done = new Set<string>()
  for (const pr of listProjects({ includeArchived: true })) {
    if (!pr.folder_path || done.has(pr.folder_path)) continue
    done.add(pr.folder_path)
    const abs = resolveLifePath(pr.folder_path)
    if (abs) await scan(abs)
  }
  files.sort((x, y) => x.rel.localeCompare(y.rel))
  return { files, truncated }
}

export interface OrphanOutcome { rel: string; ok: boolean; message: string }

/** Trashes the approved files, but only those that are orphans right now (the list may be stale). */
export async function trashOrphanJsons(rels: unknown, lang: string): Promise<OrphanOutcome[]> {
  const now = new Set((await findOrphanJsons()).files.map((f) => f.rel))
  const list = Array.isArray(rels) ? rels.slice(0, 500) : []
  return list.map((x) => {
    const rel = String(x ?? '')
    if (!now.has(rel)) return { rel, ok: false, message: lang === 'en' ? 'This file is in use again or gone, so I left it.' : 'Ez a fájl újra használatban van, vagy már nincs meg, ezért nem nyúltam hozzá.' }
    const r = trashLife(rel, lang as any)
    return { rel, ok: r.ok, message: r.ok ? '' : r.message }
  })
}
