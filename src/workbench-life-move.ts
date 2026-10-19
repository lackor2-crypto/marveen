// #618 (Boss TG 3536, 3542): "move this work item's finished files into the Life tree". The owner sees a LIST (which
// file would go where), approves it, and only then do the files move. The work item keeps reaching each file: moveLife
// follows the item's file references (followMovedItemFileRefs), so what stays behind is a link, not a copy.
// #661: the list may carry a SUGGESTED target per file (the inbox sorter's rules: whose, which area, which case), but it
// is only a suggestion: nothing moves until the owner approves the list, and a row without a target is not moved.

import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { ProjectRow } from './projects.js'
import type { WorkItemRow } from './workbench.js'
import { projectFileTarget } from './project-files.js'
import { moveLife, toLifeRel, resolveLifePath } from './life-explorer.js'
import { analyzeInboxItem, buildLearnedIndex, prefetchItem, sniffType } from './life-inbox-analyze.js'
import { credentialRisk } from './life-inbox.js'
import { loadLifeConfig } from './life-tree.js'
import { isContextFileName } from './workbench-item-context.js'
import { isTodoFileName } from './workbench-item-todos.js'

/** Folders whose files are NOT candidates: versions are the item's history, "Agent" holds chat references for the agent only. */
const SKIP_FOLDERS = new Set(['verziók', 'versions', 'agent', 'agentnek', 'for the agent'])
/** #716 (Boss TG 10015): the uploads folder is a candidate too -- a file uploaded there must go to its place in the Life tree. */
const UPLOAD_FOLDERS = new Set(['feltöltések', 'uploads'])
const SKIP_FILES = new Set(['marveen-item.json', '.marveen-id'])
const MAX_CANDIDATES = 200

export interface LifeMoveCandidate {
  /** Life-tree relative path of the file (what moveLife takes). */
  rel: string
  name: string
  /** The subfolder name the file sits in; '' = the item's folder itself. */
  folder: string
  /** #716: the file sits in the item's uploads folder (an upload that has not been put in its place yet). */
  upload?: boolean
}

/** 'exclude' (default): the uploads folder is not listed; 'include': listed with the rest; 'only': ONLY the uploads. */
export type LifeMoveUploads = 'exclude' | 'include' | 'only'

export interface LifeMoveSuggestion {
  /** Life-tree relative target folder; '' = the sorter has no (existing) folder for this file. */
  suggested_target: string
  /** Human location of the suggestion (what the owner reads). */
  suggested_display: string
  /** true = owner and kind were recognised with enough certainty to pre-fill; false = shown as a hint only. */
  suggested_confident: boolean
}

const MAX_SUGGESTED = 60
const SUGGEST_BUDGET_MS = 20000

/**
 * One suggestion per candidate file, from the same rules the inbox sorter uses (owner by name/content, kind by
 * words). Only an EXISTING folder is ever suggested (nothing is created here), a file that looks like a credential
 * gets none, and the work stops at a time budget so a big folder never holds the dialog up. Never throws: a file
 * that cannot be read simply has no suggestion (a fresh install with an empty Life tree has none at all).
 */
export async function suggestLifeTargets(files: LifeMoveCandidate[], lang: string): Promise<Map<string, LifeMoveSuggestion>> {
  const out = new Map<string, LifeMoveSuggestion>()
  let config
  let index
  try { config = loadLifeConfig(); index = buildLearnedIndex(config) } catch { return out }
  if (!config.persons.length) return out
  const until = Date.now() + SUGGEST_BUDGET_MS
  for (const f of files.slice(0, MAX_SUGGESTED)) {
    if (Date.now() > until) break
    try {
      const abs = resolveLifePath(f.rel)
      if (!abs) continue
      const item = { name: f.name, rel: f.rel, isDir: false, size: 0, sizeHuman: '', mtime: '', credentialWarning: credentialRisk(f.name, lang) }
      const pre = item.credentialWarning ? undefined : await prefetchItem(sniffType(abs), abs)
      const s = analyzeInboxItem(item, config, index, lang, pre, abs)
      if (!s.targetRel || !s.targetExists) continue
      out.set(f.rel, { suggested_target: s.targetRel, suggested_display: s.targetDisplay, suggested_confident: !s.needsReview })
    } catch { /* no suggestion for this file */ }
  }
  return out
}

export function lifeMoveCandidates(project: ProjectRow, item: Pick<WorkItemRow, 'folder'>, uploads: LifeMoveUploads = 'exclude'): { ok: true; folder_rel: string; files: LifeMoveCandidate[] } | { ok: false; code: 'no_folder' } {
  const base = String(item.folder ?? '').trim()
  if (!base) return { ok: false, code: 'no_folder' }
  const t = projectFileTarget(project, base)
  if (!t.ok) return { ok: false, code: 'no_folder' }
  const files: LifeMoveCandidate[] = []
  const take = (dirAbs: string, folder: string, upload = false): void => {
    let names: string[] = []
    try { names = readdirSync(dirAbs) } catch { return }
    for (const name of names.sort((a, b) => a.localeCompare(b))) {
      if (files.length >= MAX_CANDIDATES) return
      if (name.startsWith('.') || SKIP_FILES.has(name) || isContextFileName(name) || isTodoFileName(name)) continue
      let st
      try { st = statSync(join(dirAbs, name)) } catch { continue }
      if (!st.isFile()) continue
      const rel = toLifeRel(join(dirAbs, name))
      if (rel) files.push({ rel, name, folder, ...(upload ? { upload: true } : {}) })
    }
  }
  if (uploads !== 'only') take(t.dirAbs, '')
  let subs: string[] = []
  try { subs = readdirSync(t.dirAbs) } catch { subs = [] }
  for (const sub of subs.sort((a, b) => a.localeCompare(b))) {
    const isUp = UPLOAD_FOLDERS.has(sub.toLowerCase())
    if (sub.startsWith('.') || SKIP_FOLDERS.has(sub.toLowerCase())) continue
    if (isUp ? uploads === 'exclude' : uploads === 'only') continue
    const abs = join(t.dirAbs, sub)
    try { if (!statSync(abs).isDirectory()) continue } catch { continue }
    take(abs, sub, isUp)
  }
  return { ok: true, folder_rel: t.dirRel, files }
}

export interface LifeMoveRow { rel: string; target: string }
export interface LifeMoveOutcome { rel: string; target: string; ok: boolean; new_rel: string; message: string }

/** The files that really moved, as old and new Life-tree path (for re-pointing what referred to the old place). */
export function movedPairs(results: LifeMoveOutcome[]): Array<{ oldRel: string; newRel: string }> {
  return results.filter((r) => r.ok && r.new_rel).map((r) => ({ oldRel: r.rel, newRel: r.new_rel }))
}

/**
 * Moves the approved rows. Only files that are CURRENT candidates of this item move (a rel the owner's list did not
 * contain is refused), and moveLife never overwrites: a name clash comes back as a message, not a silent rename.
 */
export function moveItemFilesToLife(project: ProjectRow, item: Pick<WorkItemRow, 'folder'>, rows: unknown, lang: string, uploads: LifeMoveUploads = 'exclude'): { ok: true; results: LifeMoveOutcome[] } | { ok: false; code: 'no_folder' | 'bad_input' } {
  const cands = lifeMoveCandidates(project, item, uploads)
  if (!cands.ok) return { ok: false, code: 'no_folder' }
  if (!Array.isArray(rows) || !rows.length || rows.length > MAX_CANDIDATES) return { ok: false, code: 'bad_input' }
  const allowed = new Set(cands.files.map((f) => f.rel))
  const results: LifeMoveOutcome[] = []
  for (const r of rows) {
    const rel = String((r as any)?.rel ?? '')
    const target = String((r as any)?.target ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    if (!rel || !target || !allowed.has(rel)) {
      results.push({ rel, target, ok: false, new_rel: '', message: lang === 'en' ? 'This file is not on the list (any more) or has no target.' : 'Ez a fájl nincs (már) a listán, vagy nincs célmappája.' })
      continue
    }
    const m = moveLife(rel, target, lang as any)
    results.push({ rel, target, ok: m.ok, new_rel: m.ok ? m.rel : '', message: m.ok ? '' : m.message })
  }
  return { ok: true, results }
}
