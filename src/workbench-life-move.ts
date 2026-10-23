// #618 (Boss TG 3536, 3542): "move this work item's finished files into the Life tree". The owner sees a LIST (which
// file would go where), approves it, and only then do the files move. The work item keeps reaching each file: moveLife
// follows the item's file references (followMovedItemFileRefs), so what stays behind is a link, not a copy.
// #661: the list may carry a SUGGESTED target per file (the inbox sorter's rules: whose, which area, which case), but it
// is only a suggestion: nothing moves until the owner approves the list, and a row without a target is not moved.

import { existsSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { ProjectRow } from './projects.js'
import { getDb } from './db.js'
import { listWorkItems, type WorkItemRow } from './workbench.js'
import { projectFileTarget } from './project-files.js'
import { moveLife, toLifeRel, resolveLifePath, trashLife } from './life-explorer.js'
import { addMount, fileMountsInside, isFileMount, repointFileMount, resolveMount } from './life-mounts.js'
import { listFinals } from './workbench-docfinal.js'
import { sentStatus, type SentStatus } from './workbench-docsent.js'
import { roleOfFolderName } from './workbench-misplaced.js'
import { contextTarget } from './workbench-life-context.js'
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
/** #748: the item's own content JSON (drawing / deck): part of the work item itself, never something to move or trash. */
const OWN_CONTENT_JSON = /\.(canvas|deck)\.json$/i

export interface LifeMoveCandidate {
  /** Life-tree relative path of the file (what moveLife takes). */
  rel: string
  name: string
  /** The subfolder name the file sits in; '' = the item's folder itself. */
  folder: string
  /** #716: the file sits in the item's uploads folder (an upload that has not been put in its place yet). */
  upload?: boolean
  /** What the list does with it: 'move' = goes to the Life tree; 'trash' = an older generated version, goes to the Trash
   *  once the sent one is in the Life tree; 'blocked' = cannot be moved yet (see `note`). Set by lifeMovePlan. */
  action?: 'move' | 'trash' | 'blocked'
  /** 'this' = belongs to the open document; 'other' = to another work item of the same folder (listed apart). */
  group?: 'this' | 'other'
  item_id?: string
  item_title?: string
  /** This is the version that was really sent. */
  sent_final?: boolean
  /** Why it is blocked: 'not_sent' (the document has not been sent yet) | 'unknown_owner'. */
  note?: 'not_sent' | 'unknown_owner'
}

/** One work item's "was it sent?" answer, shown on top of the list (and the button that marks it by hand). */
export interface LifeMoveGate { item_id: string; title: string; sent: boolean; how: 'recorded' | 'manual' | null }

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
 * The learned index walks the WHOLE Life tree with a synchronous stat per file (up to 8000): measured 60+ s on the live
 * depot for every opening of the move list (#741). The tree changes slowly and the index only ranks suggestions, so it is
 * kept for ten minutes.
 */
const INDEX_TTL_MS = 10 * 60_000
let indexCache: { at: number; value: ReturnType<typeof buildLearnedIndex> } | null = null
function learnedIndexCached(config: Parameters<typeof buildLearnedIndex>[0]): ReturnType<typeof buildLearnedIndex> {
  if (indexCache && Date.now() - indexCache.at < INDEX_TTL_MS) return indexCache.value
  const value = buildLearnedIndex(config)
  indexCache = { at: Date.now(), value }
  return value
}
/** Tests only. */
export function _resetLearnedIndexCache(): void { indexCache = null }

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
  try { config = loadLifeConfig(); index = learnedIndexCached(config) } catch { return out }
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

/**
 * A work item made from a file ("put this file in as a work item, leave it where it is") has no folder of its own: its
 * files are the source file, the source files of its versions and its finished (attached) files. The same "move to the
 * Life tree" list offers those, so every document has the button, not only the ones with a folder. The item follows
 * each file that moves (followMovedItemFileRefs).
 */
function ownFileCandidate(item: Partial<Pick<WorkItemRow, 'id' | 'source_path'>>): { ok: true; folder_rel: string; files: LifeMoveCandidate[] } | { ok: false; code: 'no_folder' } {
  const rels: string[] = []
  const add = (raw: unknown): void => { if (typeof raw === 'string' && raw.trim()) rels.push(raw.replace(/\\/g, '/').replace(/^\/+/, '').trim()) }
  add(item.source_path)
  if (item.id) {
    try {
      const db = getDb()
      for (const r of db.prepare('SELECT source_path AS p FROM work_item_versions WHERE work_item_id = ? AND source_path IS NOT NULL').all(item.id) as { p: string }[]) add(r.p)
      for (const r of db.prepare('SELECT path AS p FROM work_item_assets WHERE work_item_id = ?').all(item.id) as { p: string }[]) add(r.p)
    } catch { /* a table that does not exist yet has nothing to offer */ }
  }
  const files: LifeMoveCandidate[] = []
  const seen = new Set<string>()
  for (const rel of rels) {
    if (seen.has(rel) || files.length >= MAX_CANDIDATES) continue
    seen.add(rel)
    const abs = resolveLifePath(rel)
    if (!abs) continue
    try { if (!statSync(abs).isFile()) continue } catch { continue }
    const name = basename(rel)
    if (name.startsWith('.') || SKIP_FILES.has(name) || isContextFileName(name) || isTodoFileName(name)) continue
    files.push({ rel, name, folder: '' })
  }
  if (!files.length) return { ok: false, code: 'no_folder' }
  return { ok: true, folder_rel: dirname(files[0].rel), files }
}

export function lifeMoveCandidates(project: ProjectRow, item: Pick<WorkItemRow, 'folder'> & Partial<Pick<WorkItemRow, 'id' | 'source_path' | 'container_folder' | 'title'>>, uploads: LifeMoveUploads = 'exclude'): { ok: true; folder_rel: string; files: LifeMoveCandidate[] } | { ok: false; code: 'no_folder' } {
  const own = String(item.folder ?? '').trim()
  // A document made from a file sits in a shared FOLDER of work items: the documents themselves stay where they are
  // (they ARE the work items); only the Uploads, Attachments and Finished materials subfolders hold files to move.
  const container = !own ? String((item as { container_folder?: string | null }).container_folder ?? '').trim() : ''
  const base = own || container
  if (!base) return uploads === 'only' ? { ok: false, code: 'no_folder' } : ownFileCandidate(item)
  const t = projectFileTarget(project, base)
  if (!t.ok) return container ? ownFileCandidate(item) : { ok: false, code: 'no_folder' }
  const files: LifeMoveCandidate[] = []
  // #748: the item's OWN files are never candidates -- the file it points to (source_path, its versions' source files)
  // can sit in any subfolder, Finished materials included, where it would otherwise be moved or sent to the Trash.
  const ownAbs = new Set<string>()
  const addOwn = (raw: unknown): void => {
    if (typeof raw !== 'string' || !raw.trim()) return
    const rel = raw.trim().replace(/\\/g, '/').replace(/^\/+/, '')
    // The stored path comes in two spellings: relative to the project folder (a fresh item) and relative to the Life
    // tree (once the item has been opened and its first version recorded). Both name the same file.
    for (const full of [project.folder_path ? `${project.folder_path}/${rel}` : '', rel]) {
      const abs = full ? resolveLifePath(full) : null
      if (abs) ownAbs.add(abs)
    }
  }
  addOwn(item.source_path)
  if (item.id) {
    try {
      for (const r of getDb().prepare('SELECT source_path AS p FROM work_item_versions WHERE work_item_id = ? AND source_path IS NOT NULL').all(item.id) as { p: string }[]) addOwn(r.p)
    } catch { /* no versions table yet: nothing else is the item's own file */ }
  }
  const take = (dirAbs: string, folder: string, upload = false): void => {
    let names: string[] = []
    try { names = readdirSync(dirAbs) } catch { return }
    for (const name of names.sort((a, b) => a.localeCompare(b))) {
      if (files.length >= MAX_CANDIDATES) return
      if (name.startsWith('.') || SKIP_FILES.has(name) || OWN_CONTENT_JSON.test(name) || isContextFileName(name) || isTodoFileName(name)) continue
      if (ownAbs.has(join(dirAbs, name))) continue
      let st
      try { st = statSync(join(dirAbs, name)) } catch { continue }
      if (!st.isFile()) continue
      const rel = toLifeRel(join(dirAbs, name))
      if (rel) files.push({ rel, name, folder, ...(upload ? { upload: true } : {}) })
    }
  }
  if (uploads !== 'only' && !container) take(t.dirAbs, '')
  let subs: string[] = []
  try { subs = readdirSync(t.dirAbs) } catch { subs = [] }
  for (const sub of subs.sort((a, b) => a.localeCompare(b))) {
    const isUp = UPLOAD_FOLDERS.has(sub.toLowerCase())
    if (sub.startsWith('.') || SKIP_FOLDERS.has(sub.toLowerCase())) continue
    if (container && !roleOfFolderName(sub)) continue
    if (container && (roleOfFolderName(sub) === 'agent' || roleOfFolderName(sub) === 'debate')) continue
    if (isUp ? uploads === 'exclude' : uploads === 'only') continue
    const abs = join(t.dirAbs, sub)
    try { if (!statSync(abs).isDirectory()) continue } catch { continue }
    take(abs, sub, isUp)
  }
  return { ok: true, folder_rel: t.dirRel, files }
}

export interface LifeMoveRow { rel: string; target: string }
export interface LifeMoveOutcome {
  rel: string; target: string; ok: boolean; new_rel: string; message: string; trashed?: boolean
  /** #749: the file moved; false = no linked file could be left at its old place (the owner is told), true = it stands there. */
  link_left?: boolean
}

/** The files that really moved, as old and new Life-tree path (for re-pointing what referred to the old place). */
export function movedPairs(results: LifeMoveOutcome[]): Array<{ oldRel: string; newRel: string }> {
  return results.filter((r) => r.ok && !r.trashed && r.new_rel).map((r) => ({ oldRel: r.rel, newRel: r.new_rel }))
}

type PlanItem = Pick<WorkItemRow, 'folder'> & Partial<Pick<WorkItemRow, 'id' | 'source_path' | 'container_folder' | 'title'>>
export type LifeMovePlan = { ok: true; folder_rel: string; files: LifeMoveCandidate[]; gates: LifeMoveGate[] } | { ok: false; code: 'no_folder' }

interface OwnerInfo { id: string; title: string; status: SentStatus; owned: Set<string>; finalNames: Set<string>; sentNames: Set<string> }

/** The work items that share the open document's folder (the document itself when it has a folder of its own). */
export function siblingsOf(project: ProjectRow, item: PlanItem): Array<{ id: string; title: string }> {
  const me = { id: String(item.id ?? ''), title: String(item.title ?? '') }
  const container = String(item.container_folder ?? '').trim()
  if (!container || String(item.folder ?? '').trim()) return me.id ? [me] : []
  const out = listWorkItems(project.id).filter((w) => String(w.container_folder ?? '').trim() === container).map((w) => ({ id: w.id, title: w.title }))
  return out.some((o) => o.id === me.id) ? out : [...out, me].filter((o) => o.id)
}

/** A sent file of this document already stands in the Life tree: a linked file of that name was left in a folder of `arr`,
 *  and the file it points to is still there (a broken link proves nothing: the remaining file must not go to the Trash). */
function sentAlreadyMoved(arr: LifeMoveCandidate[], sentNames: Set<string>): boolean {
  const dirs = new Set(arr.map((f) => dirname(f.rel)))
  const alive = (target: string): boolean => { try { const a = resolveLifePath(target); return !!a && existsSync(a) } catch { return false } }
  for (const d of dirs) {
    try { if (fileMountsInside(d).some((m) => sentNames.has(basename(m.rel)) && alive(m.target))) return true } catch { /* unreadable list: not proven */ }
  }
  return false
}

function ownerInfo(w: { id: string; title: string }): OwnerInfo {
  const status = sentStatus(w.id)
  const owned = new Set<string>()
  const sentNames = new Set<string>()
  const finals = listFinals(w.id)
  const namesOf = (f: (typeof finals)[number]): string[] => [f.pdf_name, basename(f.pdf_path || ''), ...(f.files || []).flatMap((x) => [x.name, basename(x.path || '')])].filter(Boolean)
  const finalNames = new Set<string>()
  for (const f of finals) for (const n of namesOf(f)) { owned.add(n); finalNames.add(n) }
  try {
    for (const r of getDb().prepare('SELECT path AS p, support AS s FROM work_item_assets WHERE work_item_id = ? AND removed_at IS NULL').all(w.id) as { p: string; s: string | null }[]) {
      owned.add(basename(r.p))
      if (r.s === 'final') finalNames.add(basename(r.p))
    }
  } catch { /* no assets table yet: nothing is owned that way */ }
  // The version that really went out: the recorded one, or (marked by hand) the newest final.
  const sentFinal = status.sent ? (finals.find((f) => f.version_id === status.version_id) || finals[0]) : undefined
  if (sentFinal) for (const n of namesOf(sentFinal)) sentNames.add(n)
  return { id: w.id, title: w.title, status, owned, finalNames, sentNames }
}

/**
 * The list the owner sees (Boss TG 4059-4068). Only a SENT document moves; of its generated files only the version that
 * was sent goes to the Life tree and the older ones go to the Trash (restorable) once it is there; the owner's own
 * uploads and attachments move too. The work items' own documents never appear: they stay in their folder.
 */
export function lifeMovePlan(project: ProjectRow, item: PlanItem, uploads: LifeMoveUploads = 'exclude'): LifeMovePlan {
  const base = lifeMoveCandidates(project, item, uploads)
  if (!base.ok) return base
  const sibs = siblingsOf(project, item)
  const infos = new Map<string, OwnerInfo>(sibs.map((w) => [w.id, ownerInfo(w)]))
  const me = String(item.id ?? '')
  const mine = infos.get(me)
  const mtimeOf = (rel: string): number => { try { const a = resolveLifePath(rel); return a ? statSync(a).mtimeMs : 0 } catch { return 0 } }

  // The generated files (Finished materials): who owns each, and which one was sent.
  const finishedBy = new Map<string, LifeMoveCandidate[]>()
  const files = base.files.map((f) => ({ ...f }))
  for (const f of files) {
    f.group = 'this'; f.item_id = me; f.item_title = String(item.title ?? '')
    const isFinished = !!f.folder && roleOfFolderName(f.folder.split('/').pop() || '') === 'finished'
    if (!isFinished) continue
    let owner = [...infos.values()].find((o) => o.owned.has(f.name))
    if (!owner && sibs.length === 1) owner = mine
    if (!owner) { f.action = 'blocked'; f.note = 'unknown_owner'; continue }
    f.item_id = owner.id; f.item_title = owner.title; f.group = owner.id === me ? 'this' : 'other'
    const arr = finishedBy.get(owner.id) || []
    arr.push(f)
    finishedBy.set(owner.id, arr)
  }
  for (const [id, arr] of finishedBy) {
    const o = infos.get(id) as OwnerInfo
    if (!o.status.sent) { for (const f of arr) { f.action = 'blocked'; f.note = 'not_sent' } continue }
    let sentRel = new Set(arr.filter((f) => o.sentNames.has(f.name)).map((f) => f.rel))
    // Marked as sent but no final on file (an old document): the newest generated file is the one that went out.
    // #742 (Boss TG 4159): the same when the recorded sent PDF is gone from the folder (deleted by hand) and did not move to
    // the Life tree either (no linked file stands for it): the newest remaining file is the document now, never the Trash.
    if (!sentRel.size && (!o.sentNames.size || !sentAlreadyMoved(arr, o.sentNames))) {
      // a final PDF before any other generated file (a draft preview is never "the one that went out"), then the newest
      const finalsLeft = arr.filter((f) => o.finalNames.has(f.name))
      const newest = [...(finalsLeft.length ? finalsLeft : arr)].sort((a, b) => mtimeOf(b.rel) - mtimeOf(a.rel))[0]
      if (newest) sentRel = new Set([newest.rel])
    }
    for (const f of arr) {
      if (sentRel.has(f.rel)) { f.action = 'move'; f.sent_final = true } else f.action = 'trash'
    }
  }
  // Everything else (uploads, attachments, a folder's own files) follows the open document's gate.
  for (const f of files) {
    if (f.action) continue
    f.action = uploads === 'only' || !mine || mine.status.sent ? 'move' : 'blocked'
    if (f.action === 'blocked') f.note = 'not_sent'
  }
  const gates: LifeMoveGate[] = []
  const wanted = new Set<string>([me, ...files.map((f) => f.item_id || '')])
  for (const [id, o] of infos) if (wanted.has(id) && id) gates.push({ item_id: id, title: o.title, sent: o.status.sent, how: o.status.how })
  return { ok: true, folder_rel: base.folder_rel, files, gates }
}

/**
 * One suggestion per file to MOVE. A generated (outgoing) file is placed by where the document lives and who it is
 * addressed to (contextTarget): the person in the folder name, the authority and its office. The owner's own incoming
 * files keep the content-based guess when it is confident, and fall back to the context when it is not. The place is
 * pre-filled even when unsure; `suggested_confident: false` is what the page shows in red (Boss: 3B).
 */
export async function suggestForPlan(project: ProjectRow, item: PlanItem, files: LifeMoveCandidate[], lang: string): Promise<Map<string, LifeMoveSuggestion & { suggested_why?: string }>> {
  // A blocked file (document not sent yet) gets its suggestion too, so the owner can see where it WOULD go.
  const movable = files.filter((f) => f.action !== 'trash')
  const content = await suggestLifeTargets(movable, lang)
  const out = new Map<string, LifeMoveSuggestion & { suggested_why?: string }>()
  const titleOf = new Map<string, string>()
  for (const f of movable) {
    const ownerTitle = f.item_title || String(item.title ?? '')
    titleOf.set(f.rel, ownerTitle)
    const c = content.get(f.rel)
    const outgoing = !!f.sent_final
    if (c && c.suggested_confident && !outgoing) { out.set(f.rel, c); continue }
    const ctx = contextTarget(project, { title: ownerTitle, folder: item.folder, container_folder: item.container_folder }, f.name, lang)
    if (ctx) out.set(f.rel, { suggested_target: ctx.target, suggested_display: ctx.display, suggested_confident: ctx.confident, suggested_why: ctx.why })
    else if (c) out.set(f.rel, c)
  }
  return out
}

/**
 * A linked file (a pointer, no copy) at the place the file was moved from. True when the link stands there and leads to the
 * file; false when it could not be made (the move itself is done, the caller says so).
 * #749: the file may have gone BEHIND a linked folder (Drive, Photos ...): `newRel` is the path the owner sees, a link
 * needs the REAL place (depot-relative), so the path is resolved through the folder link first.
 */
function leaveLinkBehind(oldRel: string, newRel: string, name: string): boolean {
  try {
    const target = resolveMount(newRel)?.target ?? newRel
    // #746: an older link already stands at this place (the file moved away before, and a new one with the same name was
    // put here since): it now leads to the file that left last. Its own copy in the Life tree is not touched.
    if (isFileMount(oldRel)) return repointFileMount(oldRel, target)
    return addMount({ rel: oldRel, target, kind: 'local', label: name, note: 'Left behind when the file was moved to the Life tree.', file: true }).ok
  } catch { return false }
}

/**
 * Moves the approved rows. Only files that are CURRENT 'move' candidates of this plan move (a rel the owner's list did
 * not contain is refused), and moveLife never overwrites: a name clash comes back as a message, not a silent rename.
 * When the sent version of a document is in the Life tree, its older generated files go to the Trash (restorable).
 */
export function moveItemFilesToLife(project: ProjectRow, item: PlanItem, rows: unknown, lang: string, uploads: LifeMoveUploads = 'exclude'): { ok: true; results: LifeMoveOutcome[] } | { ok: false; code: 'no_folder' | 'bad_input' } {
  const plan = lifeMovePlan(project, item, uploads)
  if (!plan.ok) return { ok: false, code: 'no_folder' }
  const trashable = plan.files.filter((f) => f.action === 'trash')
  if (!Array.isArray(rows) || rows.length > MAX_CANDIDATES || (!rows.length && !trashable.length)) return { ok: false, code: 'bad_input' }
  const byRel = new Map(plan.files.map((f) => [f.rel, f]))
  const results: LifeMoveOutcome[] = []
  const sentMoved = new Set<string>()
  for (const r of rows) {
    const rel = String((r as any)?.rel ?? '')
    const target = String((r as any)?.target ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    const cand = byRel.get(rel)
    if (!rel || !target || !cand || cand.action !== 'move') {
      const blocked = cand && cand.action === 'blocked'
      results.push({ rel, target, ok: false, new_rel: '', message: blocked
        ? (lang === 'en' ? 'This document has not been sent yet, so its files stay where they are.' : 'Ez az irat még nincs elküldve, ezért a fájljai maradnak a helyükön.')
        : (lang === 'en' ? 'This file is not on the list (any more) or has no target.' : 'Ez a fájl nincs (már) a listán, vagy nincs célmappája.') })
      continue
    }
    const m = moveLife(rel, target, lang as any)
    const out: LifeMoveOutcome = { rel, target, ok: m.ok, new_rel: m.ok ? m.rel : '', message: m.ok ? '' : m.message }
    results.push(out)
    // #741 (Boss TG 4147): the file moved away, but its old place must not go empty: a linked file (#601) stays there.
    if (m.ok) out.link_left = leaveLinkBehind(rel, m.rel, cand.name)
    if (m.ok && cand.sent_final && cand.item_id) sentMoved.add(cand.item_id)
  }
  // The older generated versions of a document whose SENT version now stands in the Life tree.
  const sentStillHere = new Set(plan.files.filter((f) => f.sent_final && f.item_id).map((f) => f.item_id as string))
  for (const f of trashable) {
    const id = f.item_id || ''
    if (!sentMoved.has(id) && sentStillHere.has(id)) continue
    const t = trashLife(f.rel, lang as any)
    results.push({ rel: f.rel, target: '', ok: t.ok, new_rel: t.ok ? t.rel : '', message: t.ok ? '' : t.message, trashed: true })
  }
  return { ok: true, results }
}
