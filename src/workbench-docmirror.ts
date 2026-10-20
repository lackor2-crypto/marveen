// #455: a document work item lives in the database (outline: sections + blocks),
// so its folder in Windows Explorer used to stay empty. This keeps ONE real file
// next to it: the editable Word copy (.docx), or a Markdown copy when no Word
// converter is installed on this machine. It is refreshed whenever the outline
// changes (debounced), and the folder is created on the first write.
//
// The file is a MIRROR: the outline stays the source of truth. If the owner has
// edited the file by hand (its hash no longer matches what we wrote last), we
// leave it alone -- an edited copy is never overwritten.

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import { getDb } from './db.js'
import { getProject, type ProjectRow } from './projects.js'
import { projectFileTarget } from './project-files.js'
import { writeBlockReason } from './git-guard.js'
import { getWorkItem, type WorkItemRow } from './workbench.js'
import { ensureWorkItemFolder } from './workbench-assets.js'
import { documentOutline, imageBlockParts, isBlankLine, tableBlockParts } from './workbench-docmodel.js'
import { resolveLifePath } from './life-explorer.js'
import { fileStem, renderDocx } from './workbench-docfinal.js'
import { APP_LANG } from './config.js'
import { refreshMailDraft } from './workbench-maildraft.js'
import { isTextSourcePath } from './workbench-notefinal.js'
import { isWordImported } from './workbench-worddoc.js'

const DEBOUNCE_MS = 1500

export type MirrorResult =
  | { ok: true; file: string; format: 'docx' | 'md'; written: boolean }
  | { ok: false; code: 'no_item' | 'empty' | 'no_folder' | 'edited_by_owner' | 'write_failed'; detail?: string }

function ensureMirrorTable(): void {
  getDb().exec(`CREATE TABLE IF NOT EXISTS wb_doc_mirror (
    work_item_id TEXT PRIMARY KEY,
    file_name TEXT NOT NULL,
    sha TEXT NOT NULL,
    outline_sha TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL
  )`)
}

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex')

/** The outline's stored text, block by block: what a change is measured on (a resized picture or table counts). */
function outlineSource(item: WorkItemRow): string {
  const { sections } = documentOutline(item.id)
  const lines: string[] = [`# ${item.title}`, '']
  for (const s of sections) {
    lines.push(`## ${s.title}`, '')
    for (const b of s.blocks) lines.push(b.text, '')
  }
  return lines.join('\n')
}

/**
 * The outline as plain Markdown: the fallback when no Word converter exists. A picture block is a Markdown
 * picture (linked relative to `dir`, the folder the file is written to, when given), and a table loses its
 * size/alignment line (#508) -- `foto.jpg#w=50&a=l` is storage, not something the owner should read.
 */
export function outlineMarkdown(item: WorkItemRow, dir?: string): string {
  const { sections } = documentOutline(item.id)
  const lines: string[] = [`# ${item.title}`, '']
  for (const s of sections) {
    lines.push(`## ${s.title}`, '')
    for (const b of s.blocks) {
      if (b.kind === 'image') {
        const path = imageBlockParts(b.text).path
        const abs = dir ? resolveLifePath(path) : null
        const link = (abs ? relative(dir as string, abs) : path).replace(/\\/g, '/')
        lines.push(`![${basename(path)}](<${link}>)`, '')
      } else if (b.kind === 'table') lines.push(tableBlockParts(b.text).text, '')
      // #565: an empty line is an invisible character in the model; in Markdown it is a line of its own (a no-break space).
      // A list block: a bullet run is stored without its markers (put back as "- "), a numbered run keeps its "1." markers.
      else if (b.kind === 'list') lines.push(b.text.split('\n').map((l) => (/^\s*\d+[.)]\s+/.test(l) ? l : `- ${l}`)).join('\n'), '')
      else lines.push(isBlankLine(b.text) ? '&nbsp;' : b.text, '')
    }
  }
  return lines.join('\n')
}

// Boss, 2026-10-16: no PDF twin of the Word copy any more. The finished-documents folder holds ONLY finalized PDFs (an identical
// "twin" there was a duplicate nobody could tell from the final); the mail draft makes its own PDF.

/**
 * #673: a text-profile note mirrors into ITS OWN .md / .txt file (one file in the folder), not into a Word copy next to it.
 * #720: a Word file read onto the page mirrors into its own .docx the same way (`word`: the page is written as Word).
 */
function textMirrorTarget(item: WorkItemRow): { dirAbs: string; dirRel: string; name: string; word: boolean } | null {
  const text = item.type === 'note' && isTextSourcePath(item.source_path)
  const word = !text && item.type === 'document' && /\.docx$/i.test(String(item.source_path ?? '')) && isWordImported(item.id)
  if (!text && !word) return null
  const abs = resolveLifePath(item.source_path as string)
  if (!abs) return null
  return { dirAbs: dirname(abs), dirRel: dirname(item.source_path as string), name: basename(abs), word }
}

/**
 * #673: the page of a text-profile note was just built FROM its file, so the file already matches: record its hash as the one
 * "we wrote", which lets the mirror refresh it later and still recognise a hand edit made outside (`edited_by_owner`).
 * `outlineSha: ''` marks the outline as not yet written into the file (the next mirror run writes it).
 */
export function seedMirrorRow(item: WorkItemRow, opts: { outlineSha?: string } = {}): void {
  const t = textMirrorTarget(item)
  if (!t) return
  const abs = join(t.dirAbs, t.name)
  if (!existsSync(abs)) return
  ensureMirrorTable()
  const outlineSha = opts.outlineSha ?? sha(Buffer.from(outlineSource(item), 'utf-8'))
  getDb().prepare(`INSERT INTO wb_doc_mirror (work_item_id, file_name, sha, outline_sha, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(work_item_id) DO UPDATE SET file_name = excluded.file_name, sha = excluded.sha, outline_sha = excluded.outline_sha, updated_at = excluded.updated_at`)
    .run(item.id, t.name, sha(readFileSync(abs)), outlineSha, Date.now())
}

/** #673: true when the text file of a text-profile note was changed by hand outside the page (the mirror then leaves it alone). */
export function mirrorFileEdited(item: WorkItemRow): boolean {
  const t = textMirrorTarget(item)
  if (!t) return false
  const abs = join(t.dirAbs, t.name)
  if (!existsSync(abs)) return false
  ensureMirrorTable()
  const row = getDb().prepare('SELECT sha FROM wb_doc_mirror WHERE work_item_id = ?').get(item.id) as { sha: string } | undefined
  return !!row && row.sha !== sha(readFileSync(abs))
}

async function mirrorOutlineToFileCore(itemId: string): Promise<MirrorResult> {
  const item = getWorkItem(itemId)
  if (!item) return { ok: false, code: 'no_item' }
  if (documentOutline(item.id).sections.length === 0) return { ok: false, code: 'empty' }
  const project = getProject(item.project_id)
  if (!project) return { ok: false, code: 'no_item' }
  const own = textMirrorTarget(item)
  let t: { dirAbs: string; dirRel: string }
  if (own) t = own
  else {
    const folder = ensureWorkItemFolder(item)
    if (!folder.ok) return { ok: false, code: 'no_folder' }
    const ft = projectFileTarget(project, folder.folder)
    if (!ft.ok) return { ok: false, code: 'no_folder' }
    t = ft
  }

  ensureMirrorTable()
  const db = getDb()
  const row = db.prepare('SELECT file_name, sha, outline_sha FROM wb_doc_mirror WHERE work_item_id = ?').get(item.id) as { file_name: string; sha: string; outline_sha: string } | undefined
  const outlineSha = sha(Buffer.from(outlineSource(item), 'utf-8'))
  const existing = row ? join(t.dirAbs, row.file_name) : null
  if (row && existing && existsSync(existing) && row.outline_sha === outlineSha && sha(readFileSync(existing)) === row.sha) {
    return { ok: true, file: `${t.dirRel}/${row.file_name}`, format: row.file_name.endsWith('.docx') ? 'docx' : 'md', written: false }
  }

  let format: 'docx' | 'md' = 'docx'
  let data: Buffer
  const r = own && !own.word ? null : await renderDocx(item, APP_LANG === 'en' ? 'en' : 'hu')
  if (r && r.ok) data = r.docx
  else if (own?.word) return { ok: false, code: 'write_failed', detail: r && !r.ok ? String(r.detail ?? r.code) : 'docx render failed' }
  else {
    format = 'md'
    data = Buffer.from(outlineMarkdown(item, t.dirAbs), 'utf-8')
  }
  const name = own ? own.name : `${fileStem(item.title)}.${format}`
  const blocked = writeBlockReason(`${t.dirRel}/${name}`)
  if (blocked) return { ok: false, code: 'write_failed', detail: blocked }

  const abs = join(t.dirAbs, name)
  if (existsSync(abs)) {
    // Only a file we wrote and nobody touched since may be refreshed.
    const current = sha(readFileSync(abs))
    if (!row || row.file_name !== name || row.sha !== current) return { ok: false, code: 'edited_by_owner' }
  }
  try {
    writeFileSync(abs, data)
  } catch (e) {
    return { ok: false, code: 'write_failed', detail: e instanceof Error ? e.message : String(e) }
  }
  db.prepare(`INSERT INTO wb_doc_mirror (work_item_id, file_name, sha, outline_sha, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(work_item_id) DO UPDATE SET file_name = excluded.file_name, sha = excluded.sha, outline_sha = excluded.outline_sha, updated_at = excluded.updated_at`)
    .run(item.id, name, sha(data), outlineSha, Date.now())
  return { ok: true, file: `${t.dirRel}/${name}`, format, written: true }
}

/**
 * The Word copy (no PDF twin: #636 was withdrawn by Boss, see above), then (when the item has an e-mail draft made by Marveen) the draft's attachments:
 * the mail never carries an older PDF than the text. Every change of the document or of an annex comes through here.
 */
export async function mirrorOutlineToFile(itemId: string): Promise<MirrorResult> {
  const r = await mirrorOutlineToFileCore(itemId)
  const item = getWorkItem(itemId)
  if (item) await refreshMailDraft(item, APP_LANG === 'en' ? 'en' : 'hu')
  return r
}

const timers = new Map<string, NodeJS.Timeout>()

/**
 * Call after any outline change. Debounced per item, fire-and-forget: a failed
 * mirror must never break the edit that triggered it.
 */
export function scheduleOutlineMirror(itemId: string): void {
  const prev = timers.get(itemId)
  if (prev) clearTimeout(prev)
  const timer = setTimeout(() => {
    timers.delete(itemId)
    mirrorOutlineToFile(itemId).catch(() => { /* best effort */ })
  }, DEBOUNCE_MS)
  timer.unref?.()
  timers.set(itemId, timer)
}
