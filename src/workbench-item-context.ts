// A work item's CONTEXT FILE and the item-named JSON files (Boss TG 3125, 3127).
//
// 1. Every work item has a context md file NEXT TO IT (in the item's folder), named after the item:
//    "Kontextus - <item name>.md" ("Context - ..." on an English install). It gathers everything known about the
//    task, so the chat / AI sees the whole case at once. The agent keeps it growing by itself (context.append,
//    see workbench-agent/tools.ts); this module only guarantees the file EXISTS, carries the item's NAME, and holds
//    a machine-kept list of the materials (between markers, the agent never edits that part).
// 2. The item's own JSON files (.canvas.json, .deck.json) carry the item's name too.
// When the item is renamed, both follow (the registry paths are rewritten, nothing is overwritten).
// ONE context file per work item, whatever the language (Boss, Workbench chat 2026-10-15): a language version
// (doc.createVariant) is the same case as its original and has NO context file of its own. Every read, append,
// rewrite and sweep on a version goes to the ORIGINAL's file; nothing is ever made or written back for the version.
//
// Runs as a periodic pass (all creation paths, legacy items and fresh installs are covered the same way) and is
// kicked right after a Workbench write so a new item gets its file within seconds.

import { existsSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { getDb } from './db.js'
import { logger } from './logger.js'
import { ol } from './owner-lang.js'
import { getProject, listProjects, type ProjectRow } from './projects.js'
import { getWorkItem, listWorkItems, listWorkItemVersions, type WorkItemRow } from './workbench.js'
import { variantOf } from './workbench-doclang.js'
import { followDepotFolderMove, itemOutputFolder, isPlainItem, markPlainItem } from './workbench-assets.js'
// #717: the plain-item flag lives with the folder logic (ensureWorkItemFolder reads it); re-exported for the old callers.
export { isPlainItem, markPlainItem }
import { projectFileTarget, safeFileName } from './project-files.js'
import { writeBlockReason } from './git-guard.js'
import { resolveLifePath } from './life-explorer.js'
import { listMounts } from './life-mounts.js'
import { ensureItemTodoFile, isTodoFileName, todoFileText } from './workbench-item-todos.js'
import { listItemTodos } from './workbench-todos.js'
import { isDebateReportTitle } from './debate-report-title.js'

export const CONTEXT_PREFIX_HU = 'Kontextus'
export const CONTEXT_PREFIX_EN = 'Context'
const BLOCK_BEGIN = '<!-- marveen:files:begin -->'
const BLOCK_END = '<!-- marveen:files:end -->'
const INVENTORY_MAX = 60
const CONTEXT_MAX_CHARS = 120_000

const sleep0 = (): Promise<void> => new Promise((r) => setImmediate(r))

function ensureTable(): void {
  getDb().exec('CREATE TABLE IF NOT EXISTS work_item_context (item_id TEXT PRIMARY KEY, rel TEXT NOT NULL, stem TEXT NOT NULL DEFAULT \'\')')
}

/** "Kontextus - <name>.md": the name of the context file for an item title. */
export function contextFileName(title: string): string {
  const prefix = ol(CONTEXT_PREFIX_HU, CONTEXT_PREFIX_EN)
  const clean = (safeFileName(title) || 'munkadarab').replace(/\.md$/i, '').slice(0, 150)
  return `${prefix} - ${clean}.md`
}

/** Both language prefixes count when an existing context file is recognised. */
export function isContextFileName(name: string): boolean {
  return new RegExp(`^(?:${CONTEXT_PREFIX_HU}|${CONTEXT_PREFIX_EN}) - .+\\.md$`, 'i').test(name)
}

/** The item's name as a file-name stem: same rule as the drawing file names (`canvasFileName`). */
export function itemStem(title: unknown): string {
  const base = String(title ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48)
  return base || 'rajz'
}

/** A JSON file name that carries the item's name: `rajz.canvas.json` -> `<stem> rajz.canvas.json`. */
export function nameWithItemStem(title: unknown, fileName: string): string {
  const stem = itemStem(title)
  return fileName.toLowerCase().startsWith(stem) ? fileName : `${stem} ${fileName}`
}

const JSON_FILE = /\.(?:canvas|deck|timeline)(?: \(\d+\))?\.json$/i

/**
 * The work item whose context file serves `item`: the item itself, or -- for a language version -- its original.
 * A version is never itself an original (createVariant refuses it), the hop limit is only a guard against bad data.
 */
export function contextOwner(item: WorkItemRow): WorkItemRow {
  let cur = item
  for (let i = 0; i < 4; i++) {
    const v = variantOf(cur.id)
    if (!v) return cur
    const src = getWorkItem(v.source_item_id)
    if (!src) return cur
    cur = src
  }
  return cur
}


interface CtxRow { item_id: string; rel: string; stem: string }
const readRow = (itemId: string): CtxRow | undefined =>
  getDb().prepare('SELECT item_id, rel, stem FROM work_item_context WHERE item_id = ?').get(itemId) as CtxRow | undefined
const saveRow = (itemId: string, rel: string, stem: string): void => {
  getDb().prepare('INSERT INTO work_item_context (item_id, rel, stem) VALUES (?, ?, ?) ON CONFLICT(item_id) DO UPDATE SET rel = excluded.rel, stem = excluded.stem').run(itemId, rel, stem)
}

/**
 * #709: remember the name stem an item has NOW, before a rename. An item that never went through a context pass has no
 * stem on record, and without it the rename cannot tell `uj-video.timeline.json` (the old name) from a free word.
 */
export function rememberItemStem(item: WorkItemRow): void {
  ensureTable()
  const row = readRow(item.id)
  if (row && row.stem) return
  saveRow(item.id, row ? row.rel : '', itemStem(item.title))
}

function template(title: string): string {
  return [
    `# ${ol('Kontextus', 'Context')}: ${title}`,
    '',
    ol(
      '> Ezt a fájlt az AI vezeti. Ide gyűlik minden, amit a munkadarabról tudni kell, hogy a chat és az AI egyben lásson mindent. Ne töröld; új információ ide kerül.',
      '> The AI keeps this file. Everything worth knowing about this work item is gathered here, so the chat and the AI see the whole case at once. Do not delete it; new information goes here.',
    ),
    '',
    `## ${ol('Feladat', 'Task')}`,
    ol('(még nincs felismerve, az AI kitölti)', '(not recognised yet, the AI fills this in)'),
    '',
    BLOCK_BEGIN,
    BLOCK_END,
    '',
    `## ${ol('Összegyűjtött információk', 'Collected information')}`,
    '',
    `## ${ol('Döntések', 'Decisions')}`,
    '',
    `## ${ol('Nyitott kérdések', 'Open questions')}`,
    '',
    `## ${ol('Napló', 'Log')}`,
    '',
  ].join('\n')
}

/** Depot-relative folder of the item's context file, or null when the item has no usable folder. */
function itemDirRel(project: ProjectRow, item: WorkItemRow): { abs: string; rel: string } | null {
  const sub = itemOutputFolder(project, item, null)
  if (sub === null) return null
  const t = projectFileTarget(project, sub)
  return t.ok ? { abs: t.dirAbs, rel: t.dirRel } : null
}

/** Names of the materials around the item (two levels deep) and the folders attached to the project. */
function inventoryLines(project: ProjectRow, dirAbs: string, ownName: string, ownFolder: boolean): string[] {
  const lines: string[] = []
  const walk = (abs: string, prefix: string, depth: number): void => {
    let entries: import('node:fs').Dirent[]
    try { entries = readdirSync(abs, { withFileTypes: true }) } catch { return }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const e of entries) {
      if (lines.length >= INVENTORY_MAX) return
      if (e.name.startsWith('.') || e.name === 'marveen-item.json' || e.name === ownName || isTodoFileName(e.name)) continue
      if (e.isDirectory()) { if (depth < 2) walk(join(abs, e.name), `${prefix}${e.name}/`, depth + 1); continue }
      if (e.isFile()) lines.push(`- ${prefix}${e.name}`)
    }
  }
  // An item without its own folder shares it with others: listing the neighbours would be noise.
  if (ownFolder) walk(dirAbs, '', 1)
  const home = String(project.folder_path || '').replace(/^\/+|\/+$/g, '')
  const attached = home
    ? listMounts().filter((m) => m.rel.startsWith(home + '/') && !m.rel.slice(home.length + 1).includes('/'))
    : []
  for (const m of attached) lines.push(`- ${ol('Csatolt mappa', 'Attached folder')}: ${m.rel.slice(home.length + 1)} -> ${m.target}`)
  return lines
}

function blockText(lines: string[]): string {
  const head = `## ${ol('Anyagok (automatikus lista, ne szerkeszd)', 'Materials (automatic list, do not edit)')}`
  return [BLOCK_BEGIN, head, ...(lines.length ? lines : [ol('(még nincs fájl)', '(no file yet)')]), BLOCK_END].join('\n')
}

function withBlock(text: string, block: string): string {
  const a = text.indexOf(BLOCK_BEGIN)
  const b = text.indexOf(BLOCK_END)
  if (a >= 0 && b > a) return text.slice(0, a) + block + text.slice(b + BLOCK_END.length)
  return text.replace(/\s*$/, '') + '\n\n' + block + '\n'
}

/** Finds the context file an existing item already has (the chat may have made one by hand). */
function findExisting(item: WorkItemRow, dirAbs: string, dirRel: string): string | null {
  const cands: string[] = []
  if (item.source_path) cands.push(item.source_path)
  for (const v of listWorkItemVersions(item.id)) if (v.source_path) cands.push(v.source_path)
  for (const rel of cands) {
    if (isContextFileName(basename(rel)) && dirname(rel) === dirRel) {
      const abs = resolveLifePath(rel)
      if (abs && existsSync(abs)) return rel
    }
  }
  const expected = contextFileName(item.title)
  if (existsSync(join(dirAbs, expected))) return `${dirRel}/${expected}`
  return null
}

export interface ItemContextOutcome { rel: string | null; created: boolean; renamed: boolean }

/** Makes sure the item's context file exists in its folder and carries the item's current name. */
export function ensureItemContext(item: WorkItemRow, project: ProjectRow): ItemContextOutcome {
  ensureTable()
  // #656: a debate report is a finished output: no context file for it.
  if (isDebateReportTitle(item.title)) return { rel: null, created: false, renamed: false }
  const owner = contextOwner(item)
  if (owner.id !== item.id) {
    // A language version shares its original's file: never make one of its own.
    return ensureItemContext(owner, getProject(owner.project_id) ?? project)
  }
  const dir = itemDirRel(project, item)
  if (!dir) return { rel: null, created: false, renamed: false }
  const expected = contextFileName(item.title)
  const row = readRow(item.id)
  let rel = row && existsSync(resolveLifePath(row.rel) || '/nonexistent') ? row.rel : findExisting(item, dir.abs, dir.rel)
  let created = false
  let renamed = false
  if (rel && basename(rel) !== expected) {
    const oldAbs = resolveLifePath(rel)
    const folder = dirname(rel)
    const newAbs = oldAbs ? join(dirname(oldAbs), expected) : null
    if (oldAbs && newAbs && !existsSync(newAbs) && !writeBlockReason(`${folder}/${expected}`)) {
      try {
        renameSync(oldAbs, newAbs)
        const newRel = `${folder}/${expected}`
        followDepotFolderMove(rel, newRel)
        rel = newRel
        renamed = true
      } catch (err: any) {
        logger.warn({ item: item.id, err: String(err?.message || err) }, '[item-context] the context file could not follow the new item name')
      }
    }
  }
  if (!rel) {
    if (writeBlockReason(`${dir.rel}/${expected}`)) return { rel: null, created: false, renamed: false }
    const abs = join(dir.abs, expected)
    if (existsSync(abs)) { rel = `${dir.rel}/${expected}` } else {
      try { writeFileSync(abs, template(item.title), { flag: 'wx' }); rel = `${dir.rel}/${expected}`; created = true } catch (err: any) {
        logger.warn({ item: item.id, err: String(err?.message || err) }, '[item-context] the context file could not be created')
        return { rel: null, created: false, renamed: false }
      }
    }
  }
  saveRow(item.id, rel, itemStem(item.title))
  return { rel, created, renamed }
}

/** The machine-kept materials list inside the file: rewritten only when it changed. */
function refreshInventory(item: WorkItemRow, project: ProjectRow, rel: string): void {
  const abs = resolveLifePath(rel)
  const dir = itemDirRel(project, item)
  if (!abs || !dir) return
  let text: string
  try { text = readFileSync(abs, 'utf8') } catch { return }
  const ownFolder = !!String(item.folder ?? '').trim()
  const next = withBlock(text, blockText(inventoryLines(project, dir.abs, basename(abs), ownFolder)))
  if (next === text) return
  try { writeFileSync(abs, next) } catch { /* locked or read-only: the next pass tries again */ }
}

/** The item's .canvas.json / .deck.json files carry the item's name; a rename of the item renames them too. */
function followItemJsonNames(item: WorkItemRow, oldStem: string): number {
  const stem = itemStem(item.title)
  const rels = new Set<string>()
  if (item.source_path && JSON_FILE.test(item.source_path)) rels.add(item.source_path)
  for (const v of listWorkItemVersions(item.id)) if (v.source_path && JSON_FILE.test(v.source_path)) rels.add(v.source_path)
  let n = 0
  for (const rel of rels) {
    const base = basename(rel)
    const lower = base.toLowerCase()
    if (lower.startsWith(stem)) continue
    const rest = oldStem && oldStem !== stem && lower.startsWith(oldStem) ? base.slice(oldStem.length).replace(/^[\s_-]+/, '') : base
    // `uj-video.timeline.json` -> `<new>.timeline.json` (no space before the dot); `x rajz.canvas.json` keeps its word.
    const wanted = rest.startsWith('.') ? `${stem}${rest}` : `${stem} ${rest}`
    const folder = dirname(rel)
    const oldAbs = resolveLifePath(rel)
    if (!oldAbs || !existsSync(oldAbs) || writeBlockReason(`${folder}/${wanted}`)) continue
    const newAbs = join(dirname(oldAbs), wanted)
    if (existsSync(newAbs)) continue
    try {
      renameSync(oldAbs, newAbs)
      followDepotFolderMove(rel, `${folder}/${wanted}`)
      n++
    } catch (err: any) {
      logger.warn({ item: item.id, rel, err: String(err?.message || err) }, '[item-context] a JSON file could not follow the new item name')
    }
  }
  return n
}

/**
 * #590 follow-up (Boss TG 3241): the chat agent once ATTACHED the context file as the work item's file, so the tree and the
 * header showed "Kontextus - ...md" as the open document. The context file is the notes, never the item's file: put the
 * item back on its last real file (or none), and clear the pointer from the versions that carry it. Idempotent; no file moves.
 */
export function healContextAsSource(item: WorkItemRow): WorkItemRow {
  const isCtx = (p: string | null | undefined): boolean => !!p && (isContextFileName(basename(p)) || isTodoFileName(basename(p)))
  const db = getDb()
  const versions = listWorkItemVersions(item.id)
  const dirty = versions.filter((v) => isCtx(v.source_path))
  for (const v of dirty) db.prepare('UPDATE work_item_versions SET source_path = NULL WHERE id = ?').run(v.id)
  if (!isCtx(item.source_path)) return item
  const real = versions.filter((v) => v.source_path && !isCtx(v.source_path)).sort((a, b) => b.created_at - a.created_at)[0]
  db.prepare('UPDATE work_items SET source_path = ? WHERE id = ?').run(real ? real.source_path : null, item.id)
  logger.info({ item: item.id, to: real ? real.source_path : null }, '[item-context] the context file was the item file: put back')
  return { ...item, source_path: real ? real.source_path : null }
}

/** One item: context file, JSON names, materials list. */
export function reconcileItemContext(item: WorkItemRow, project: ProjectRow): { created: boolean; renamed: boolean; json: number } {
  ensureTable()
  if (isDebateReportTitle(item.title)) { removeReportScaffolding(item); return { created: false, renamed: false, json: 0 } }
  // #717: a plain item generates nothing; a context / to-do file made for it before it was marked goes away while it is
  // still exactly what the app generated (anything written into it keeps the file).
  if (isPlainItem(item.id)) { removeReportScaffolding(item); return { created: false, renamed: false, json: 0 } }
  item = healContextAsSource(item)
  const before = readRow(item.id)
  const oldStem = before?.stem || ''
  const json = followItemJsonNames(item, oldStem)
  if (contextOwner(item).id !== item.id) {
    // A language version: no file of its own (an empty path clears any old pointer); the original's pass keeps the
    // shared file. Only the name stem is tracked, so the version's JSON files still follow its rename.
    saveRow(item.id, '', itemStem(item.title))
    return { created: false, renamed: false, json }
  }
  const r = ensureItemContext(item, project)
  if (r.rel) refreshInventory(item, project, r.rel)
  // The to-do file lives beside the context file (Boss TG 3462); a failure there never stops the context pass.
  try { ensureItemTodoFile(item, project) } catch (err: any) { logger.warn({ item: item.id, err: String(err?.message || err) }, '[item-context] to-do file skipped') }
  return { created: r.created, renamed: r.renamed, json }
}

/**
 * #656: a debate report made before the fix may carry a generated "Kontextus - ...md" and "Teendő - ...md". They go away
 * ONLY while they are still exactly what the app generated (an untouched template, an empty to-do list): anything the
 * owner or the chat wrote into them keeps the file. Idempotent; runs in every context pass and does nothing once clean.
 */
export function removeReportScaffolding(item: WorkItemRow): number {
  ensureTable()
  const db = getDb()
  let removed = 0
  const ctx = readRow(item.id)
  if (ctx && ctx.rel) {
    const abs = resolveLifePath(ctx.rel)
    if (!abs || !existsSync(abs)) { db.prepare('DELETE FROM work_item_context WHERE item_id = ?').run(item.id) }
    else {
      let text = ''
      try { text = readFileSync(abs, 'utf8') } catch { /* unreadable: keep it */ }
      const plain = (t: string): string => withBlock(t, '').trim()
      if (text && plain(template(item.title)) === plain(text) && !writeBlockReason(ctx.rel)) {
        try { unlinkSync(abs); db.prepare('DELETE FROM work_item_context WHERE item_id = ?').run(item.id); removed++ } catch { /* retried at the next pass */ }
      }
    }
  }
  let todo: { rel: string } | undefined
  try { todo = db.prepare('SELECT rel FROM work_item_todo_file WHERE item_id = ?').get(item.id) as { rel: string } | undefined } catch { /* no table yet: nothing generated */ }
  if (todo && todo.rel) {
    const abs = resolveLifePath(todo.rel)
    if (!abs || !existsSync(abs)) db.prepare('DELETE FROM work_item_todo_file WHERE item_id = ?').run(item.id)
    else if (listItemTodos(item.id).length === 0) {
      let text = ''
      try { text = readFileSync(abs, 'utf8') } catch { /* unreadable: keep it */ }
      if (text && text === todoFileText(item.title, []) && !writeBlockReason(todo.rel)) {
        try { unlinkSync(abs); db.prepare('DELETE FROM work_item_todo_file WHERE item_id = ?').run(item.id); removed++ } catch { /* retried at the next pass */ }
      }
    }
  }
  if (removed) logger.info({ item: item.id, removed }, '[item-context] generated context / to-do file of a debate report removed')
  return removed
}

let running = false
/** Every item of every open project. Yields between items: the depot can sit on a slow mount. */
export async function sweepItemContexts(): Promise<{ items: number; created: number; renamed: number; json: number }> {
  const out = { items: 0, created: 0, renamed: 0, json: 0 }
  if (running) return out
  running = true
  try {
    for (const p of listProjects({ includeArchived: false })) {
      if (p.status === 'closed') continue
      const project = getProject(p.id)
      if (!project || !project.folder_path) continue
      for (const item of listWorkItems(project.id)) {
        try {
          const r = reconcileItemContext(item, project)
          out.items++
          if (r.created) out.created++
          if (r.renamed) out.renamed++
          out.json += r.json
        } catch (err: any) {
          logger.warn({ item: item.id, err: String(err?.message || err) }, '[item-context] item skipped')
        }
        await sleep0()
      }
    }
  } finally { running = false }
  if (out.created || out.renamed || out.json) logger.info(out, '[item-context] pass done')
  return out
}

let kick: ReturnType<typeof setTimeout> | null = null
/** After a Workbench write: a new / renamed item gets its file within seconds, not at the next pass. */
export function kickItemContextSweep(): void {
  if (kick || process.env['VITEST']) return
  kick = setTimeout(() => {
    kick = null
    void sweepItemContexts().catch(() => { /* the periodic pass catches up */ })
  }, 4000)
  kick.unref?.()
}

let timer: ReturnType<typeof setInterval> | null = null
export const ITEM_CONTEXT_MS = 120_000
export function startItemContexts(): void {
  if (timer) return
  setTimeout(() => { void sweepItemContexts().catch(() => { /* retried */ }) }, 20_000).unref?.()
  timer = setInterval(() => { void sweepItemContexts().catch(() => { /* retried */ }) }, ITEM_CONTEXT_MS)
  timer.unref?.()
}
export function stopItemContexts(): void { if (timer) { clearInterval(timer); timer = null } }

// ---- the agent's part ---------------------------------------------------------------------------------------

export type ContextSection = 'task' | 'info' | 'decisions' | 'open' | 'log'
const SECTION_TITLES: Record<ContextSection, [string, string]> = {
  task: ['Feladat', 'Task'], info: ['Összegyűjtött információk', 'Collected information'],
  decisions: ['Döntések', 'Decisions'], open: ['Nyitott kérdések', 'Open questions'], log: ['Napló', 'Log'],
}

export function isContextSection(s: unknown): s is ContextSection { return typeof s === 'string' && s in SECTION_TITLES }

export function readItemContext(item: WorkItemRow): { rel: string; text: string } | null {
  ensureTable()
  const row = readRow(contextOwner(item).id)
  if (!row || !row.rel) return null
  const abs = resolveLifePath(row.rel)
  if (!abs || !existsSync(abs)) return null
  try { return { rel: row.rel, text: readFileSync(abs, 'utf8') } } catch { return null }
}

export type AppendOutcome = { ok: true; rel: string } | { ok: false; code: 'no_context_file' | 'too_big' | 'write_failed' | 'empty' }

/** Adds text under a section of the context file (the section is made when the owner's file lacks it). */
export function appendItemContext(item: WorkItemRow, project: ProjectRow, section: ContextSection, text: string): AppendOutcome {
  const add = text.replace(/\s+$/, '').trim()
  if (!add) return { ok: false, code: 'empty' }
  const r = ensureItemContext(item, project)
  if (!r.rel) return { ok: false, code: 'no_context_file' }
  const abs = resolveLifePath(r.rel)
  if (!abs) return { ok: false, code: 'no_context_file' }
  let body: string
  try { body = readFileSync(abs, 'utf8') } catch { return { ok: false, code: 'no_context_file' } }
  const [hu, en] = SECTION_TITLES[section]
  const heading = `## ${ol(hu, en)}`
  // Either language's heading counts: an English file on a Hungarian install keeps its own section.
  const re = new RegExp(`^## (?:${hu}|${en})\\s*$`, 'm')
  const m = re.exec(body)
  let next: string
  if (!m) {
    next = body.replace(/\s*$/, '') + `\n\n${heading}\n${add}\n`
  } else {
    const start = m.index + m[0].length
    const after = body.slice(start)
    // The machine block (its own "## " heading inside) ends a section too: text put after BLOCK_BEGIN would be wiped by the next inventory refresh.
    const nx = /^## /m.exec(after)
    const bx = after.indexOf(BLOCK_BEGIN)
    const cuts = [nx ? nx.index : -1, bx].filter((n) => n >= 0)
    const end = cuts.length ? start + Math.min(...cuts) : body.length
    let sectionBody = body.slice(start, end).replace(/\s+$/, '')
    // The first real text replaces the template's "not recognised yet" placeholder.
    if (section === 'task') sectionBody = sectionBody.replace(/\n?\((?:még nincs felismerve, az AI kitölti|not recognised yet, the AI fills this in)\)/, '').replace(/\s+$/, '')
    const tail = body.slice(end)
    next = body.slice(0, start) + sectionBody + '\n' + add + '\n' + (tail ? '\n' + tail : '')
  }
  if (next.length > CONTEXT_MAX_CHARS) return { ok: false, code: 'too_big' }
  try { writeFileSync(abs, next) } catch { return { ok: false, code: 'write_failed' } }
  return { ok: true, rel: r.rel }
}

/** Replaces the whole human part of the file (the agent tidies it); the machine list is kept. */
export function rewriteItemContext(item: WorkItemRow, project: ProjectRow, markdown: string): AppendOutcome {
  const md = markdown.trim()
  if (!md) return { ok: false, code: 'empty' }
  if (md.length > CONTEXT_MAX_CHARS) return { ok: false, code: 'too_big' }
  const r = ensureItemContext(item, project)
  if (!r.rel) return { ok: false, code: 'no_context_file' }
  const abs = resolveLifePath(r.rel)
  if (!abs) return { ok: false, code: 'no_context_file' }
  let old = ''
  try { old = readFileSync(abs, 'utf8') } catch { return { ok: false, code: 'no_context_file' } }
  const a = old.indexOf(BLOCK_BEGIN)
  const b = old.indexOf(BLOCK_END)
  const block = a >= 0 && b > a ? old.slice(a, b + BLOCK_END.length) : blockText([])
  const clean = md.replace(BLOCK_BEGIN, '').replace(BLOCK_END, '')
  try { writeFileSync(abs, withBlock(clean + '\n', block)) } catch { return { ok: false, code: 'write_failed' } }
  return { ok: true, rel: r.rel }
}
