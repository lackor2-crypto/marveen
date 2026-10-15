// #625 (Boss TG 3564, 3567 "B"): finds drawing / deck JSON files that no work item uses any more, so the owner can
// clear them out. It NEVER deletes by itself: the owner sees the list and approves, and an approved file goes to the
// Trash (recoverable), not away. marveen-item.json is never a candidate: it is the work item's own backup.

import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { getDb } from './db.js'
import { listProjects } from './projects.js'
import { resolveLifePath, toLifeRel, trashLife } from './life-explorer.js'

const ORPHAN_NAME = /\.(canvas|deck)(?: \(\d+\))?\.json$/i
const MAX_ENTRIES = 20000
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

export function findOrphanJsons(): { files: OrphanJson[]; truncated: boolean } {
  const used = referencedPaths()
  const files: OrphanJson[] = []
  let seen = 0
  let truncated = false
  const walk = (abs: string, depth: number): void => {
    if (truncated || depth > MAX_DEPTH) return
    let names: string[] = []
    try { names = readdirSync(abs) } catch { return }
    for (const name of names) {
      if (++seen > MAX_ENTRIES) { truncated = true; return }
      if (name.startsWith('.')) continue
      const p = join(abs, name)
      let st
      try { st = statSync(p) } catch { continue }
      if (st.isDirectory()) { walk(p, depth + 1); continue }
      if (!st.isFile() || !ORPHAN_NAME.test(name)) continue
      const rel = toLifeRel(p)
      if (rel && !used.has(rel)) files.push({ rel, name, bytes: st.size })
    }
  }
  const done = new Set<string>()
  for (const pr of listProjects({ includeArchived: true })) {
    if (!pr.folder_path || done.has(pr.folder_path)) continue
    done.add(pr.folder_path)
    const abs = resolveLifePath(pr.folder_path)
    if (abs) walk(abs, 0)
  }
  return { files, truncated }
}

export interface OrphanOutcome { rel: string; ok: boolean; message: string }

/** Trashes the approved files, but only those that are orphans right now (the list may be stale). */
export function trashOrphanJsons(rels: unknown, lang: string): OrphanOutcome[] {
  const now = new Set(findOrphanJsons().files.map((f) => f.rel))
  const list = Array.isArray(rels) ? rels.slice(0, 500) : []
  return list.map((x) => {
    const rel = String(x ?? '')
    if (!now.has(rel)) return { rel, ok: false, message: lang === 'en' ? 'This file is in use again or gone, so I left it.' : 'Ez a fájl újra használatban van, vagy már nincs meg, ezért nem nyúltam hozzá.' }
    const r = trashLife(rel, lang as any)
    return { rel, ok: r.ok, message: r.ok ? '' : r.message }
  })
}
