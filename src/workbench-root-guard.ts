// #624 (Boss TG 3548, 3551, 3556): the root of a work item's folder holds only the item's own files (its JSON, the
// Context and To do files, the working document) and its subfolders. A NEW file that lands there anyway (copied in
// from the file manager, or uploaded) is not blocked and not silently moved: the owner is asked "is this the
// triggering document we are answering?". Yes = it stays where it is (and is never asked about again); no = it goes
// to the Uploads subfolder. Until the owner answers, the file does not move. There is no separate folder for it.
//
// A folder is baselined the first time it is checked: what is already in the root then counts as approved, so an
// older work item does not greet the owner with a wall of questions.

import { readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { getDb } from './db.js'
import type { ProjectRow } from './projects.js'
import type { WorkItemRow } from './workbench.js'
import { projectFileTarget } from './project-files.js'
import { ensureItemUploadsFolder } from './workbench-assets.js'
import { moveLife } from './life-explorer.js'
import { isContextFileName } from './workbench-item-context.js'
import { isTodoFileName } from './workbench-item-todos.js'

function ensureTable(): void {
  getDb().exec('CREATE TABLE IF NOT EXISTS work_item_root_seen (item_id TEXT NOT NULL, name TEXT NOT NULL, PRIMARY KEY (item_id, name))')
}

/** Names that are the item's own: they never raise a question. */
function isOwnName(name: string, own: Set<string>): boolean {
  return name.startsWith('.') || name.startsWith('~$') || name === 'marveen-item.json' || own.has(name)
    || isContextFileName(name) || isTodoFileName(name) || /\.(canvas|deck)\.json$/i.test(name)
    || /\.(tmp|part|crdownload)$/i.test(name)
}

function ownFileNames(item: WorkItemRow): Set<string> {
  const own = new Set<string>()
  const add = (p: unknown): void => { const s = String(p ?? '').trim(); if (s) own.add(basename(s.replace(/\\/g, '/'))) }
  add((item as any).source_path)
  try {
    for (const r of getDb().prepare('SELECT source_path FROM work_item_versions WHERE work_item_id = ?').all(item.id) as { source_path: string | null }[]) add(r.source_path)
  } catch { /* no versions table yet: nothing is the item's own */ }
  return own
}

function rootFiles(project: ProjectRow, item: WorkItemRow): { dirAbs: string; dirRel: string; names: string[] } | null {
  const base = String(item.folder ?? '').trim()
  if (!base) return null
  const t = projectFileTarget(project, base)
  if (!t.ok) return null
  let names: string[] = []
  try { names = readdirSync(t.dirAbs) } catch { return null }
  const files = names.filter((n) => { try { return statSync(join(t.dirAbs, n)).isFile() } catch { return false } })
  return { dirAbs: t.dirAbs, dirRel: t.dirRel, names: files }
}

export interface RootStray { name: string }

export function rootStrays(project: ProjectRow, item: WorkItemRow): RootStray[] {
  ensureTable()
  const r = rootFiles(project, item)
  if (!r) return []
  const db = getDb()
  const seen = new Set((db.prepare('SELECT name FROM work_item_root_seen WHERE item_id = ?').all(item.id) as { name: string }[]).map((x) => x.name))
  const own = ownFileNames(item)
  if (!seen.size && !db.prepare("SELECT 1 FROM work_item_root_seen WHERE item_id = ? AND name = ''").get(item.id)) {
    // First look at this folder: what is there is approved; the '' row marks "baselined" even for an empty folder.
    const ins = db.prepare('INSERT OR IGNORE INTO work_item_root_seen (item_id, name) VALUES (?, ?)')
    ins.run(item.id, '')
    for (const n of r.names) ins.run(item.id, n)
    return []
  }
  return r.names.filter((n) => !seen.has(n) && !isOwnName(n, own)).map((name) => ({ name }))
}

export interface RootDecision { name: string; keep: boolean }
export interface RootOutcome { name: string; ok: boolean; kept: boolean; message: string }

export function resolveRootStrays(project: ProjectRow, item: WorkItemRow, decisions: unknown, lang: string): { ok: true; results: RootOutcome[] } | { ok: false; code: 'no_folder' | 'bad_input' } {
  ensureTable()
  const r = rootFiles(project, item)
  if (!r) return { ok: false, code: 'no_folder' }
  if (!Array.isArray(decisions) || !decisions.length || decisions.length > 200) return { ok: false, code: 'bad_input' }
  // Only files that are real questions right now can be decided on.
  const open = new Set(rootStrays(project, item).map((s) => s.name))
  const results: RootOutcome[] = []
  const ins = getDb().prepare('INSERT OR IGNORE INTO work_item_root_seen (item_id, name) VALUES (?, ?)')
  for (const d of decisions) {
    const name = String((d as any)?.name ?? '')
    const keep = (d as any)?.keep === true
    if (!open.has(name)) {
      results.push({ name, ok: false, kept: false, message: lang === 'en' ? 'This file is no longer waiting for a decision.' : 'Erre a fájlra már nem vár döntés.' })
      continue
    }
    if (keep) { ins.run(item.id, name); results.push({ name, ok: true, kept: true, message: '' }); continue }
    const up = ensureItemUploadsFolder(item, lang)
    const upT = up.ok ? projectFileTarget(project, up.folder) : null
    if (!up.ok || !upT || !upT.ok) { results.push({ name, ok: false, kept: false, message: lang === 'en' ? 'The Uploads folder could not be made.' : 'A Feltöltések mappát nem sikerült létrehozni.' }); continue }
    const m = moveLife(`${r.dirRel}/${name}`, upT.dirRel, lang as any)
    results.push({ name, ok: m.ok, kept: false, message: m.ok ? '' : m.message })
  }
  return { ok: true, results }
}
