/**
 * THE TEXT PROFILE OF THE DOCUMENT PAGE (kanban #673, Boss TG 9339/9346/9349).
 *
 * A note (.md / .txt) used to have a surface of its own. Boss wants the SAME page as the court document -- the same code, with
 * the court-only parts hidden -- so a note is read into the document's outline (sections + blocks) and the page edits THAT.
 * The note's own file stays next to it as a mirror (`workbench-docmirror.ts` writes the outline back into the very same file),
 * which is why the owner still sees one real .md file in the folder.
 *
 * Nothing is lost on the way in: the file is first copied into a NEW version (the old file is untouched, it is the previous
 * version in the version bar), and the outline is built from the text. Unknown Markdown lines stay as paragraph text.
 * A language version made as a sibling note by the translation view (#671) is carried over to the document's OWN language
 * version (same `wb_doc_variants` row, its sections linked to the original's by position).
 */
import { readFileSync } from 'node:fs'
import { APP_LANG } from './config.js'
import { resolveLifePath } from './life-explorer.js'
import { getProject } from './projects.js'
import {
  BLANK_LINE, BLOCK_TEXT_MAX, PLACEHOLDER_SECTION_TITLES, SECTION_TITLE_MAX, addSection, documentOutline, hasDocModel, listSections, replacePage,
  type PageSectionIn,
} from './workbench-docmodel.js'
import { sectionHash, translateSection, variantOf, listVariants, ensureDocLangTables } from './workbench-doclang.js'
import { outlineMarkdown, seedMirrorRow } from './workbench-docmirror.js'
import { saveTextSourceAsNewVersion } from './workbench-edit.js'
import { isTextSourcePath } from './workbench-notefinal.js'
import { getDb } from './db.js'
import { getWorkItem, type WorkItemRow } from './workbench.js'
import { isWordImported, isWordProfileCandidate } from './workbench-worddoc.js'

export type TextDocCode = 'textdoc_not_text' | 'textdoc_unreadable' | 'textdoc_project_gone' | 'textdoc_save_failed' | 'textdoc_import_failed'

export type TextImportOutcome =
  | { ok: true; item: WorkItemRow; imported: boolean }
  | { ok: false; code: TextDocCode; detail: string | null }

const HEADING_RE = /^(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/
const BULLET_LINE_RE = /^\s*[-*+]\s+/
const NUMBERED_LINE_RE = /^\s*\d+[.)]\s+/

/** The title a section gets when the text before the first heading (or an empty file) needs one: the page draws none for it. */
function placeholderTitle(): string {
  return APP_LANG === 'en' ? PLACEHOLDER_SECTION_TITLES[1] : PLACEHOLDER_SECTION_TITLES[0]
}

/** Splits an over-long paragraph at line ends (then at the limit): the model keeps a block at BLOCK_TEXT_MAX characters. */
function chunk(text: string): string[] {
  if (text.length <= BLOCK_TEXT_MAX) return [text]
  const out: string[] = []
  let cur = ''
  for (const line of text.split('\n')) {
    if (cur && cur.length + line.length + 1 > BLOCK_TEXT_MAX) { out.push(cur); cur = '' }
    cur = cur ? `${cur}\n${line}` : line
    while (cur.length > BLOCK_TEXT_MAX) { out.push(cur.slice(0, BLOCK_TEXT_MAX)); cur = cur.slice(BLOCK_TEXT_MAX) }
  }
  if (cur) out.push(cur)
  return out
}

/**
 * The Markdown / plain text as the page's sections. A heading line (any level) starts a section; paragraphs are blocks, a run
 * of list lines is one list block; the `# title` line the mirror writes first is the item's own title and is not a section.
 * What is not recognised is kept as paragraph text, so no content can vanish.
 */
export function parseTextToPage(rawText: string, title: string): PageSectionIn[] {
  const lines = String(rawText ?? '').replace(/\r\n?/g, '\n').split('\n')
  const sections: { title: string; blocks: { kind: string; text: string }[] }[] = []
  let cur: { title: string; blocks: { kind: string; text: string }[] } | null = null
  let para: string[] = []
  const flush = (): void => {
    if (!para.length) return
    const text = para.join('\n').replace(/\s+$/, '')
    para = []
    if (!text.trim()) return
    if (!cur) { cur = { title: placeholderTitle(), blocks: [] }; sections.push(cur) }
    // The page's list block holds its lines (a bullet run without the marker: the page draws the bullet; a numbered run keeps its
    // "1." markers, the page shows them as a numbered list), so both round-trip through the file.
    const ls = text.split('\n')
    if (ls.every((l) => NUMBERED_LINE_RE.test(l))) {
      for (const c of chunk(text)) cur.blocks.push({ kind: 'list', text: c })
    } else if (ls.every((l) => BULLET_LINE_RE.test(l))) {
      for (const c of chunk(ls.map((l) => l.replace(BULLET_LINE_RE, '')).join('\n'))) cur.blocks.push({ kind: 'list', text: c })
    } else for (const c of chunk(text)) cur.blocks.push({ kind: 'paragraph', text: c })
  }
  for (const line of lines) {
    const h = HEADING_RE.exec(line)
    if (h) {
      flush()
      const heading = (h[2] || '').trim().slice(0, SECTION_TITLE_MAX)
      // The first level-1 heading that repeats the item's title is the title line, not a chapter.
      if (!sections.length && !cur && h[1].length === 1 && heading.toLowerCase() === String(title || '').trim().toLowerCase()) continue
      cur = { title: heading || placeholderTitle(), blocks: [] }
      sections.push(cur)
      continue
    }
    if (line.trim() === '&nbsp;') {
      flush()
      if (!cur) { cur = { title: placeholderTitle(), blocks: [] }; sections.push(cur) }
      cur.blocks.push({ kind: 'paragraph', text: BLANK_LINE })
      continue
    }
    if (!line.trim()) { flush(); continue }
    para.push(line)
  }
  flush()
  return sections as PageSectionIn[]
}

/** Is this the note-with-a-file kind that takes the text profile of the document page. */
export function isTextProfileCandidate(item: Pick<WorkItemRow, 'type' | 'source_path' | 'deleted_at'>): boolean {
  return item.type === 'note' && !item.deleted_at && isTextSourcePath(item.source_path)
}

/** The text profile is ON for an item that has the page's outline: a note read into it, or a language version of such a note. */
export function textProfileOf(item: Pick<WorkItemRow, 'id' | 'type' | 'source_path' | 'deleted_at'>): boolean {
  if (!hasDocModel(item.id)) return false
  // #720: a Word file read onto the page takes the same profile (no court-only parts).
  const own = (it: Pick<WorkItemRow, 'id' | 'type' | 'source_path' | 'deleted_at'>): boolean => isTextProfileCandidate(it) || (isWordProfileCandidate(it) && isWordImported(it.id))
  if (own(item)) return true
  ensureDocLangTables()
  const v = variantOf(item.id)
  if (!v) return false
  const src = getWorkItem(v.source_item_id)
  return !!src && own(src)
}

function readSourceText(item: WorkItemRow): { ok: true; text: string } | { ok: false; code: TextDocCode } {
  if (!item.source_path) return { ok: false, code: 'textdoc_unreadable' }
  const abs = resolveLifePath(item.source_path)
  if (!abs) return { ok: false, code: 'textdoc_unreadable' }
  try {
    return { ok: true, text: readFileSync(abs, 'utf-8') }
  } catch {
    return { ok: false, code: 'textdoc_unreadable' }
  }
}

/** Reads the item's text file into a fresh outline (a placeholder chapter when the file is empty). Returns the item as it is after. */
function buildOutlineFromFile(item: WorkItemRow, by: string | null): TextImportOutcome {
  const read = readSourceText(item)
  if (!read.ok) return { ok: false, code: read.code, detail: null }
  const project = getProject(item.project_id)
  if (!project || project.archived_at != null) return { ok: false, code: 'textdoc_project_gone', detail: null }
  // The file becomes a NEW version (a copy); the old file stays where it was, as the previous version.
  const saved = saveTextSourceAsNewVersion(item, project, item.source_path as string, read.text, { created_by: by })
  if (!saved.ok) return { ok: false, code: 'textdoc_save_failed', detail: saved.code }
  const page = parseTextToPage(read.text, item.title)
  if (!page.length) {
    const s = addSection(item.id, placeholderTitle(), {})
    if (!s.ok) return { ok: false, code: 'textdoc_import_failed', detail: s.detail }
  } else {
    const r = replacePage(item.id, page, [], 'owner')
    if (!r.ok) return { ok: false, code: 'textdoc_import_failed', detail: r.detail }
  }
  const fresh = getWorkItem(item.id) ?? saved.item
  seedMirrorRow(fresh)
  return { ok: true, item: fresh, imported: true }
}

/**
 * Reads a note into the document page's outline (once: an item that has an outline is left alone), then carries its sibling
 * language versions over. Safe to call on every open.
 */
export function importTextToOutline(item: WorkItemRow, by: string | null): TextImportOutcome {
  if (!isTextProfileCandidate(item)) return { ok: false, code: 'textdoc_not_text', detail: null }
  if (hasDocModel(item.id)) return { ok: true, item, imported: false }
  const out = buildOutlineFromFile(item, by)
  if (!out.ok) return out
  carryVariantsOver(out.item, by)
  return out
}

/**
 * The language versions the translation view (#671) saved as sibling notes: each is read into its own outline (see
 * adoptVariantText). Nothing is deleted: the sibling's file (kept as the previous version) and the row stay.
 */
function carryVariantsOver(source: WorkItemRow, by: string | null): void {
  ensureDocLangTables()
  for (const v of listVariants(source.id)) {
    const vi = getWorkItem(v.work_item_id)
    if (!vi || vi.deleted_at || !isTextProfileCandidate(vi) || hasDocModel(vi.id)) continue
    const read = readSourceText(vi)
    const project = getProject(vi.project_id)
    if (!read.ok || !project || project.archived_at != null) continue
    const saved = saveTextSourceAsNewVersion(vi, project, vi.source_path as string, read.text, { created_by: by })
    if (!saved.ok) continue
    adoptVariantText(source, saved.item, read.text, by)
  }
}

/**
 * The text of a language version (a sibling note) put into its own outline, its sections linked to the original's by position:
 * one to one when the chapter counts match (current); where they differ the text is kept whole (extra chapters are folded into
 * the last paired one) and the link is marked stale, so the page asks for a check instead of claiming it is up to date.
 * Called on the first read-in of a note and whenever the translation view / finalize panel saves a version of a text-profile note.
 */
export function adoptVariantText(source: WorkItemRow, variant: WorkItemRow, text: string, by: string | null): void {
  ensureDocLangTables()
  const srcSections = listSections(source.id)
  const page = parseTextToPage(text, variant.title)
  if (!page.length || !srcSections.length) {
    // Nothing to pair with: the variant gets a plain outline and stays an unlinked language version.
    if (!hasDocModel(variant.id)) {
      if (page.length) replacePage(variant.id, page, [], 'owner')
      else addSection(variant.id, placeholderTitle(), {})
    }
    seedMirrorRow(getWorkItem(variant.id) ?? variant)
    return
  }
  const counts = page.length === srcSections.length
  const paired = srcSections.map((s, i) => {
    const own = i < page.length ? page[i] : null
    if (!own) return { s, title: '', blocks: [] as { kind: string; text: string }[] }
    const blocks = ((own.blocks as { kind: string; text: string }[]) || []).slice()
    // More variant chapters than original ones: the rest is folded into the last pair, nothing is dropped.
    if (i === srcSections.length - 1) for (const extra of page.slice(i + 1)) {
      blocks.push({ kind: 'paragraph', text: String(extra.title ?? '') }, ...((extra.blocks as { kind: string; text: string }[]) || []))
    }
    return { s, title: String(own.title ?? s.title) || s.title, blocks }
  })
  for (const p of paired) {
    if (!p.title) continue
    translateSection(variant.id, { source_section: p.s.id, title: p.title, blocks: p.blocks }, by)
  }
  if (!counts) {
    getDb().prepare("UPDATE wb_doc_section_links SET source_hash = ? WHERE work_item_id = ? AND source_hash != ''").run('carried-over-check', variant.id)
  }
  seedMirrorRow(getWorkItem(variant.id) ?? variant)
}

/** The text of the item's outline as Markdown: what the finalize PDF is made of (the file can be a moment behind the page). */
export function outlineTextOf(item: WorkItemRow): string | null {
  if (!hasDocModel(item.id)) return null
  if (!documentOutline(item.id).sections.length) return null
  return outlineMarkdown(item)
}

/** Re-reads the item's own text file into the outline (the owner edited the file by hand, outside the page). Keeps the outline as a version first. */
export function reimportTextFromFile(item: WorkItemRow, by: string | null): TextImportOutcome {
  if (!isTextProfileCandidate(item)) return { ok: false, code: 'textdoc_not_text', detail: null }
  const read = readSourceText(item)
  if (!read.ok) return { ok: false, code: read.code, detail: null }
  const project = getProject(item.project_id)
  if (!project || project.archived_at != null) return { ok: false, code: 'textdoc_project_gone', detail: null }
  const hadOutline = hasDocModel(item.id)
  let cur = item
  if (hadOutline) {
    // What the page held until now is kept as its own version (a file), so the owner can go back to it.
    const keep = saveTextSourceAsNewVersion(cur, project, cur.source_path as string, outlineMarkdown(cur), { created_by: by })
    if (!keep.ok) return { ok: false, code: 'textdoc_save_failed', detail: keep.code }
    cur = keep.item
  }
  const known = hadOutline ? documentOutline(item.id).sections.flatMap((s) => [s.id, ...s.blocks.map((b) => b.id)]) : []
  const page = parseTextToPage(read.text, item.title)
  const r = page.length ? replacePage(item.id, page, known, 'owner') : { ok: true as const }
  if (!r.ok) return { ok: false, code: 'textdoc_import_failed', detail: r.detail }
  const fresh = getWorkItem(item.id) ?? cur
  // The file on disk is the hand-edited text until the next mirror run replaces it with the page: mark it as ours so it may.
  seedMirrorRow(fresh, { outlineSha: '' })
  return { ok: true, item: fresh, imported: true }
}
